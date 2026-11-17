import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import {
  loadConfig,
  CONFIG_FILENAME,
  EXAMPLE_CONFIG,
  type PipelineDoctorConfig,
} from "./config.js";
import { checkWorkflowModel } from "./checks/workflow.js";
import {
  checkSecrets,
  collectSecretFiles,
  MAX_SECRET_FILE_BYTES,
} from "./checks/secrets.js";
import { checkHygieneModel } from "./checks/hygiene.js";
import { checkDeps } from "./checks/deps.js";
import { checkCi } from "./checks/ci.js";
import { checkDeploy } from "./checks/deploy.js";
import { adaptGitHub } from "./ci/github.js";
import { adaptGitLab } from "./ci/gitlab.js";
import {
  detectCiSources,
  resolveCiSources,
  type CiSelection,
} from "./ci/detect.js";
import type { CiPipeline } from "./ci/model.js";
import { readDeployEnv } from "./env.js";
import type {
  CheckFamily,
  Finding,
  IgnoredFinding,
  Report,
  SkippedCheck,
} from "./types.js";

/**
 * Runner (spec §3, §8 days 5–6; 0.2.0 adds the ci and deploy families).
 *
 * All four v1 families are implemented, plus the 0.2.0 scaffolding:
 * `checkCi` and `checkDeploy` are wired in and return their findings
 * and skipped checks. `runCheck` is async because the deps family
 * calls the OSV API over the network; an OSV failure throws and the
 * CLI turns it into exit 2 — never a silent pass.
 */

export interface RunOptions {
  only?: CheckFamily;
  targetDir: string;
  /**
   * Which CI to audit: github | gitlab | auto (default). Auto means
   * whatever the repo has. A value naming a CI the repo does not
   * have audits nothing for the workflow/hygiene families.
   */
  ci?: CiSelection;
  /**
   * Repo-only mode (decision 02). CLI flag wins over the config file:
   * --repo-only forces it on; without the flag the config value
   * (deploy.repoOnly) applies.
   */
  repoOnly?: boolean;
  /** Injectable for tests — production passes the global fetch. */
  fetchFn?: typeof fetch;
}

export interface RunResult {
  report: Report;
  exitCode: number;
  notes: string[];
}

function findWorkflowFiles(dir: string): string[] {
  const workflowsDir = join(dir, ".github", "workflows");
  if (!existsSync(workflowsDir)) return [];
  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")),
    )
    .map((entry) => join(workflowsDir, entry.name))
    .sort();
}

function toPosixRelative(targetDir: string, absolutePath: string): string {
  return relative(targetDir, absolutePath).split(sep).join("/");
}

export async function runCheck(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const targetDir = resolve(options.targetDir);
  if (!existsSync(targetDir)) {
    throw new Error(`target directory does not exist: ${targetDir}`);
  }

  const config: PipelineDoctorConfig = loadConfig(targetDir);
  const notes: string[] = [];

  const requested: CheckFamily[] = options.only
    ? [options.only]
    : ([
        "workflow",
        "secrets",
        "deps",
        "hygiene",
        "ci",
        "deploy",
      ] as CheckFamily[]);

  // An explicit --only wins over the config toggle for that family.
  const families = requested.filter(
    (family) => options.only !== undefined || config.checks[family],
  );

  const findings: Finding[] = [];
  const skipped: SkippedCheck[] = [];
  let workflowCount = 0;
  let filesScanned = 0;
  let depsChecked = 0;

  // Workflow + hygiene run on the common CI model (0.2.0 Fase B):
  // each detected CI source (GitHub Actions and/or GitLab CI) is
  // parsed by its adapter, then the same rules run on the model.
  // An unparseable pipeline fails loudly (exit 2).
  if (families.includes("workflow") || families.includes("hygiene")) {
    const detected = detectCiSources(targetDir);
    const sources = resolveCiSources(options.ci ?? "auto", detected);
    const pipelines: CiPipeline[] = [];
    const readText = (absolutePath: string): string => {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch (error) {
        throw new Error(
          `cannot read ${toPosixRelative(targetDir, absolutePath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const parsePipeline = (
      adapt: (content: string, file: string) => CiPipeline | null,
      absolutePath: string,
      rel: string,
    ): void => {
      try {
        const pipeline = adapt(readText(absolutePath), rel);
        if (pipeline !== null) pipelines.push(pipeline);
      } catch (error) {
        // An unparseable pipeline cannot be audited — fail loudly.
        throw new Error(
          `failed to parse ${rel}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    if (sources.includes("github")) {
      for (const file of findWorkflowFiles(targetDir)) {
        workflowCount++;
        parsePipeline(adaptGitHub, file, toPosixRelative(targetDir, file));
      }
    }
    if (sources.includes("gitlab")) {
      const gitlabFile = join(targetDir, ".gitlab-ci.yml");
      if (existsSync(gitlabFile)) {
        workflowCount++;
        parsePipeline(adaptGitLab, gitlabFile, ".gitlab-ci.yml");
      }
    }
    for (const pipeline of pipelines) {
      if (families.includes("workflow")) {
        findings.push(...checkWorkflowModel(pipeline));
      }
      if (families.includes("hygiene")) {
        findings.push(...checkHygieneModel(pipeline));
      }
    }
  }

  if (families.includes("secrets")) {
    for (const file of collectSecretFiles(targetDir)) {
      let size: number;
      try {
        size = statSync(file).size;
      } catch (error) {
        throw new Error(
          `cannot read ${toPosixRelative(targetDir, file)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Oversized and binary files are skipped, not audited blindly.
      if (size > MAX_SECRET_FILE_BYTES) continue;
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch (error) {
        throw new Error(
          `cannot read ${toPosixRelative(targetDir, file)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (content.includes("\0")) continue;
      filesScanned++;
      findings.push(...checkSecrets(content, toPosixRelative(targetDir, file)));
    }
  }

  if (families.includes("deps")) {
    // Async — the OSV API is called over the network. A failure
    // throws and the CLI turns it into exit 2, never a silent pass.
    const result = await checkDeps(targetDir, options.fetchFn);
    depsChecked = result.depsChecked;
    findings.push(...result.findings);
  }

  if (families.includes("ci")) {
    // Async — CI-02 reads Harbor, CI-06 reads the app, CI-07 reads
    // the GitHub API. Credentials come from env vars only (decision 01).
    const env = readDeployEnv();
    const result = await checkCi(targetDir, {
      env,
      fetchFn: options.fetchFn,
    });
    findings.push(...result.findings);
    skipped.push(...result.skipped);
  }

  if (families.includes("deploy")) {
    // Async — Harbor, ArgoCD, the k8s API, Postgres and the app are
    // all network calls. Credentials come from env vars only
    // (decision 01); missing backends make their checks skipped.
    const repoOnly = options.repoOnly ?? config.deploy.repoOnly;
    const env = readDeployEnv();
    const result = await checkDeploy(targetDir, {
      repoOnly,
      budgets: config.deploy.budgets,
      probe: config.deploy.probe,
      env,
      fetchFn: options.fetchFn,
    });
    findings.push(...result.findings);
    skipped.push(...result.skipped);
  }

  // Apply `ignore` entries: exact rule + exact (repo-relative) path match.
  const ignored: IgnoredFinding[] = [];
  const active: Finding[] = [];
  for (const finding of findings) {
    const entry = config.ignore.find(
      (ignore) =>
        ignore.rule === finding.rule && ignore.path === finding.file,
    );
    if (entry) {
      ignored.push({ ...finding, reason: entry.reason });
    } else {
      active.push(finding);
    }
  }

  const errors = active.filter((f) => f.severity === "error").length;
  const warnings = active.filter((f) => f.severity === "warning").length;
  let exitCode = 0;
  if (errors > 0) exitCode = 1;
  else if (config.failOn === "warning" && warnings > 0) exitCode = 1;

  const report: Report = {
    target: targetDir,
    stats: {
      workflows: workflowCount,
      filesScanned,
      depsChecked,
      durationMs: Date.now() - started,
    },
    findings: active,
    ignored,
    skipped,
  };

  return { report, exitCode, notes };
}

/**
 * `init`: writes the example pipeline-doctor.yml. Refuses to overwrite
 * an existing one (the user asked for no destructive surprises).
 */
export function runInit(targetDir: string): string {
  const resolved = resolve(targetDir);
  if (!existsSync(resolved)) {
    throw new Error(`target directory does not exist: ${resolved}`);
  }
  const path = join(resolved, CONFIG_FILENAME);
  if (existsSync(path)) {
    throw new Error(
      `${CONFIG_FILENAME} already exists in ${resolved} — not overwriting it`,
    );
  }
  writeFileSync(path, EXAMPLE_CONFIG, "utf8");
  return path;
}
