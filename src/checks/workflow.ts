import type { Finding } from "../types.js";
import { adaptGitHub } from "../ci/github.js";
import type {
  CiJob,
  CiPipeline,
  CiStep,
} from "../ci/model.js";

/**
 * Workflow-security rules (spec §3A), running on the common CI model
 * (0.2.0, Fase B). Each rule is a pure function of the pipeline, so
 * it can be unit-tested with minimal inline YAML per CI.
 *
 * GitHub behavior is unchanged from v1 — the old text-based entry
 * point survives below as a thin wrapper over the GitHub adapter, and
 * the existing tests exercise it. The GitLab mappings:
 * - unpinned-action: an image/service ref without a digest, or a
 *   remote `include:` (no ref mechanism exists for it), or a project
 *   `include:` without `ref:`. A project include WITH a ref counts
 *   as pinned — a tag ref is how GitLab users pin includes, and
 *   flagging it would flood real pipelines. Local/template includes
 *   are never flagged (in-repo / pinned by GitLab).
 * - template-injection: GitLab has no `${{ }}` interpolation; the
 *   equivalent is expanding a variable that carries untrusted user
 *   content in `script:` (MR title/description, commit message,
 *   source branch). Ordinary variables ($CI_JOB_ID, $MY_VAR) are
 *   NOT flagged — expanding variables is normal GitLab practice.
 * - excessive-permissions / persist-credentials / pull-request-target
 *   / untrusted-input-in-run: no YAML-distinguishable GitLab
 *   equivalent. Job-token scopes live in project settings, not in
 *   the YAML; MR pipelines run on MR code by design; trigger-time
 *   variables cannot be told apart from project variables in the
 *   YAML. These rules simply do not fire on GitLab.
 *
 * Choices kept from v1 (simplest reading):
 * - workflow/excessive-permissions flags `permissions: write-all` only.
 * - workflow/persist-credentials flags a checkout step that keeps
 *   credentials (explicit `persist-credentials: true`, or the default,
 *   which IS true) in a job where no step pushes or publishes anything.
 * - Line numbers come from the YAML AST node ranges, not from a
 *   text search, so they stay right even with odd formatting.
 */

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const TEMPLATE_INJECTION_RE = /\$\{\{\s*github\.event\.[^}]*\}\}/;

const WORKFLOW_DISPATCH_INPUT_RE =
  /\$\{\{\s*(inputs\.|github\.event\.inputs\.)[^}]*\}\}/;

const ISSUE_COMMENT_INPUT_RE =
  /\$\{\{\s*github\.event\.(comment|issue)\.[^}]*\}\}/;

/** GitLab predefined variables that can carry attacker-controlled content. */
const GITLAB_UNTRUSTED_VARS = [
  "CI_MERGE_REQUEST_TITLE",
  "CI_MERGE_REQUEST_DESCRIPTION",
  "CI_COMMIT_MESSAGE",
  "CI_COMMIT_TITLE",
  "CI_COMMIT_DESCRIPTION",
  "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME",
];

const GITLAB_UNTRUSTED_VAR_RE = new RegExp(
  `\\$(?:${GITLAB_UNTRUSTED_VARS.join("|")})\\b|` +
    `\\$\\{(?:${GITLAB_UNTRUSTED_VARS.join("|")})\\}`,
);

/** Steps that plausibly need the persisted GitHub token. */
const NEEDS_CREDENTIALS_RUN_RE =
  /\bgit\s+(push|commit)\b|\bgh\s+(release|pr\s+create)\b|\bnpm\s+publish\b|\bdocker\s+push\b|\btwine\s+upload\b/i;

const PUBLISH_ACTION_RE =
  /(softprops\/action-gh-release|ncipollo\/release-action|pypa\/gh-action-pypi-publish|docker\/build-push-action)/;

function checkUnpinnedAction(
  findings: Finding[],
  pipeline: CiPipeline,
): void {
  const filename = pipeline.file;
  if (pipeline.source === "github") {
    for (const job of pipeline.jobs) {
      for (const step of job.steps) {
        if (!step.action) continue;
        const uses = step.action.ref;
        // Local actions and Docker actions have no SHA to pin.
        if (uses.startsWith("./") || uses.startsWith("docker://")) continue;
        const at = uses.lastIndexOf("@");
        const ref = at === -1 ? null : uses.slice(at + 1);
        if (ref !== null && SHA_RE.test(ref)) continue;
        const action = at === -1 ? uses : uses.slice(0, at);
        findings.push({
          rule: "workflow/unpinned-action",
          severity: "error",
          file: filename,
          line: step.action.line,
          detail:
            at === -1
              ? `${uses} has no version pinned at all`
              : `${uses} pins a tag or branch (@${ref}), not a commit SHA`,
          fix:
            at === -1
              ? `pin ${uses} to a full commit SHA, e.g. ${uses}@<40-char SHA>`
              : `pin ${action} by SHA: replace @${ref} with the full commit SHA of that ref`,
        });
      }
    }
    return;
  }

  // GitLab: images and services without a digest, plus unpinned includes.
  const imageRefs: { ref: string; line: number; what: string }[] = [];
  for (const image of pipeline.images) {
    imageRefs.push({ ref: image.ref, line: image.line, what: image.kind });
  }
  for (const job of pipeline.jobs) {
    if (job.image) {
      imageRefs.push({
        ref: job.image.ref,
        line: job.image.line,
        what: "image",
      });
    }
    for (const service of job.services) {
      imageRefs.push({
        ref: service.ref,
        line: service.line,
        what: "service",
      });
    }
  }
  for (const { ref, line, what } of imageRefs) {
    if (ref.includes("@sha256:")) continue;
    const colon = ref.lastIndexOf(":");
    const tag = colon === -1 ? null : ref.slice(colon + 1);
    findings.push({
      rule: "workflow/unpinned-action",
      severity: "error",
      file: filename,
      line,
      detail:
        tag === null
          ? `${what} ${ref} has no tag or digest pinned at all (no tag means latest)`
          : `${what} ${ref} pins a moving tag (:${tag}), not a digest`,
      fix: `pin ${ref} by digest: ${ref.split("@")[0]}@sha256:<digest>`,
    });
  }
  for (const include of pipeline.includes) {
    if (include.kind === "remote") {
      findings.push({
        rule: "workflow/unpinned-action",
        severity: "error",
        file: filename,
        line: include.line,
        detail: `remote include ${include.raw} has no fixed ref — a remote include always fetches the current file`,
        fix: `vendor the file into the repo (include:local:) or fetch it from a fixed commit`,
      });
    } else if (include.kind === "project" && include.ref === null) {
      findings.push({
        rule: "workflow/unpinned-action",
        severity: "error",
        file: filename,
        line: include.line,
        detail: `project include ${include.raw} has no ref: — it fetches the file from the project's default branch`,
        fix: `add ref: with a fixed tag or commit SHA, e.g. ref: <40-char SHA>`,
      });
    }
  }
}

function checkPullRequestTarget(
  findings: Finding[],
  pipeline: CiPipeline,
): void {
  // GitHub-only: MR pipelines run on MR code by design in GitLab,
  // and there is no checkout-of-untrusted-code-with-secrets pattern
  // to flag in the YAML.
  if (pipeline.source !== "github") return;
  if (pipeline.pullRequestTargetLine === null) return;
  const hasCheckout = pipeline.jobs.some((job) =>
    job.steps.some(
      (step) =>
        step.action !== null &&
        step.action.ref.startsWith("actions/checkout@"),
    ),
  );
  if (!hasCheckout) return;
  findings.push({
    rule: "workflow/pull-request-target",
    severity: "error",
    file: pipeline.file,
    line: pipeline.pullRequestTargetLine,
    detail:
      "pull_request_target with checkout of the PR — runs untrusted code with secrets",
    fix: "use pull_request instead, or check out the base commit (not the PR head) and never run PR code with secrets",
  });
}

function checkTemplateInjection(
  findings: Finding[],
  pipeline: CiPipeline,
  steps: CiStep[],
): void {
  for (const step of steps) {
    if (!step.script) continue;
    if (pipeline.source === "github") {
      const match = TEMPLATE_INJECTION_RE.exec(step.script.text);
      if (!match) continue;
      findings.push({
        rule: "workflow/template-injection",
        severity: "error",
        file: pipeline.file,
        line: step.script.line,
        detail: `${match[0]} interpolated directly into run: — an attacker can inject shell commands through the event payload`,
        fix: "pass the value through an env var instead, e.g. env: TITLE: ${{ github.event.issue.title }} and use $TITLE in run:",
      });
    } else {
      const match = GITLAB_UNTRUSTED_VAR_RE.exec(step.script.text);
      if (!match) continue;
      findings.push({
        rule: "workflow/template-injection",
        severity: "error",
        file: pipeline.file,
        line: step.script.line,
        detail: `${match[0]} expanded directly in script: — it carries MR/commit content an attacker can control, and reaches the shell unvalidated`,
        fix: "quote it (\"$CI_COMMIT_MESSAGE\") so it stays one argument, validate it before use, and never eval it or pass it to a command that interprets its input",
      });
    }
  }
}

function checkExcessivePermissions(
  findings: Finding[],
  pipeline: CiPipeline,
): void {
  // GitHub-only: GitLab job-token scopes live in project settings,
  // not in the YAML, so there is nothing to flag here.
  if (pipeline.source !== "github") return;
  const check = (value: string | null, line: number | null): void => {
    if (value === "write-all" && line !== null) {
      findings.push({
        rule: "workflow/excessive-permissions",
        severity: "warning",
        file: pipeline.file,
        line,
        detail: "permissions: write-all grants every scope to the workflow token",
        fix: "grant only the scopes the workflow needs, e.g. permissions: { contents: read }",
      });
    }
  };
  if (pipeline.topPermissions) {
    check(pipeline.topPermissions.value, pipeline.topPermissions.line);
  }
  for (const job of pipeline.jobs) {
    check(job.permissionsValue, job.permissionsLine);
  }
}

function checkPersistCredentials(
  findings: Finding[],
  pipeline: CiPipeline,
): void {
  // GitHub-only: GitLab has no persist-credentials equivalent.
  if (pipeline.source !== "github") return;
  for (const job of pipeline.jobs) {
    const jobNeedsCredentials = job.steps.some(
      (step) =>
        (step.script !== null &&
          NEEDS_CREDENTIALS_RUN_RE.test(step.script.text)) ||
        (step.action !== null && PUBLISH_ACTION_RE.test(step.action.ref)),
    );
    if (jobNeedsCredentials) continue;
    for (const step of job.steps) {
      if (!step.action) continue;
      if (!step.action.ref.startsWith("actions/checkout@")) continue;
      if (step.persistCredentials === false) continue;
      findings.push({
        rule: "workflow/persist-credentials",
        severity: "warning",
        file: pipeline.file,
        line: step.action.line,
        detail:
          step.persistCredentials === true
            ? `actions/checkout persists the GitHub token in this job, but no step pushes or publishes anything`
            : `actions/checkout persists the GitHub token by default in this job, but no step pushes or publishes anything`,
        fix: "add with: { persist-credentials: false } to the checkout step",
      });
    }
  }
}

function checkUntrustedInputInRun(
  findings: Finding[],
  pipeline: CiPipeline,
  steps: CiStep[],
): void {
  // GitHub-only: GitLab trigger-time variables cannot be told apart
  // from project variables in the YAML, so there is no reliable
  // signal to flag. The manual-job + untrusted-variable case is
  // covered by template-injection instead.
  if (pipeline.source !== "github") return;
  const hasDispatch = pipeline.triggers.includes("workflow_dispatch");
  const hasIssueComment = pipeline.triggers.includes("issue_comment");
  if (!hasDispatch && !hasIssueComment) return;
  for (const step of steps) {
    if (!step.script) continue;
    let match: RegExpExecArray | null = null;
    if (hasDispatch) {
      match = WORKFLOW_DISPATCH_INPUT_RE.exec(step.script.text);
    }
    if (!match && hasIssueComment) {
      match = ISSUE_COMMENT_INPUT_RE.exec(step.script.text);
    }
    if (!match) continue;
    findings.push({
      rule: "workflow/untrusted-input-in-run",
      severity: "warning",
      file: pipeline.file,
      line: step.script.line,
      detail: `${match[0]} used unsanitized in run: — input from an untrusted user reaches the shell`,
      fix: "pass the input through an env var and validate or quote it before use; never interpolate it directly in run:",
    });
  }
}

/**
 * Runs all six workflow-security rules against one pipeline,
 * in either CI. Throws on unparseable YAML (the runner turns that
 * into exit 2) — the adapters throw before this is reached.
 */
export function checkWorkflowModel(pipeline: CiPipeline): Finding[] {
  const findings: Finding[] = [];
  const allSteps = pipeline.jobs.flatMap((job) => job.steps);

  checkUnpinnedAction(findings, pipeline);
  checkPullRequestTarget(findings, pipeline);
  checkTemplateInjection(findings, pipeline, allSteps);
  checkExcessivePermissions(findings, pipeline);
  checkPersistCredentials(findings, pipeline);
  checkUntrustedInputInRun(findings, pipeline, allSteps);

  return findings;
}

/**
 * Text-based entry point (GitHub only, kept for the v1 tests and
 * callers): parse the workflow, then run the model rules on it.
 * Returns [] when the document has no mapping at the top level.
 * Throws on unparseable YAML (the runner turns that into exit 2).
 */
export function checkWorkflow(content: string, filename: string): Finding[] {
  const pipeline = adaptGitHub(content, filename);
  if (pipeline === null) return [];
  return checkWorkflowModel(pipeline);
}
