export type Severity = "error" | "warning";

export type CheckFamily =
  | "workflow"
  | "secrets"
  | "deps"
  | "hygiene"
  | "ci"
  | "deploy";

export const CHECK_FAMILIES: CheckFamily[] = [
  "workflow",
  "secrets",
  "deps",
  "hygiene",
  "ci",
  "deploy",
];

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  detail: string;
  fix: string;
}

export interface IgnoredFinding extends Finding {
  reason: string;
}

/**
 * A check that did not run. It is neither a pass nor a failure: the
 * tool could not verify that rule (no cluster access in repo-only
 * mode, missing credentials, no deploy configured). Skipped checks
 * never change the exit code — but they are listed, because a silent
 * skip would be a lie by omission.
 */
export interface SkippedCheck {
  rule: string;
  reason: string;
}

export interface ReportStats {
  workflows: number;
  filesScanned: number;
  depsChecked: number;
  durationMs: number;
}

export interface Report {
  target: string;
  stats: ReportStats;
  findings: Finding[];
  ignored: IgnoredFinding[];
  skipped: SkippedCheck[];
}
