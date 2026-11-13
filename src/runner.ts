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
import { checkWorkflow } from "./checks/workflow.js";
import {
  checkSecrets,
  collectSecretFiles,
  MAX_SECRET_FILE_BYTES,
} from "./checks/secrets.js";
import { checkHygiene } from "./checks/hygiene.js";
import { checkDeps } from "./checks/deps.js";
import type {
  CheckFamily,
  Finding,
  IgnoredFinding,
  Report,
} from "./types.js";

/**
 * Runner (spec §3, §8 days 5–6).
 *
 * All four v1 families are implemented. `runCheck` is async because
 * the deps family calls the OSV API over the network; an OSV failure
 * throws and the CLI turns it into exit 2 — never a silent pass.
 */

export interface RunOptions {
  only?: CheckFamily;
  targetDir: string;
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
    : (["workflow", "secrets", "deps", "hygiene"] as CheckFamily[]);

  // An explicit --only wins over the config toggle for that family.
  const families = requested.filter(
    (family) => options.only !== undefined || config.checks[family],
  );

  const findings: Finding[] = [];
  let workflowCount = 0;
  let filesScanned = 0;
  let depsChecked = 0;

  // Workflow + hygiene both read the same files; each family parses
  // the content itself, so the check functions stay pure and
  // independent. An unparseable workflow fails loudly (exit 2).
  if (families.includes("workflow") || families.includes("hygiene")) {
    const files = findWorkflowFiles(targetDir);
    workflowCount = files.length;
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch (error) {
        throw new Error(
          `cannot read ${toPosixRelative(targetDir, file)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const rel = toPosixRelative(targetDir, file);
      try {
        if (families.includes("workflow")) {
          findings.push(...checkWorkflow(content, rel));
        }
        if (families.includes("hygiene")) {
          findings.push(...checkHygiene(content, rel));
        }
      } catch (error) {
        // An unparseable workflow cannot be audited — fail loudly.
        throw new Error(
          `failed to parse ${toPosixRelative(targetDir, file)}: ${error instanceof Error ? error.message : String(error)}`,
        );
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
