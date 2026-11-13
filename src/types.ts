export type Severity = "error" | "warning";

export type CheckFamily = "workflow" | "secrets" | "deps" | "hygiene";

export const CHECK_FAMILIES: CheckFamily[] = [
  "workflow",
  "secrets",
  "deps",
  "hygiene",
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
}
