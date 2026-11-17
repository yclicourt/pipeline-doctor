import { describe, it, expect } from "vitest";
import { renderTerminal, renderJson, renderJunit } from "../src/report.js";
import type { Report } from "../src/types.js";

function reportWithSkipped(): Report {
  return {
    target: "/tmp/some-repo",
    stats: {
      workflows: 1,
      filesScanned: 10,
      depsChecked: 5,
      durationMs: 1200,
    },
    findings: [
      {
        rule: "workflow/unpinned-action",
        severity: "error",
        file: ".github/workflows/ci.yml",
        line: 14,
        detail: "actions/checkout@v4",
        fix: "pin by SHA",
      },
    ],
    ignored: [],
    skipped: [
      {
        rule: "deploy/digest-in-k3s",
        reason: "repo-only mode: no cluster access",
      },
    ],
  };
}

describe("renderTerminal with skipped checks", () => {
  it("lists skipped checks with their reason and counts them", () => {
    const out = renderTerminal(reportWithSkipped(), false);
    expect(out).toContain("skipped checks (not verified — see the reason):");
    expect(out).toContain("deploy/digest-in-k3s");
    expect(out).toContain("repo-only mode: no cluster access");
    expect(out).toContain("1 error · 0 warnings · ignored: 0 · skipped: 1");
  });

  it("says 'No issues found.' only when nothing is skipped either", () => {
    const empty: Report = {
      target: "/tmp/some-repo",
      stats: { workflows: 0, filesScanned: 0, depsChecked: 0, durationMs: 10 },
      findings: [],
      ignored: [],
      skipped: [],
    };
    expect(renderTerminal(empty, false)).toContain("No issues found.");
    const onlySkipped: Report = { ...empty, skipped: reportWithSkipped().skipped };
    expect(renderTerminal(onlySkipped, false)).not.toContain(
      "No issues found.",
    );
  });
});

describe("renderJson with skipped checks", () => {
  it("includes the skipped array", () => {
    const parsed = JSON.parse(renderJson(reportWithSkipped(), "0.2.0"));
    expect(parsed.skipped).toEqual([
      {
        rule: "deploy/digest-in-k3s",
        reason: "repo-only mode: no cluster access",
      },
    ]);
  });
});

describe("renderJunit with skipped checks", () => {
  it("emits skipped testcases and counts them", () => {
    const out = renderJunit(reportWithSkipped());
    expect(out).toContain('tests="2"');
    expect(out).toContain('skipped="1"');
    expect(out).toContain("<skipped");
    expect(out).toContain("deploy/digest-in-k3s");
  });
});
