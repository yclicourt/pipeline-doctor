import { readFileSync, existsSync } from "node:fs";
import { join, relative, sep, basename, dirname } from "node:path";
import {
  collectImageReferences,
  ciBuiltRepositories,
  isShaOrShaExpression,
  isLatestTag,
  isDockerfileName,
  type ImageRef,
} from "./images.js";
import { collectSecretFiles } from "./secrets.js";
import {
  isGitRepo,
  getHeadSha,
  getWorkingTreeStatus,
  getRemoteOrigin,
  parseGitHubRepo,
} from "../git.js";
import { missingVarsReason, type DeployEnv } from "../env.js";
import { apiGet, REQUEST_TIMEOUT_MS } from "../http.js";
import { getHarborArtifact } from "../harbor.js";
import type { Finding, SkippedCheck } from "../types.js";

/**
 * CI family (0.2.0, Fase 1).
 *
 * Verifies that what CI built is what should deploy — the trust chain
 * between the commit, the image and the registry:
 *
 *   CI-01 image tag is a SHA ............ the built image must be
 *     tagged with the commit SHA, never a moving tag
 *   CI-02 digest matches Harbor ......... a digest pinned in git
 *     matches the digest Harbor stores for that artifact
 *   CI-03 no `latest` anywhere .......... no image reference uses
 *     the `latest` tag (or no tag, which Docker reads as latest)
 *   CI-04 commit is HEAD, tree clean .... the audited code is the
 *     committed HEAD with no uncommitted changes
 *   CI-05 OWASP Docker Top 10 ........... non-root USER, HEALTHCHECK,
 *     COPY over ADD, apt hygiene, .dockerignore
 *   CI-06 OWASP security headers ........ the app serves the OWASP
 *     recommended security headers
 *   CI-07 last CI run all-green ......... the latest completed run
 *     on the default branch concluded "success"
 *
 * Network policy (same spirit as the OSV client in v1): missing
 * credentials → the check is skipped with the missing variable named;
 * an unreachable API or a 5xx/429 → the run fails loudly (exit 2),
 * never a silent pass; a 4xx from the API → skipped with the status
 * named (the token cannot see that resource).
 */

export interface CiCheckResult {
  findings: Finding[];
  skipped: SkippedCheck[];
}

export interface CiCheckOptions {
  env: DeployEnv;
  /** Injectable for tests — production passes the global fetch. */
  fetchFn?: typeof fetch;
}

function toPosixRelative(targetDir: string, absolutePath: string): string {
  return relative(targetDir, absolutePath).split(sep).join("/");
}

function errorFinding(
  rule: string,
  file: string,
  line: number,
  detail: string,
  fix: string,
): Finding {
  return { rule, severity: "error", file, line, detail, fix };
}

function warningFinding(
  rule: string,
  file: string,
  line: number,
  detail: string,
  fix: string,
): Finding {
  return { rule, severity: "warning", file, line, detail, fix };
}

/* --- CI-01: image tag is a SHA -------------------------------------- */

function checkTagIsSha(
  refs: ImageRef[],
  findings: Finding[],
  skipped: SkippedCheck[],
): void {
  const built = ciBuiltRepositories(refs);
  let checked = 0;
  for (const ref of refs) {
    if (ref.source === "workflow-tags") {
      checked++;
      if (ref.digest !== undefined || isShaOrShaExpression(ref)) continue;
      findings.push(
        errorFinding(
          "ci/unpinned-image-tag",
          ref.file,
          ref.line,
          `image ${ref.raw} is tagged "${ref.tag ?? "(no tag)"}" — the built image must be tagged with the commit SHA`,
          "tag it with ${{ github.sha }}",
        ),
      );
    } else if (
      ref.source === "manifest" &&
      built.has(ref.repository) &&
      ref.digest === undefined
    ) {
      // Only the images CI builds are held to the SHA rule in
      // manifests: a third-party image (postgres:alpine) is not
      // something CI tags, and CI-03 still catches `latest` in it.
      checked++;
      if (isShaOrShaExpression(ref)) continue;
      findings.push(
        errorFinding(
          "ci/unpinned-image-tag",
          ref.file,
          ref.line,
          `deployed image ${ref.repository} is tagged "${ref.tag ?? "(no tag)"}" — CI builds it, so the manifest must carry the commit SHA`,
          "let the workflow set the tag to ${{ github.sha }}",
        ),
      );
    }
  }
  if (checked === 0) {
    skipped.push({
      rule: "ci/unpinned-image-tag",
      reason: "no images built in workflows",
    });
  }
}

/* --- CI-02: digest matches Harbor ------------------------------------ */

function harborHost(harborUrl: string): string {
  return new URL(harborUrl).host;
}

async function checkDigestMatchesHarbor(
  refs: ImageRef[],
  env: DeployEnv,
  fetchFn: typeof fetch,
  findings: Finding[],
  skipped: SkippedCheck[],
): Promise<void> {
  const digestRefs = refs.filter((ref) => ref.digest !== undefined);
  if (digestRefs.length === 0) {
    skipped.push({
      rule: "ci/digest-mismatch-harbor",
      reason: "no digest-pinned images in repo",
    });
    return;
  }
  if (
    env.harborUrl === undefined ||
    env.harborUser === undefined ||
    env.harborToken === undefined
  ) {
    skipped.push({
      rule: "ci/digest-mismatch-harbor",
      reason: missingVarsReason("harbor"),
    });
    return;
  }
  const host = harborHost(env.harborUrl);
  const harborRefs = digestRefs.filter(
    (ref) => ref.registry === undefined || ref.registry === host,
  );
  if (harborRefs.length === 0) {
    skipped.push({
      rule: "ci/digest-mismatch-harbor",
      reason: "no digest-pinned images on Harbor",
    });
    return;
  }
  for (const ref of harborRefs) {
    const result = await getHarborArtifact(
      env,
      ref.repository,
      ref.digest as string,
      fetchFn,
    );
    if (!result.ok) {
      if (result.status === 404) {
        findings.push(
          errorFinding(
            "ci/digest-mismatch-harbor",
            ref.file,
            ref.line,
            `image ${ref.repository}@${ref.digest} is pinned in git but not found in Harbor`,
            "push the image to Harbor or fix the pinned digest",
          ),
        );
        continue;
      }
      skipped.push({
        rule: "ci/digest-mismatch-harbor",
        reason: `Harbor API returned HTTP ${result.status} for ${ref.repository}`,
      });
      continue;
    }
    if (result.artifact.digest !== ref.digest) {
      findings.push(
        errorFinding(
          "ci/digest-mismatch-harbor",
          ref.file,
          ref.line,
          `Harbor stores ${ref.repository} at ${result.artifact.digest}, but git pins ${ref.digest}`,
          `update the pinned digest to ${result.artifact.digest}`,
        ),
      );
    }
  }
}

/* --- CI-03: no `latest` anywhere -------------------------------------- */

function checkNoLatest(refs: ImageRef[], findings: Finding[]): void {
  for (const ref of refs) {
    // An expression with no literal tag resolves to something
    // unknown — flagging it as `latest` would be guessing.
    if (ref.isExpression && ref.tag === undefined) continue;
    if (!isLatestTag(ref)) continue;
    findings.push(
      errorFinding(
        "ci/latest-tag",
        ref.file,
        ref.line,
        `image ${ref.raw} uses the "latest" tag${ref.tag === undefined ? " (no tag means latest)" : ""} — latest moves, the deploy is not reproducible`,
        "pin an explicit tag, preferably the commit SHA",
      ),
    );
  }
}

/* --- CI-04: commit is HEAD, tree clean -------------------------------- */

function checkTreeClean(targetDir: string, findings: Finding[], skipped: SkippedCheck[]): void {
  if (!isGitRepo(targetDir)) {
    skipped.push({
      rule: "ci/dirty-tree",
      reason: "not a git repository",
    });
    return;
  }
  const head = getHeadSha(targetDir);
  if (head === null) {
    skipped.push({
      rule: "ci/dirty-tree",
      reason: "no commit yet",
    });
    return;
  }
  const status = getWorkingTreeStatus(targetDir);
  if (status === null) {
    skipped.push({
      rule: "ci/dirty-tree",
      reason: "git could not read the working tree",
    });
    return;
  }
  if (status.length > 0) {
    const shown = status.slice(0, 3).join(", ");
    const more = status.length > 3 ? ` (+${status.length - 3} more)` : "";
    findings.push(
      errorFinding(
        "ci/dirty-tree",
        ".",
        1,
        `${status.length} uncommitted change(s) — the audited code is not the committed HEAD (${shown}${more})`,
        "commit or stash the changes, then re-run",
      ),
    );
  }
}

/* --- CI-05: OWASP Docker Top 10 --------------------------------------- */

interface DockerfileInfo {
  file: string;
  content: string;
}

function collectDockerfiles(targetDir: string): DockerfileInfo[] {
  const out: DockerfileInfo[] = [];
  for (const file of collectSecretFiles(targetDir)) {
    if (!isDockerfileName(basename(file))) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    out.push({ file: toPosixRelative(targetDir, file), content });
  }
  return out;
}

/** Joins backslash continuations so a multi-line RUN is one string. */
function joinContinuations(content: string): string[] {
  const lines = content.split("\n");
  const joined: string[] = [];
  let current = "";
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.endsWith("\\")) {
      current += trimmed.slice(0, -1) + " ";
    } else {
      current += line;
      joined.push(current);
      current = "";
    }
  }
  if (current !== "") joined.push(current);
  return joined;
}

function checkDockerfiles(
  targetDir: string,
  findings: Finding[],
  skipped: SkippedCheck[],
): void {
  const dockerfiles = collectDockerfiles(targetDir);
  if (dockerfiles.length === 0) {
    skipped.push({
      rule: "ci/docker-no-user",
      reason: "no Dockerfile found",
    });
    return;
  }
  for (const { file, content } of dockerfiles) {
    const instructions = joinContinuations(content);
    const lineOf = (needle: RegExp): number => {
      for (let i = 0; i < instructions.length; i++) {
        if (needle.test(instructions[i])) return i + 1;
      }
      return 1;
    };

    // USER: only the last stage matters — a builder stage may
    // legitimately run as root while the final stage must not.
    const fromIndexes = instructions
      .map((text, i) => ({ text, i }))
      .filter(({ text }) => /^\s*FROM\s+/i.test(text))
      .map(({ i }) => i);
    const lastStageStart =
      fromIndexes.length > 0 ? fromIndexes[fromIndexes.length - 1] : 0;
    const lastStage = instructions.slice(lastStageStart);
    const userLines = lastStage.filter((text) => /^\s*USER\s+/i.test(text));
    if (userLines.length === 0) {
      findings.push(
        errorFinding(
          "ci/docker-no-user",
          file,
          lineOf(/^\s*FROM\s+/i),
          "no USER instruction — the container runs as root",
          "add a non-root USER (e.g. USER app) in the final stage",
        ),
      );
    } else {
      const lastUser = userLines[userLines.length - 1];
      const userValue = lastUser.replace(/^\s*USER\s+/i, "").trim();
      if (userValue === "root" || userValue === "0" || userValue === "0:0") {
        findings.push(
          errorFinding(
            "ci/docker-no-user",
            file,
            lineOf(/^\s*USER\s+/i),
            `container runs as USER ${userValue}`,
            "run as a non-root user in the final stage",
          ),
        );
      }
    }

    if (!instructions.some((text) => /^\s*HEALTHCHECK\s+/i.test(text))) {
      findings.push(
        warningFinding(
          "ci/docker-no-healthcheck",
          file,
          1,
          "no HEALTHCHECK — a broken app keeps receiving traffic",
          "add a HEALTHCHECK that hits the app's health endpoint",
        ),
      );
    }

    const addLine = instructions.findIndex((text) =>
      /^\s*ADD\s+/i.test(text),
    );
    if (addLine !== -1) {
      findings.push(
        warningFinding(
          "ci/docker-add",
          file,
          addLine + 1,
          "ADD copies files (and can fetch remote URLs or unpack archives) — COPY is explicit",
          "use COPY instead of ADD",
        ),
      );
    }

    instructions.forEach((text, index) => {
      if (!/^\s*RUN\b/i.test(text) || !text.includes("apt-get")) return;
      const hasNoRecommends = text.includes("--no-install-recommends");
      const cleansLists =
        text.includes("rm -rf /var/lib/apt/lists") ||
        (text.includes("type=cache") && text.includes("/var/lib/apt/lists"));
      if (text.includes("apt-get install") && !hasNoRecommends) {
        findings.push(
          warningFinding(
            "ci/docker-apt",
            file,
            index + 1,
            "apt-get install without --no-install-recommends — extra packages bloat the image",
            "add --no-install-recommends to apt-get install",
          ),
        );
      } else if (text.includes("apt-get update") && !cleansLists) {
        findings.push(
          warningFinding(
            "ci/docker-apt",
            file,
            index + 1,
            "apt-get update without cleaning /var/lib/apt/lists — the lists stay in the image layer",
            "append 'rm -rf /var/lib/apt/lists/*' (or a BuildKit cache mount for it)",
          ),
        );
      }
    });

    const dir = dirname(join(targetDir, file));
    const hasDockerignore =
      existsSync(join(dir, ".dockerignore")) ||
      existsSync(join(targetDir, ".dockerignore"));
    if (!hasDockerignore) {
      findings.push(
        warningFinding(
          "ci/docker-no-dockerignore",
          file,
          1,
          "no .dockerignore — the build context may include secrets or junk",
          "add a .dockerignore next to the Dockerfile",
        ),
      );
    }
  }
}

/* --- CI-06: OWASP security headers ------------------------------------ */

const SECURITY_HEADERS: { name: string; fix: string }[] = [
  {
    name: "Strict-Transport-Security",
    fix: 'serve "Strict-Transport-Security: max-age=31536000; includeSubDomains"',
  },
  {
    name: "Content-Security-Policy",
    fix: "serve a Content-Security-Policy header for the app",
  },
  {
    name: "X-Content-Type-Options",
    fix: 'serve "X-Content-Type-Options: nosniff"',
  },
  {
    name: "X-Frame-Options",
    fix: 'serve "X-Frame-Options: DENY" (or SAMEORIGIN when the app frames itself)',
  },
  {
    name: "Referrer-Policy",
    fix: 'serve "Referrer-Policy: no-referrer" (or strict-origin-when-cross-origin)',
  },
  {
    name: "Permissions-Policy",
    fix: "serve a Permissions-Policy header disabling unused features",
  },
];

async function checkSecurityHeaders(
  env: DeployEnv,
  fetchFn: typeof fetch,
  findings: Finding[],
  skipped: SkippedCheck[],
): Promise<void> {
  if (env.appUrl === undefined) {
    skipped.push({
      rule: "ci/missing-security-header",
      reason: "missing PIPELINE_DOCTOR_APP_URL",
    });
    return;
  }
  let response: Response;
  try {
    response = await fetchFn(env.appUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The app not answering is DEP-05's finding — CI-06 cannot run
    // without a response, so it is skipped, not double-reported.
    skipped.push({
      rule: "ci/missing-security-header",
      reason: "app unreachable (see DEP-05)",
    });
    return;
  }
  for (const header of SECURITY_HEADERS) {
    if (response.headers.get(header.name) === null) {
      findings.push(
        warningFinding(
          "ci/missing-security-header",
          env.appUrl,
          1,
          `missing header ${header.name}`,
          header.fix,
        ),
      );
    }
  }
}

/* --- CI-07: last CI run all-green -------------------------------------- */

interface GitHubRun {
  conclusion: string | null;
  html_url: string;
  head_branch: string;
}

async function checkLastRunGreen(
  targetDir: string,
  env: DeployEnv,
  fetchFn: typeof fetch,
  findings: Finding[],
  skipped: SkippedCheck[],
): Promise<void> {
  if (env.githubToken === undefined) {
    skipped.push({
      rule: "ci/last-run-not-green",
      reason: "missing GITHUB_TOKEN",
    });
    return;
  }
  const repo = parseGitHubRepo(getRemoteOrigin(targetDir));
  if (repo === null) {
    skipped.push({
      rule: "ci/last-run-not-green",
      reason: "not a GitHub repository (or no origin remote)",
    });
    return;
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.githubToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const repoRes = await apiGet(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}`,
    { headers },
    fetchFn,
  );
  if (repoRes.status !== 200) {
    skipped.push({
      rule: "ci/last-run-not-green",
      reason: `GitHub API returned HTTP ${repoRes.status} for ${repo.owner}/${repo.repo}`,
    });
    return;
  }
  let repoBody: unknown;
  try {
    repoBody = JSON.parse(repoRes.text) as unknown;
  } catch {
    throw new Error("GitHub API returned a non-JSON response");
  }
  const defaultBranch =
    repoBody !== null &&
    typeof repoBody === "object" &&
    "default_branch" in repoBody &&
    typeof (repoBody as { default_branch?: unknown }).default_branch ===
      "string"
      ? (repoBody as { default_branch: string }).default_branch
      : "main";
  const runsRes = await apiGet(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/runs` +
      `?status=completed&per_page=1&branch=${encodeURIComponent(defaultBranch)}`,
    { headers },
    fetchFn,
  );
  if (runsRes.status !== 200) {
    skipped.push({
      rule: "ci/last-run-not-green",
      reason: `GitHub API returned HTTP ${runsRes.status} for the actions runs`,
    });
    return;
  }
  let runsBody: unknown;
  try {
    runsBody = JSON.parse(runsRes.text) as unknown;
  } catch {
    throw new Error("GitHub API returned a non-JSON response");
  }
  const runs =
    runsBody !== null &&
    typeof runsBody === "object" &&
    "workflow_runs" in runsBody &&
    Array.isArray((runsBody as { workflow_runs?: unknown }).workflow_runs)
      ? ((runsBody as { workflow_runs: GitHubRun[] }).workflow_runs)
      : [];
  if (runs.length === 0) {
    skipped.push({
      rule: "ci/last-run-not-green",
      reason: "no completed runs yet",
    });
    return;
  }
  const latest = runs[0];
  if (latest.conclusion === "success") return;
  const detail =
    `latest completed run on ${defaultBranch} concluded ` +
    `"${latest.conclusion ?? "unknown"}" — ${latest.html_url}`;
  if (
    latest.conclusion === "failure" ||
    latest.conclusion === "timed_out" ||
    latest.conclusion === "action_required"
  ) {
    findings.push(
      errorFinding(
        "ci/last-run-not-green",
        ".github/workflows",
        1,
        detail,
        "fix the failing workflow and re-run",
      ),
    );
  } else {
    findings.push(
      warningFinding(
        "ci/last-run-not-green",
        ".github/workflows",
        1,
        detail,
        "check whether the run needs attention",
      ),
    );
  }
}

/* --- entry point -------------------------------------------------------- */

export async function checkCi(
  targetDir: string,
  options: CiCheckOptions,
): Promise<CiCheckResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const findings: Finding[] = [];
  const skipped: SkippedCheck[] = [];

  const refs = collectImageReferences(targetDir);
  checkTagIsSha(refs, findings, skipped);
  await checkDigestMatchesHarbor(refs, options.env, fetchFn, findings, skipped);
  checkNoLatest(refs, findings);
  checkTreeClean(targetDir, findings, skipped);
  checkDockerfiles(targetDir, findings, skipped);
  await checkSecurityHeaders(options.env, fetchFn, findings, skipped);
  await checkLastRunGreen(targetDir, options.env, fetchFn, findings, skipped);

  return { findings, skipped };
}
