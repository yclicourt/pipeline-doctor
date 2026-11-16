import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../src/runner.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-doctor-test-"));
}

describe("runCheck with the 0.2.0 families", () => {
  it("runs --only deploy clean on an empty repo (no findings, skips listed)", async () => {
    const result = await runCheck({ only: "deploy", targetDir: tempDir() });
    expect(result.exitCode).toBe(0);
    expect(result.report.findings).toEqual([]);
    // Nothing to verify in an empty repo — the checks say so instead
    // of pretending they ran.
    expect(result.report.skipped.length).toBeGreaterThan(0);
    expect(
      result.report.skipped.map((s) => s.rule),
    ).toContain("deploy/image-size");
  });

  it("runs --only ci clean on an empty repo (no findings, skips listed)", async () => {
    const result = await runCheck({ only: "ci", targetDir: tempDir() });
    expect(result.exitCode).toBe(0);
    expect(result.report.findings).toEqual([]);
    // Nothing to verify in an empty repo — the checks say so instead
    // of pretending they ran.
    expect(result.report.skipped.length).toBeGreaterThan(0);
    expect(
      result.report.skipped.map((s) => s.rule),
    ).toContain("ci/unpinned-image-tag");
  });

  it("accepts the --repo-only flag without changing the exit code", async () => {
    const result = await runCheck({
      only: "deploy",
      targetDir: tempDir(),
      repoOnly: true,
    });
    expect(result.exitCode).toBe(0);
  });
});
