import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Finding, Severity } from "../types.js";

/**
 * Dependency-vulnerability rules (spec §3C). npm ecosystem only in
 * v1; Python (pip) and others are v2 candidates.
 *
 * Flow: read the repo's lockfiles, collect the pinned name@version
 * pairs, ask the public OSV API (api.osv.dev, free, no key) in
 * batches, and turn each reported vulnerability into one Finding.
 *
 * Two-step OSV flow (this is how the API actually works — verified
 * against the live API 2026-11-13): the querybatch endpoint returns
 * only minimal records (`id` + `modified`). Full records — CVSS
 * severity, affected ranges, the fixed version — come from a second
 * call, `GET /v1/vulns/{id}`, one per vulnerability. So queryOsv
 * first collects the ids per dependency, then fetches the details.
 * A querybatch-only implementation would report every vulnerability
 * as "unknown severity, no fix" — that bug was caught by the live
 * smoke test, not by the stubbed tests.
 *
 * Severity choices (the spec example shows the lodash GHSA as a
 * warning, but it does not state a rule; simplest defensible reading,
 * following the CVSS score OSV reports):
 * - error: CVSS critical (>= 9.0) or high (>= 7.0). A known
 *   high-severity hole in a pinned dependency fails the CI.
 * - warning: medium (>= 4.0), low, or unknown severity (no score
 *   anywhere in the OSV record). It still shows up, it just does not
 *   block the pipeline on its own.
 *
 * What is deliberately NOT here:
 * - No silent pass on a network failure. If OSV cannot be reached,
 *   or answers with a non-2xx status, checkDeps throws and the
 *   runner turns that into exit 2. Reporting "no vulnerabilities"
 *   when the check never ran would be lying.
 * - No lockfile at all means one warning (`deps/no-lockfile`), never
 *   an error and never a crash — without pinned versions nothing can
 *   be asserted either way (spec §3C).
 *
 * Retry policy (added 2026-11-13, before v1 0.1.0 — dogfooding
 * showed the OSV calls failing on big repos over a slow/proxied
 * link): every OSV request (querybatch and each /vulns/{id} detail
 * fetch) is retried up to 2 times (3 attempts total) with
 * exponential backoff (~1s, then ~2s), but ONLY for transient
 * failures — a fetch that throws (network error, timeout) or an
 * HTTP 429 / 5xx answer. Any other 4xx, or a malformed/unreadable
 * response, fails immediately with no retry. After the retries are
 * exhausted the fail-loudly rule above still applies: throw, exit 2,
 * never a silent "all clear". Each retry is reported on stderr so a
 * CI log shows the check waited for the network instead of passing
 * blindly. The backoff sleeps are injectable (RetryOptions.sleep)
 * so tests can run them instantly.
 */

export const OSV_API_BASE = "https://api.osv.dev/v1";
export const OSV_API_URL = `${OSV_API_BASE}/querybatch`;

/** Queries per OSV request — the API takes a batch, keep it bounded. */
const OSV_BATCH_SIZE = 100;

/** Detail fetches in flight at once (one per vuln id). */
const OSV_DETAIL_CONCURRENCY = 10;

/** Give up on a batch rather than hanging the CI run forever. 30s,
 * not 15s: the live smoke test showed a request taking over 15s on
 * a slow link, and the tool will run from Cuba — a tight timeout
 * would flake the check exactly where it is needed most. */
const OSV_TIMEOUT_MS = 30_000;

/** Retries per OSV request on transient failure (3 attempts total). */
const OSV_MAX_RETRIES = 2;

/** Backoff between attempts: ~1s after the 1st failure, ~2s after the 2nd. */
const OSV_RETRY_DELAYS_MS = [1000, 2000];

export type SleepFn = (ms: number) => Promise<void>;

const sleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryNotice {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Total attempts that will be made for this request. */
  attempts: number;
  reason: string;
  delayMs: number;
  url: string;
}

export interface RetryOptions {
  /** Injectable sleep for the backoff — production uses real timers. */
  sleep?: SleepFn;
  /** Called before each retry. Defaults to a one-line stderr note. */
  onRetry?: (notice: RetryNotice) => void;
}

function defaultOnRetry(notice: RetryNotice): void {
  console.error(
    `pipeline-doctor: OSV request failed (${notice.reason}) — retrying in ${notice.delayMs}ms (attempt ${notice.attempt + 1}/${notice.attempts})`,
  );
}

/** HTTP statuses worth retrying: rate-limited or a server-side blip. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * One OSV request with retry on transient failure only. A fresh
 * timeout signal is created per attempt — reusing the first
 * attempt's signal would abort the retry immediately after a
 * timeout. Returns the final response even when it is a retryable
 * status after the retries are exhausted (the caller reports the
 * HTTP failure); throws the original error when the fetch itself
 * keeps failing. Non-retryable answers (other 4xx) return at once.
 */
async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const sleepFn = opts.sleep ?? sleep;
  const notify = opts.onRetry ?? defaultOnRetry;
  const total = OSV_MAX_RETRIES + 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= total; attempt++) {
    let response: Response;
    try {
      response = await fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (attempt < total) {
        const delayMs = OSV_RETRY_DELAYS_MS[attempt - 1] ?? 2000;
        notify({
          attempt,
          attempts: total,
          reason: error instanceof Error ? error.message : String(error),
          delayMs,
          url,
        });
        await sleepFn(delayMs);
        continue;
      }
      throw error;
    }
    if (response.ok || !isRetryableStatus(response.status)) {
      return response;
    }
    lastError = new Error(`HTTP ${response.status}`);
    if (attempt < total) {
      const delayMs = OSV_RETRY_DELAYS_MS[attempt - 1] ?? 2000;
      notify({
        attempt,
        attempts: total,
        reason: `HTTP ${response.status}`,
        delayMs,
        url,
      });
      await sleepFn(delayMs);
      continue;
    }
    return response;
  }
  // Unreachable — the loop always returns or throws — but keeps TS honest.
  throw lastError;
}

export interface LockedDep {
  name: string;
  version: string;
  /** Repo-relative lockfile path, e.g. `package-lock.json`. */
  file: string;
  /** Line where the package appears in the lockfile (1 if unknown). */
  line: number;
}

type FetchFn = typeof fetch;

interface OsvSeverityEntry {
  type?: unknown;
  score?: unknown;
}

interface OsvRangeEvent {
  introduced?: unknown;
  fixed?: unknown;
}

interface OsvRange {
  type?: unknown;
  events?: unknown;
}

interface OsvVuln {
  id?: unknown;
  aliases?: unknown;
  summary?: unknown;
  severity?: unknown;
  database_specific?: unknown;
  affected?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Line (1-based) of the first line matching `pattern`, or 1. */
function findLine(lines: string[], pattern: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] as string)) return i + 1;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Lockfile parsing (pure functions of the lockfile text)
// ---------------------------------------------------------------------------

function parsePackageLockPackages(
  deps: LockedDep[],
  seen: Set<string>,
  packages: Record<string, unknown>,
  lines: string[],
  filename: string,
): void {
  for (const [key, value] of Object.entries(packages)) {
    if (!isRecord(value)) continue;
    if (typeof value.version !== "string") continue;
    // `packages` keys look like `node_modules/lodash` or
    // `node_modules/@scope/name`; the root "" entry has no version.
    const segments = key.split("node_modules/").filter((s) => s.length > 0);
    const name = segments.length > 0 ? (segments[segments.length - 1] as string) : "";
    if (name.length === 0) continue;
    const version = value.version;
    const dedupKey = `${filename}\0${name}@${version}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    deps.push({
      name,
      version,
      file: filename,
      line: findLine(
        lines,
        new RegExp(`"${escapeRegExp(key)}"\\s*:`),
      ),
    });
  }
}

function parsePackageLockDependencies(
  deps: LockedDep[],
  seen: Set<string>,
  dependencies: Record<string, unknown>,
  lines: string[],
  filename: string,
): void {
  for (const [name, value] of Object.entries(dependencies)) {
    if (!isRecord(value)) continue;
    if (typeof value.version === "string") {
      const version = value.version;
      const dedupKey = `${filename}\0${name}@${version}`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        deps.push({
          name,
          version,
          file: filename,
          // v1 lockfiles nest `dependencies` — the first `"name": {`
          // whose following lines carry this version is the entry.
          line: findVersionedEntryLine(lines, name, version),
        });
      }
    }
    if (isRecord(value.dependencies)) {
      parsePackageLockDependencies(deps, seen, value.dependencies, lines, filename);
    }
  }
}

/** Line of `"name": {` followed within 3 lines by `"version": "v"`. */
function findVersionedEntryLine(
  lines: string[],
  name: string,
  version: string,
): number {
  const nameRe = new RegExp(`^\\s*"${escapeRegExp(name)}"\\s*:\\s*\\{`);
  const versionRe = new RegExp(
    `"version"\\s*:\\s*"${escapeRegExp(version)}"`,
  );
  for (let i = 0; i < lines.length; i++) {
    if (!nameRe.test(lines[i] as string)) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (versionRe.test(lines[j] as string)) return i + 1;
    }
  }
  return 1;
}

/**
 * Parses package-lock.json (v1 `dependencies`, v2/v3 `packages`).
 * Returns one entry per unique pinned name@version in the file.
 * Throws on unparseable JSON — a lockfile that cannot be read cannot
 * be trusted, and the runner turns the throw into exit 2.
 */
export function parsePackageLock(content: string, filename: string): LockedDep[] {
  let data: unknown;
  try {
    data = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(
      `failed to parse ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(data)) return [];
  const lines = content.split("\n");
  const deps: LockedDep[] = [];
  const seen = new Set<string>();
  if (isRecord(data.packages)) {
    parsePackageLockPackages(deps, seen, data.packages, lines, filename);
  }
  if (isRecord(data.dependencies)) {
    parsePackageLockDependencies(deps, seen, data.dependencies, lines, filename);
  }
  return deps;
}

/**
 * Parses a pnpm lockfile key into name + version. Keys look like
 * `/lodash@4.17.20`, `/lodash@4.17.20(peer@1.0.0)` (v9) or
 * `/lodash/4.17.20` (v6 and older), and scoped like
 * `/@scope/name@1.2.3`. Returns null for keys that are not packages
 * (e.g. the `importers:` entries are never passed here).
 */
export function parsePnpmKey(key: string): { name: string; version: string } | null {
  const stripped = key.startsWith("/") ? key.slice(1) : key;
  // `name@version` — the name may be scoped (`@scope/name`).
  const atMatch = /^(?<name>@[^/]+\/[^@]+|[^@/]+)@(?<version>[^(\s]+)/.exec(stripped);
  if (atMatch?.groups !== undefined) {
    return {
      name: atMatch.groups["name"] as string,
      version: atMatch.groups["version"] as string,
    };
  }
  // Legacy `/name/version` form.
  const slashMatch = /^(?<name>.+)\/(?<version>[^/]+)$/.exec(stripped);
  if (slashMatch?.groups !== undefined) {
    return {
      name: slashMatch.groups["name"] as string,
      version: slashMatch.groups["version"] as string,
    };
  }
  return null;
}

/**
 * Parses pnpm-lock.yaml. Only the top-level `packages:` map is read
 * — `importers:` lists ranges, not pinned versions, and `snapshots:`
 * mirrors `packages:`.
 */
export function parsePnpmLock(content: string, filename: string): LockedDep[] {
  let data: unknown;
  try {
    data = parseYaml(content) as unknown;
  } catch (error) {
    throw new Error(
      `failed to parse ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(data) || !isRecord(data.packages)) return [];
  const lines = content.split("\n");
  const deps: LockedDep[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(data.packages)) {
    const parsed = parsePnpmKey(key);
    if (parsed === null) continue;
    const dedupKey = `${filename}\0${parsed.name}@${parsed.version}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    deps.push({
      name: parsed.name,
      version: parsed.version,
      file: filename,
      line: findLine(
        lines,
        new RegExp(`^\\s*['"]?${escapeRegExp(key)}['"]?\\s*:`),
      ),
    });
  }
  return deps;
}

const YARN_HEADER_RE = /^"?([^"]+)"?:\s*$/;
const YARN_VERSION_RE = /^\s+version\s+["']?([^"'\s]+)["']?\s*$/;

/**
 * Parses yarn.lock (v1 and berry). Each entry is a header line with
 * one or more `name@range` specifiers followed by an indented
 * `version "..."` line. The finding points at the header line.
 */
export function parseYarnLock(content: string, filename: string): LockedDep[] {
  const lines = content.split("\n");
  const deps: LockedDep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const header = YARN_HEADER_RE.exec(lines[i] as string);
    if (header === null) continue;
    const specs = (header[1] as string).split(/",\s*"/);
    // Look ahead for the version line of this entry block.
    let version: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.length > 0 && !/^\s/.test(line)) break;
      const versionMatch = YARN_VERSION_RE.exec(line);
      if (versionMatch !== null) {
        version = versionMatch[1] as string;
        break;
      }
    }
    if (version === null) continue;
    for (const spec of specs) {
      // `lodash@^4.17.20` (v1) or `lodash@npm:4.17.20` (berry).
      const at = spec.lastIndexOf("@");
      if (at <= 0) continue;
      const name = spec.slice(0, at);
      const dedupKey = `${filename}\0${name}@${version}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      deps.push({ name, version, file: filename, line: i + 1 });
    }
  }
  return deps;
}

// ---------------------------------------------------------------------------
// OSV client
// ---------------------------------------------------------------------------

type CvssLabel = "critical" | "high" | "medium" | "low" | "unknown";

function cvssLabel(score: number): CvssLabel {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "unknown";
}

function severityOfLabel(label: CvssLabel): Severity {
  return label === "critical" || label === "high" ? "error" : "warning";
}

/** Best CVSS score in the record, preferring v4 > v3 > v2. */
function bestCvssScore(vuln: OsvVuln): number | null {
  if (!Array.isArray(vuln.severity)) return null;
  const order: Record<string, number> = { CVSS_V4: 0, CVSS_V3: 1, CVSS_V2: 2 };
  let best: { rank: number; score: number } | null = null;
  for (const entry of vuln.severity as OsvSeverityEntry[]) {
    if (!isRecord(entry)) continue;
    if (typeof entry.score !== "string") continue;
    const score = Number(entry.score);
    if (!Number.isFinite(score)) continue;
    const rank = typeof entry.type === "string" ? (order[entry.type] ?? 3) : 3;
    if (best === null || rank < best.rank) best = { rank, score };
  }
  return best === null ? null : best.score;
}

function databaseSpecificLabel(vuln: OsvVuln): CvssLabel | null {
  if (!isRecord(vuln.database_specific)) return null;
  const raw = vuln.database_specific["severity"];
  if (typeof raw !== "string") return null;
  switch (raw.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return null;
  }
}

/**
 * First `fixed` version in the affected ranges. Prefers the range
 * entry for the queried package itself — a record lists several
 * packages (lodash, lodash-es, ...) and their fixed versions can
 * differ. Falls back to the first fixed version found anywhere.
 */
function fixedVersion(vuln: OsvVuln, packageName: string): string | null {
  if (!Array.isArray(vuln.affected)) return null;
  const entries = vuln.affected as unknown[];
  const scan = (entry: unknown): string | null => {
    if (!isRecord(entry) || !Array.isArray(entry["ranges"])) return null;
    for (const range of entry["ranges"] as OsvRange[]) {
      if (!isRecord(range) || !Array.isArray(range.events)) continue;
      for (const event of range.events as OsvRangeEvent[]) {
        if (isRecord(event) && typeof event["fixed"] === "string") {
          return event["fixed"] as string;
        }
      }
    }
    return null;
  };
  for (const entry of entries) {
    if (
      isRecord(entry) &&
      isRecord(entry["package"]) &&
      entry["package"]["name"] === packageName
    ) {
      const fixed = scan(entry);
      if (fixed !== null) return fixed;
    }
  }
  for (const entry of entries) {
    const fixed = scan(entry);
    if (fixed !== null) return fixed;
  }
  return null;
}

function vulnLabel(vuln: OsvVuln): { label: CvssLabel; score: number | null } {
  const score = bestCvssScore(vuln);
  if (score !== null) return { label: cvssLabel(score), score };
  const fallback = databaseSpecificLabel(vuln);
  if (fallback !== null) return { label: fallback, score: null };
  return { label: "unknown", score: null };
}

function vulnId(vuln: OsvVuln): string | null {
  return typeof vuln.id === "string" && vuln.id.length > 0 ? vuln.id : null;
}

/**
 * Fetches the full record for one vulnerability id. The querybatch
 * endpoint only returns `{id, modified}` — severity, affected ranges
 * and the fixed version live here. Retried on transient failure
 * (see the retry policy in the file header).
 */
async function fetchVulnDetail(
  id: string,
  fetchFn: FetchFn,
  opts: RetryOptions = {},
): Promise<OsvVuln> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      fetchFn,
      `${OSV_API_BASE}/vulns/${encodeURIComponent(id)}`,
      {},
      opts,
    );
  } catch (error) {
    throw new Error(
      `OSV API request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `OSV API request failed: HTTP ${response.status} (vuln ${id})`,
    );
  }
  let data: unknown;
  try {
    data = (await response.json()) as unknown;
  } catch (error) {
    throw new Error(
      `OSV API returned an unreadable response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(data)) {
    throw new Error("OSV API returned an unexpected response shape");
  }
  return data;
}

/**
 * Queries OSV for a batch of pinned dependencies. `fetchFn` is
 * injectable so tests can stub the network; production passes the
 * global fetch. Throws on network failure or a non-2xx answer —
 * never returns an empty "all clear" for a check that did not run.
 *
 * Two steps: querybatch returns minimal records (id only); the full
 * record for each unique id is then fetched from /vulns/{id}.
 */
export async function queryOsv(
  deps: { name: string; version: string }[],
  fetchFn: FetchFn = fetch,
  retryOpts: RetryOptions = {},
): Promise<Map<string, OsvVuln[]>> {
  const idsByDep = new Map<string, string[]>();
  for (let start = 0; start < deps.length; start += OSV_BATCH_SIZE) {
    const batch = deps.slice(start, start + OSV_BATCH_SIZE);
    const body = {
      queries: batch.map((dep) => ({
        package: { name: dep.name, ecosystem: "npm" },
        version: dep.version,
      })),
    };
    let response: Response;
    try {
      response = await fetchWithRetry(
        fetchFn,
        OSV_API_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        retryOpts,
      );
    } catch (error) {
      throw new Error(
        `OSV API request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new Error(`OSV API request failed: HTTP ${response.status}`);
    }
    let data: unknown;
    try {
      data = (await response.json()) as unknown;
    } catch (error) {
      throw new Error(
        `OSV API returned an unreadable response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(data) || !Array.isArray(data.results)) {
      throw new Error("OSV API returned an unexpected response shape");
    }
    const results = data.results as unknown[];
    batch.forEach((dep, index) => {
      const result = results[index];
      const ids: string[] = [];
      if (isRecord(result) && Array.isArray(result["vulns"])) {
        for (const vuln of result["vulns"] as unknown[]) {
          if (isRecord(vuln) && typeof vuln["id"] === "string") {
            ids.push(vuln["id"] as string);
          }
        }
      }
      idsByDep.set(`${dep.name}@${dep.version}`, ids);
    });
  }

  // Full records, one fetch per unique id (deduped across deps).
  const uniqueIds = [...new Set([...idsByDep.values()].flat())];
  const detailsById = new Map<string, OsvVuln>();
  for (let start = 0; start < uniqueIds.length; start += OSV_DETAIL_CONCURRENCY) {
    const chunk = uniqueIds.slice(start, start + OSV_DETAIL_CONCURRENCY);
    const details = await Promise.all(
      chunk.map(async (id) => ({
        id,
        record: await fetchVulnDetail(id, fetchFn, retryOpts),
      })),
    );
    for (const { id, record } of details) detailsById.set(id, record);
  }

  const byKey = new Map<string, OsvVuln[]>();
  for (const [key, ids] of idsByDep) {
    byKey.set(
      key,
      ids
        .map((id) => detailsById.get(id))
        .filter((record): record is OsvVuln => record !== undefined),
    );
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// Lockfile discovery + the check itself
// ---------------------------------------------------------------------------

const LOCKFILES = [
  { name: "package-lock.json", parse: parsePackageLock },
  { name: "pnpm-lock.yaml", parse: parsePnpmLock },
  { name: "yarn.lock", parse: parseYarnLock },
] as const;

export interface DepsCheckResult {
  findings: Finding[];
  /** Unique pinned name@version pairs actually sent to OSV. */
  depsChecked: number;
}

/**
 * Runs the deps family against one repo directory. Async — it calls
 * the OSV API over the network. `retryOpts` (sleep/onRetry) is
 * injectable for tests; production uses real backoff timers and
 * reports each retry on stderr.
 */
export async function checkDeps(
  targetDir: string,
  fetchFn: FetchFn = fetch,
  retryOpts: RetryOptions = {},
): Promise<DepsCheckResult> {
  const allDeps: LockedDep[] = [];
  let lockfileFound = false;
  for (const lockfile of LOCKFILES) {
    const path = join(targetDir, lockfile.name);
    if (!existsSync(path)) continue;
    lockfileFound = true;
    const content = readFileSync(path, "utf8");
    allDeps.push(...lockfile.parse(content, lockfile.name));
  }

  if (!lockfileFound) {
    // No lockfile at all: say so, once, as a warning. Without pinned
    // versions nothing can be asserted — but silence would imply the
    // deps were checked and clean.
    const manifest = join(targetDir, "package.json");
    return {
      findings: [
        {
          rule: "deps/no-lockfile",
          severity: "warning",
          file: existsSync(manifest) ? "package.json" : ".",
          line: 1,
          detail:
            "no lockfile found (package-lock.json, pnpm-lock.yaml or yarn.lock) — dependencies are not pinned, so no version can be checked against OSV",
          fix: "commit a lockfile (npm install / pnpm install / yarn install) so pinned versions exist to check",
        },
      ],
      depsChecked: 0,
    };
  }

  // One OSV query per unique name@version; findings stay per lockfile.
  const unique = new Map<string, { name: string; version: string }>();
  for (const dep of allDeps) {
    unique.set(`${dep.name}@${dep.version}`, {
      name: dep.name,
      version: dep.version,
    });
  }
  const vulnsByDep = await queryOsv([...unique.values()], fetchFn, retryOpts);

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const dep of allDeps) {
    const vulns = vulnsByDep.get(`${dep.name}@${dep.version}`) ?? [];
    for (const vuln of vulns) {
      const id = vulnId(vuln);
      if (id === null) continue;
      const dedupKey = `${dep.file}\0${dep.name}@${dep.version}\0${id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const { label, score } = vulnLabel(vuln);
      const fixed = fixedVersion(vuln, dep.name);
      const aliases = Array.isArray(vuln.aliases)
        ? (vuln.aliases as unknown[]).filter(
            (a): a is string => typeof a === "string" && a.startsWith("CVE-"),
          )
        : [];
      const idText = aliases.length > 0 ? `${id} (${aliases.join(", ")})` : id;
      findings.push({
        rule: "deps/vulnerability",
        severity: severityOfLabel(label),
        file: dep.file,
        line: dep.line,
        detail: `${idText} (${label}${score !== null ? `, CVSS ${score}` : ""}) — ${dep.name}@${dep.version} is affected`,
        fix:
          fixed !== null
            ? `upgrade ${dep.name} to ${fixed} or later`
            : `no fixed version published yet — check the ${id} advisory before shipping`,
      });
    }
  }

  return { findings, depsChecked: unique.size };
}
