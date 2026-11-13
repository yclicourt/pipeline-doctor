import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-doctor-test-"));
}

describe("loadConfig", () => {
  it("returns defaults when there is no config file", () => {
    const config = loadConfig(tempDir());
    expect(config.failOn).toBe("error");
    expect(config.ignore).toEqual([]);
    expect(config.checks).toEqual({
      workflow: true,
      secrets: true,
      deps: true,
      hygiene: true,
    });
  });

  it("parses a valid config file", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      `failOn: warning
ignore:
  - rule: workflow/unpinned-action
    path: .github/workflows/release.yml
    reason: "internal action"
checks:
  deps: false
`,
    );
    const config = loadConfig(dir);
    expect(config.failOn).toBe("warning");
    expect(config.ignore).toHaveLength(1);
    expect(config.ignore[0].rule).toBe("workflow/unpinned-action");
    expect(config.checks.deps).toBe(false);
    expect(config.checks.workflow).toBe(true);
  });

  it("rejects an ignore entry without a reason", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      `ignore:
  - rule: workflow/unpinned-action
    path: .github/workflows/release.yml
`,
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it("rejects an invalid failOn value", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "pipeline-doctor.yml"), "failOn: always\n");
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it("rejects a non-mapping config", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "pipeline-doctor.yml"), "- just\n- a\n- list\n");
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it("rejects an unknown check family", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      "checks:\n  deploy: true\n",
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });
});
