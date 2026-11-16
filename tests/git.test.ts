import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  isGitRepo,
  getHeadSha,
  getWorkingTreeStatus,
  getRemoteOrigin,
  parseGitHubRepo,
} from "../src/git.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-doctor-test-"));
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function initRepo(): string {
  const dir = tempDir();
  git(dir, "init", "-q");
  git(
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-qm",
    "init",
  );
  return dir;
}

describe("isGitRepo / getHeadSha / getWorkingTreeStatus", () => {
  it("reports a plain directory as not a repo", () => {
    const dir = tempDir();
    expect(isGitRepo(dir)).toBe(false);
    expect(getHeadSha(dir)).toBeNull();
    expect(getWorkingTreeStatus(dir)).toBeNull();
  });

  it("reports a clean repo with a HEAD SHA", () => {
    const dir = initRepo();
    expect(isGitRepo(dir)).toBe(true);
    expect(getHeadSha(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(getWorkingTreeStatus(dir)).toEqual([]);
  });

  it("reports untracked files as dirty", () => {
    const dir = initRepo();
    writeFileSync(join(dir, "new.txt"), "hello\n");
    const status = getWorkingTreeStatus(dir);
    expect(status).not.toBeNull();
    expect(status?.length).toBe(1);
    expect(status?.[0]).toContain("new.txt");
  });
});

describe("getRemoteOrigin / parseGitHubRepo", () => {
  it("returns null without a remote", () => {
    expect(getRemoteOrigin(initRepo())).toBeNull();
  });

  it("returns the origin URL when set", () => {
    const dir = initRepo();
    git(dir, "remote", "add", "origin", "https://github.com/yclicourt/pipeline-doctor.git");
    expect(getRemoteOrigin(dir)).toBe(
      "https://github.com/yclicourt/pipeline-doctor.git",
    );
  });

  it("parses https and ssh GitHub remotes", () => {
    expect(
      parseGitHubRepo("https://github.com/yclicourt/pipeline-doctor.git"),
    ).toEqual({ owner: "yclicourt", repo: "pipeline-doctor" });
    expect(parseGitHubRepo("https://github.com/o/r")).toEqual({
      owner: "o",
      repo: "r",
    });
    expect(parseGitHubRepo("git@github.com:yclicourt/pipeline-doctor.git")).toEqual({
      owner: "yclicourt",
      repo: "pipeline-doctor",
    });
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRepo("https://gitlab.com/o/r.git")).toBeNull();
    expect(parseGitHubRepo("/srv/local/repo")).toBeNull();
    expect(parseGitHubRepo(null)).toBeNull();
  });
});
