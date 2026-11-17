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
      ci: true,
      deploy: true,
    });
    expect(config.deploy).toEqual({
      repoOnly: false,
      budgets: { frontendMb: 75, backendMb: 250, genericMb: 300 },
      probe: {
        create: {
          path: "/tasks/",
          body: {
            title: "pipeline-doctor probe",
            description: "Ephemeral probe task — safe to delete",
            done: false,
          },
          idField: "id",
        },
        read: { path: "/tasks/{id}/" },
        delete: { path: "/tasks/{id}/" },
      },
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
      "checks:\n  staging: true\n",
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it("parses the deploy section", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      `deploy:
  repoOnly: true
  budgets:
    frontendMb: 100
    backendMb: 200
`,
    );
    const config = loadConfig(dir);
    expect(config.deploy.repoOnly).toBe(true);
    expect(config.deploy.budgets.frontendMb).toBe(100);
    expect(config.deploy.budgets.backendMb).toBe(200);
    // Unspecified budgets keep their defaults.
    expect(config.deploy.budgets.genericMb).toBe(300);
  });

  it("rejects a non-boolean deploy.repoOnly", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      "deploy:\n  repoOnly: yes-please\n",
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it("rejects a non-positive deploy budget", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      "deploy:\n  budgets:\n    frontendMb: 0\n",
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it("rejects an unknown deploy budget", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      "deploy:\n  budgets:\n    mobileMb: 50\n",
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it("parses the probe section", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      `deploy:
  probe:
    login:
      path: /api/auth/login/
      usernameField: username
      passwordField: password
      tokenField: access
    create:
      path: /api/items/
      body: { name: "probe" }
      idField: uuid
    read:
      path: /api/items/{id}/
`,
    );
    const config = loadConfig(dir);
    expect(config.deploy.probe.login).toEqual({
      path: "/api/auth/login/",
      usernameField: "username",
      passwordField: "password",
      tokenField: "access",
      tokenScheme: "Bearer",
    });
    expect(config.deploy.probe.create).toEqual({
      path: "/api/items/",
      body: { name: "probe" },
      idField: "uuid",
    });
    expect(config.deploy.probe.read).toEqual({ path: "/api/items/{id}/" });
    // Unspecified steps keep their defaults.
    expect(config.deploy.probe.delete).toEqual({ path: "/tasks/{id}/" });
  });

  it("rejects a probe login missing a field", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      "deploy:\n  probe:\n    login:\n      path: /api/auth/login/\n",
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it("rejects an unknown probe step", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pipeline-doctor.yml"),
      "deploy:\n  probe:\n    update:\n      path: /api/items/{id}/\n",
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });
});
