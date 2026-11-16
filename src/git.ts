import { execFileSync } from "node:child_process";

/**
 * Minimal git access (0.2.0, CI-04 + CI-07).
 *
 * The tool shells out to the `git` binary — no new dependency, and
 * git is present wherever the tool runs (developer machines, CI
 * runners). Every helper returns null when git is missing, the
 * directory is not a repo, or the command fails: a repo without git
 * is not a failure, it just means the git-backed checks are skipped
 * with the reason named.
 */

function runGit(dir: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

export function isGitRepo(dir: string): boolean {
  return runGit(dir, ["rev-parse", "--git-dir"]) !== null;
}

/** Full HEAD SHA, or null when there is no commit yet. */
export function getHeadSha(dir: string): string | null {
  const out = runGit(dir, ["rev-parse", "HEAD"]);
  return out === null || out === "" ? null : out;
}

/**
 * Porcelain status lines (one per changed file), [] when the tree is
 * clean, null when git cannot answer (not a repo, no git binary).
 */
export function getWorkingTreeStatus(dir: string): string[] | null {
  const out = runGit(dir, ["status", "--porcelain"]);
  if (out === null) return null;
  if (out === "") return [];
  return out.split("\n").filter((line) => line.length > 0);
}

/** The `origin` remote URL, or null when there is none. */
export function getRemoteOrigin(dir: string): string | null {
  const out = runGit(dir, ["remote", "get-url", "origin"]);
  return out === null || out === "" ? null : out;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/**
 * Parses a GitHub remote (https or ssh) into owner/repo.
 * Returns null for non-GitHub remotes (GitLab, local paths, ...).
 */
export function parseGitHubRepo(remote: string | null): GitHubRepo | null {
  if (remote === null) return null;
  const https = remote.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  );
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = remote.match(
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
  );
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}
