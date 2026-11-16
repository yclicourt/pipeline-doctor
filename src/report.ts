import { basename } from "node:path";
import type { Finding, Report } from "./types.js";

/**
 * Report rendering (spec §3).
 *
 * Terminal format, exactly as in the spec:
 *
 *   pipeline-doctor — buildora-backend
 *   workflows: 2 · files scanned: 148 · deps checked: 312 · 3.1s
 *
 *     ✗ workflow/unpinned-action      .github/workflows/ci.yml:14
 *         actions/checkout@v4 — pin by SHA: actions/checkout@11bd719...
 *
 *     3 errors · 2 warnings · ignored: 0
 *
 * Notes:
 * - The "exit 1" line in the spec example is the shell's exit code, not
 *   report output — it is NOT printed here.
 * - Ignored findings are listed after the active ones (marker ○) with
 *   their reason, because the spec says the report lists the ignored.
 * - Output is deterministic and colorless when stdout is not a TTY
 *   (or with --no-color).
 */

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function padRule(rule: string, width: number): string {
  return rule.padEnd(width);
}

export function renderTerminal(report: Report, useColor: boolean): string {
  const lines: string[] = [];
  const allRules = [
    ...report.findings.map((f) => f.rule),
    ...report.ignored.map((f) => f.rule),
    ...report.skipped.map((s) => s.rule),
  ];
  const ruleWidth = Math.max(0, ...allRules.map((r) => r.length)) + 2;

  lines.push(`pipeline-doctor — ${basename(report.target)}`);
  const seconds = (report.stats.durationMs / 1000).toFixed(1);
  lines.push(
    `workflows: ${report.stats.workflows} · files scanned: ${report.stats.filesScanned} · deps checked: ${report.stats.depsChecked} · ${seconds}s`,
  );
  lines.push("");

  const mark = (f: Finding): string => {
    if (f.severity === "error") return useColor ? `${RED}✗${RESET}` : "✗";
    return useColor ? `${YELLOW}⚠${RESET}` : "⚠";
  };

  if (
    report.findings.length === 0 &&
    report.ignored.length === 0 &&
    report.skipped.length === 0
  ) {
    lines.push("  No issues found.");
  }

  for (const finding of report.findings) {
    lines.push(
      `  ${mark(finding)} ${padRule(finding.rule, ruleWidth)}${finding.file}:${finding.line}`,
    );
    lines.push(`      ${finding.detail} — ${finding.fix}`);
  }

  if (report.ignored.length > 0) {
    lines.push("");
    lines.push("  ignored findings:");
    for (const finding of report.ignored) {
      lines.push(
        `  ○ ${padRule(finding.rule, ruleWidth)}${finding.file}:${finding.line}`,
      );
      lines.push(`      ${finding.detail} (ignored: ${finding.reason})`);
    }
  }

  if (report.skipped.length > 0) {
    lines.push("");
    lines.push("  skipped checks (not verified — see the reason):");
    for (const check of report.skipped) {
      lines.push(`  – ${padRule(check.rule, ruleWidth)}${check.reason}`);
    }
  }

  const errors = report.findings.filter((f) => f.severity === "error").length;
  const warnings = report.findings.filter(
    (f) => f.severity === "warning",
  ).length;
  lines.push("");
  lines.push(
    `  ${errors} error${errors === 1 ? "" : "s"} · ${warnings} warning${warnings === 1 ? "" : "s"} · ignored: ${report.ignored.length} · skipped: ${report.skipped.length}`,
  );

  return lines.join("\n") + "\n";
}

export function renderJson(report: Report, version: string): string {
  return (
    JSON.stringify(
      {
        tool: "pipeline-doctor",
        version,
        target: report.target,
        stats: {
          workflows: report.stats.workflows,
          filesScanned: report.stats.filesScanned,
          depsChecked: report.stats.depsChecked,
          durationMs: report.stats.durationMs,
        },
        findings: report.findings.map((f) => ({
          rule: f.rule,
          severity: f.severity,
          file: f.file,
          line: f.line,
          detail: f.detail,
          fix: f.fix,
        })),
        ignored: report.ignored.map((f) => ({
          rule: f.rule,
          severity: f.severity,
          file: f.file,
          line: f.line,
          detail: f.detail,
          fix: f.fix,
          reason: f.reason,
        })),
        skipped: report.skipped.map((s) => ({
          rule: s.rule,
          reason: s.reason,
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * JUnit XML for CI test reports. Errors become <failure>; warnings are
 * passing test cases whose name carries the warning, so a warning never
 * fails a CI job on its own (matching the failOn semantics).
 */
export function renderJunit(report: Report): string {
  const errors = report.findings.filter((f) => f.severity === "error").length;
  const total = report.findings.length + report.skipped.length;
  const seconds = (report.stats.durationMs / 1000).toFixed(3);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push("<testsuites>");
  lines.push(
    `  <testsuite name="pipeline-doctor" tests="${total}" failures="${errors}" skipped="${report.skipped.length}" time="${seconds}">`,
  );
  for (const finding of report.findings) {
    const name = escapeXml(
      `${finding.file}:${finding.line} — ${finding.detail}`,
    );
    lines.push(
      `    <testcase classname="${escapeXml(finding.rule)}" name="${name}" time="0">`,
    );
    if (finding.severity === "error") {
      lines.push(
        `      <failure message="${escapeXml(finding.detail)}">${escapeXml(finding.fix)}</failure>`,
      );
    }
    lines.push("    </testcase>");
  }
  for (const check of report.skipped) {
    lines.push(
      `    <testcase classname="${escapeXml(check.rule)}" name="${escapeXml(check.reason)}" time="0">`,
    );
    lines.push(`      <skipped message="${escapeXml(check.reason)}"/>`);
    lines.push("    </testcase>");
  }
  lines.push("  </testsuite>");
  lines.push("</testsuites>");
  return lines.join("\n") + "\n";
}
