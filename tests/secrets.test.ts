import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { checkSecrets, collectSecretFiles } from "../src/checks/secrets.js";

function findingsFor(content: string, rule: string) {
  return checkSecrets(content, "src/config.ts").filter(
    (f) => f.rule === rule,
  );
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

const GHP_TOKEN = `ghp_${"a".repeat(36)}`;
const GITHUB_PAT = `github_pat_11ABCDEFGH${"b".repeat(12)}_c${"d".repeat(58)}`;

describe("secrets/github-token", () => {
  it("flags a classic GitHub PAT", () => {
    const found = findingsFor(`const token = "${GHP_TOKEN}";\n`, "secrets/github-token");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].line).toBe(1);
    // The full token must never appear in the report.
    expect(found[0].detail).not.toContain(GHP_TOKEN);
    expect(found[0].detail).toContain("ghp_...");
    expect(found[0].fix).toContain("environment variable");
  });

  it("flags a fine-grained GitHub PAT", () => {
    expect(
      findingsFor(`token = "${GITHUB_PAT}"\n`, "secrets/github-token"),
    ).toHaveLength(1);
  });

  it("passes a ${GITHUB_TOKEN} variable reference", () => {
    expect(
      findingsFor(`const token = process.env.GITHUB_TOKEN;\n`, "secrets/github-token"),
    ).toHaveLength(0);
  });

  it("passes a short ghp_ fragment", () => {
    expect(findingsFor(`ghp_abc\n`, "secrets/github-token")).toHaveLength(0);
  });
});

describe("secrets/aws-key", () => {
  it("flags an AWS access key id", () => {
    const found = findingsFor(
      `aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"\n`,
      "secrets/aws-key",
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].detail).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(found[0].detail).toContain("AKIA...");
  });

  it("passes a bare AKIA prefix", () => {
    expect(findingsFor(`AKIA\n`, "secrets/aws-key")).toHaveLength(0);
  });
});

describe("secrets/private-key", () => {
  it("flags a PEM private key header", () => {
    const content = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA7...",
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");
    const found = findingsFor(content, "secrets/private-key");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].line).toBe(1);
  });

  it("flags an OpenSSH private key header", () => {
    expect(
      findingsFor("-----BEGIN OPENSSH PRIVATE KEY-----\n", "secrets/private-key"),
    ).toHaveLength(1);
  });

  it("passes a public key", () => {
    expect(
      findingsFor("-----BEGIN PUBLIC KEY-----\n", "secrets/private-key"),
    ).toHaveLength(0);
  });
});

describe("secrets/connection-string-password", () => {
  it("flags a password in a postgres URL", () => {
    const found = findingsFor(
      `DATABASE_URL=postgres://dbuser:s3cretpass@db:5432/app\n`,
      "secrets/connection-string-password",
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].detail).not.toContain("s3cretpass");
    expect(found[0].detail).toContain("postgres://dbuser:s3cr...pass@db:5432");
  });

  it("flags a password in a mongodb+srv URL", () => {
    expect(
      findingsFor(
        `MONGO=mongodb+srv://admin:hunter2pass@cluster0.example.net/db\n`,
        "secrets/connection-string-password",
      ),
    ).toHaveLength(1);
  });

  it("passes a URL without a password", () => {
    expect(
      findingsFor(
        `DATABASE_URL=postgres://dbuser@localhost:5432/app\n`,
        "secrets/connection-string-password",
      ),
    ).toHaveLength(0);
  });

  it("passes a password loaded from a variable", () => {
    expect(
      findingsFor(
        `DATABASE_URL=postgres://dbuser:\${DB_PASS}@db:5432/app\n`,
        "secrets/connection-string-password",
      ),
    ).toHaveLength(0);
  });
});

describe("secrets/generic-token", () => {
  it("flags a long api_key assignment", () => {
    const found = findingsFor(
      `api_key = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"\n`,
      "secrets/generic-token",
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].detail).not.toContain("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
  });

  it("flags an OpenAI-style sk- token", () => {
    expect(
      findingsFor(`key = "sk-${"k".repeat(48)}"\n`, "secrets/generic-token"),
    ).toHaveLength(1);
  });

  it("flags a Slack token", () => {
    expect(
      findingsFor(`SLACK_TOKEN=xoxb-123456789012-abcdefghij\n`, "secrets/generic-token"),
    ).toHaveLength(1);
  });

  it("passes a short api_key value", () => {
    expect(
      findingsFor(`api_key = "abc123"\n`, "secrets/generic-token"),
    ).toHaveLength(0);
  });

  it("passes a placeholder api_key value", () => {
    expect(
      findingsFor(`api_key = "change-me"\n`, "secrets/generic-token"),
    ).toHaveLength(0);
    expect(
      findingsFor(`api_key = "\${API_KEY}"\n`, "secrets/generic-token"),
    ).toHaveLength(0);
  });

  it("passes a long letters-only value (a sentence fragment)", () => {
    expect(
      findingsFor(
        `api_key = "thisisjustalongwordwithnolettersmixed"\n`,
        "secrets/generic-token",
      ),
    ).toHaveLength(0);
  });

  it("does not double-report a GitHub token as a generic token", () => {
    // api_token = "ghp_…" matches both the github-token rule and the
    // generic assignment rule — the overlap dedup must leave exactly
    // one finding, the specific one.
    const content = `api_token = "${GHP_TOKEN}"\n`;
    expect(checkSecrets(content, "src/config.ts")).toHaveLength(1);
    expect(checkSecrets(content, "src/config.ts")[0].rule).toBe(
      "secrets/github-token",
    );
  });
});

describe("checkSecrets guards", () => {
  it("returns no findings for an empty file", () => {
    expect(checkSecrets("", "empty.ts")).toHaveLength(0);
  });

  it("returns no findings for binary content", () => {
    expect(
      checkSecrets(`const x = "a\0b"; ${GHP_TOKEN}\n`, "bin.dat"),
    ).toHaveLength(0);
  });

  it("returns no findings for a clean file", () => {
    expect(
      checkSecrets(`export const PORT = 3000;\n`, "src/config.ts"),
    ).toHaveLength(0);
  });
});

describe("collectSecretFiles", () => {
  it("walks the tree, respects .gitignore, and skips lockfiles and tool dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-secrets-"));
    try {
      writeFileSync(join(dir, ".gitignore"), "ignored.log\nbuild/\n");
      writeFileSync(join(dir, "package-lock.json"), GHP_TOKEN);
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "x.js"), GHP_TOKEN);
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "config"), GHP_TOKEN);
      writeFileSync(join(dir, "ignored.log"), GHP_TOKEN);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "index.ts"), GHP_TOKEN);

      const found = collectSecretFiles(dir).map((f) =>
        toPosix(relative(dir, f)),
      );
      expect(found).toEqual([".gitignore", "src/index.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors a negated .gitignore rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-secrets-"));
    try {
      writeFileSync(join(dir, ".gitignore"), "*.log\n!important.log\n");
      writeFileSync(join(dir, "a.log"), GHP_TOKEN);
      writeFileSync(join(dir, "important.log"), GHP_TOKEN);

      const found = collectSecretFiles(dir).map((f) =>
        toPosix(relative(dir, f)),
      );
      expect(found).toContain("important.log");
      expect(found).not.toContain("a.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-secrets-"));
    try {
      expect(collectSecretFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
