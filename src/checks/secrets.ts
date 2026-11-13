import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Finding, Severity } from "../types.js";

/**
 * Hardcoded-secrets rules (spec §3B). Curated own patterns ONLY —
 * gitleaks is v2 and is never invoked here.
 *
 * Each rule is a pure function of one file's text, so it can be
 * unit-tested with minimal inline contents.
 *
 * Severity choices (spec leaves them open; simplest defensible reading):
 * - error: patterns that are secrets by construction — a string that
 *   matches `ghp_…`, `AKIA…`, a `BEGIN … PRIVATE KEY` header or a
 *   `user:password@` connection URL cannot be anything else. A
 *   false positive here is near-impossible, so it fails the CI.
 * - warning: `secrets/generic-token` — pattern-anchored (known vendor
 *   prefixes and `key = "…"` assignments), but the value itself could
 *   in principle be a long random-looking non-secret. It warns so a
 *   human reviews it, without blocking the pipeline on a guess.
 *
 * What is deliberately NOT here (spec §3B): a generic entropy
 * detector with no patterns. Every generic-token match must be
 * anchored to a known prefix (`sk-`, `xoxb-`, `AIza`, `SG.`) or to
 * an assignment whose key names a secret (`api_key`, `access_token`,
 * …) AND whose value is long and mixed (letters + digits). Short
 * values, placeholders (`${…}`, `<…>`, `change-me`, `your-…`) and
 * values without a digit never fire.
 *
 * Secrets are NEVER printed in full: findings carry the masked form
 * only (`sk-...a1b2` — first 4 and last 4 characters). The same
 * masking applies to the detail of every rule below.
 */

/** Files over this size are skipped (generated bundles, data dumps). */
export const MAX_SECRET_FILE_BYTES = 1_000_000;

/** Directories never scanned, whatever .gitignore says. */
const ALWAYS_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  ".turbo",
]);

/** Lockfiles carry version pins, not secrets — never scanned. */
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "poetry.lock",
  "composer.lock",
  "Cargo.lock",
  "go.sum",
  "flake.lock",
]);

const GITHUB_TOKEN_RE = /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const CONNECTION_URL_RE =
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/([^:\s/]+):([^@\s/]+)@([^\s/]+)/g;

/** Known vendor prefixes for `secrets/generic-token`. */
const VENDOR_TOKEN_RE =
  /\b(?:sk-(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g;

/** `api_key = "…"`, `access_token: '…'` — key names a secret, value is long. */
const ASSIGNMENT_RE =
  /\b(api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password)\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{20,})["']?/g;

/** Values that are placeholders, not secrets. */
const PLACEHOLDER_RE =
  /^(change[-_]?me|your[-_].*|example|test|dummy|placeholder|xxx+|todo)$/i;

function maskSecret(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

interface ClaimedRange {
  start: number;
  end: number;
}

function overlapsClaimed(claimed: ClaimedRange[], start: number, end: number): boolean {
  return claimed.some((r) => start < r.end && end > r.start);
}

function isPlaceholderValue(value: string): boolean {
  if (value.includes("${") || value.includes("<") || value.includes(">")) {
    return true;
  }
  if (value.startsWith("/") || value.includes("://")) return true;
  return PLACEHOLDER_RE.test(value);
}

function checkGithubToken(
  findings: Finding[],
  claimed: ClaimedRange[],
  content: string,
  filename: string,
): void {
  for (const match of content.matchAll(GITHUB_TOKEN_RE)) {
    const value = match[0];
    claimed.push({
      start: match.index,
      end: match.index + value.length,
    });
    findings.push({
      rule: "secrets/github-token",
      severity: "error",
      file: filename,
      line: lineOf(content, match.index),
      detail: `possible GitHub token (${maskSecret(value)}) — a token committed here stays in history forever`,
      fix: "rotate the token on GitHub, remove it from the code, and load it from an environment variable or secret store",
    });
  }
}

function checkAwsKey(
  findings: Finding[],
  claimed: ClaimedRange[],
  content: string,
  filename: string,
): void {
  for (const match of content.matchAll(AWS_KEY_RE)) {
    const value = match[0];
    claimed.push({
      start: match.index,
      end: match.index + value.length,
    });
    findings.push({
      rule: "secrets/aws-key",
      severity: "error",
      file: filename,
      line: lineOf(content, match.index),
      detail: `possible AWS access key (${maskSecret(value)}) — rotate it, remove it from history`,
      fix: "deactivate the key in the AWS console, remove it from the code, and load it from an environment variable or secret store",
    });
  }
}

function checkPrivateKey(
  findings: Finding[],
  claimed: ClaimedRange[],
  content: string,
  filename: string,
): void {
  for (const match of content.matchAll(PRIVATE_KEY_RE)) {
    const value = match[0];
    claimed.push({
      start: match.index,
      end: match.index + value.length,
    });
    findings.push({
      rule: "secrets/private-key",
      severity: "error",
      file: filename,
      line: lineOf(content, match.index),
      detail: `private key block (${value}) — the key itself must never be committed`,
      fix: "generate a new key pair, remove this file from the repo and its history, and store the key in a secret store",
    });
  }
}

function checkConnectionStringPassword(
  findings: Finding[],
  claimed: ClaimedRange[],
  content: string,
  filename: string,
): void {
  for (const match of content.matchAll(CONNECTION_URL_RE)) {
    const scheme = match[1];
    const user = match[2];
    const password = match[3];
    const host = match[4];
    if (isPlaceholderValue(password)) continue;
    claimed.push({
      start: match.index,
      end: match.index + match[0].length,
    });
    findings.push({
      rule: "secrets/connection-string-password",
      severity: "error",
      file: filename,
      line: lineOf(content, match.index),
      detail: `hardcoded password in ${scheme} connection URL (${scheme}://${user}:${maskSecret(password)}@${host})`,
      fix: "remove the password from the URL and load it from an environment variable or secret store",
    });
  }
}

function checkGenericToken(
  findings: Finding[],
  claimed: ClaimedRange[],
  content: string,
  filename: string,
): void {
  for (const match of content.matchAll(VENDOR_TOKEN_RE)) {
    const value = match[0];
    if (overlapsClaimed(claimed, match.index, match.index + value.length)) {
      continue;
    }
    claimed.push({
      start: match.index,
      end: match.index + value.length,
    });
    findings.push({
      rule: "secrets/generic-token",
      severity: "warning",
      file: filename,
      line: lineOf(content, match.index),
      detail: `possible API token (${maskSecret(value)}) — looks like a vendor key, confirm it is not a live secret`,
      fix: "if it is a live secret, rotate it and load it from an environment variable or secret store",
    });
  }

  for (const match of content.matchAll(ASSIGNMENT_RE)) {
    const value = match[2];
    // A long value of letters only (a sentence fragment) or digits
    // only (a number) is not a token.
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) continue;
    if (isPlaceholderValue(value)) continue;
    const valueStart = match.index + match[0].indexOf(value);
    if (overlapsClaimed(claimed, valueStart, valueStart + value.length)) {
      continue;
    }
    claimed.push({ start: valueStart, end: valueStart + value.length });
    findings.push({
      rule: "secrets/generic-token",
      severity: "warning",
      file: filename,
      line: lineOf(content, valueStart),
      detail: `possible hardcoded ${match[1]} (${maskSecret(value)}) — looks like a live credential, confirm it is not one`,
      fix: "if it is a live secret, rotate it and load it from an environment variable or secret store",
    });
  }
}

/**
 * Runs all secrets rules against one file's contents.
 * Returns no findings for binary content (a NUL byte means it is not
 * text) or for files over MAX_SECRET_FILE_BYTES.
 */
export function checkSecrets(content: string, filename: string): Finding[] {
  if (content.length === 0) return [];
  if (content.includes("\0")) return [];
  if (Buffer.byteLength(content, "utf8") > MAX_SECRET_FILE_BYTES) return [];
  const findings: Finding[] = [];
  const claimed: ClaimedRange[] = [];

  checkGithubToken(findings, claimed, content, filename);
  checkAwsKey(findings, claimed, content, filename);
  checkPrivateKey(findings, claimed, content, filename);
  checkConnectionStringPassword(findings, claimed, content, filename);
  checkGenericToken(findings, claimed, content, filename);

  return findings;
}

// ---------------------------------------------------------------------------
// Repo tree walk (respects .gitignore, skips lockfiles and tool dirs)
// ---------------------------------------------------------------------------

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

/** Converts one .gitignore pattern to a regex (subset of git semantics). */
function patternToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\.+^${}()|[]".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern.length === 0) continue;
    // A pattern with a slash (other than the trailing one) is anchored
    // to the repo root; without one it matches a name at any depth.
    const anchored = pattern.includes("/");
    rules.push({
      negated,
      dirOnly,
      anchored,
      regex: patternToRegex(pattern),
    });
  }
  return rules;
}

function matchPath(rule: IgnoreRule, path: string): boolean {
  if (rule.anchored) return rule.regex.test(path);
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    if (rule.regex.test(segments.slice(i).join("/"))) return true;
  }
  return false;
}

function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) {
      // A file is ignored by a dir-only pattern when any ancestor
      // directory matches it.
      const segments = relPath.split("/");
      for (let i = 1; i < segments.length; i++) {
        if (matchPath(rule, segments.slice(0, i).join("/"))) {
          ignored = !rule.negated;
        }
      }
      continue;
    }
    if (matchPath(rule, relPath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Lists the files the secrets check scans, as absolute paths, in
 * deterministic order. Respects the repo-root `.gitignore` (only the
 * root one in v1 — nested .gitignore files are not read), skips the
 * always-excluded tool directories and lockfiles. The caller reads the
 * files and applies the binary/size gates in `checkSecrets`.
 */
export function collectSecretFiles(targetDir: string): string[] {
  const ignorePath = join(targetDir, ".gitignore");
  let rules: IgnoreRule[] = [];
  if (existsSync(ignorePath)) {
    try {
      rules = parseGitignore(readFileSync(ignorePath, "utf8"));
    } catch {
      // An unreadable .gitignore is treated as no .gitignore.
      rules = [];
    }
  }

  const found: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(targetDir, abs));
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (isIgnored(rules, rel, true)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (LOCKFILE_NAMES.has(entry.name)) continue;
        if (isIgnored(rules, rel, false)) continue;
        found.push(abs);
      }
    }
  };
  walk(targetDir);
  return found;
}
