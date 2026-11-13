import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { CheckFamily } from "./types.js";

export const CONFIG_FILENAME = "pipeline-doctor.yml";

export interface IgnoreEntry {
  rule: string;
  path: string;
  reason: string;
}

export interface PipelineDoctorConfig {
  failOn: "error" | "warning";
  ignore: IgnoreEntry[];
  checks: Record<CheckFamily, boolean>;
}

export const DEFAULT_CONFIG: PipelineDoctorConfig = {
  failOn: "error",
  ignore: [],
  checks: {
    workflow: true,
    secrets: true,
    deps: true,
    hygiene: true,
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads pipeline-doctor.yml from `dir` when it exists.
 * No file = defaults. Anything malformed throws ConfigError (exit 2).
 * Per the spec, every `ignore` entry MUST carry a `reason`.
 */
export function loadConfig(dir: string): PipelineDoctorConfig {
  const path = join(dir, CONFIG_FILENAME);
  if (!existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `invalid YAML in ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // An empty file means defaults.
  if (raw === null || raw === undefined) {
    return structuredClone(DEFAULT_CONFIG);
  }
  if (!isRecord(raw)) {
    throw new ConfigError(
      `${CONFIG_FILENAME} must contain a YAML mapping at the top level`,
    );
  }

  const config = structuredClone(DEFAULT_CONFIG);

  if (raw.failOn !== undefined) {
    if (raw.failOn !== "error" && raw.failOn !== "warning") {
      throw new ConfigError(
        `${CONFIG_FILENAME}: failOn must be "error" or "warning", got ${JSON.stringify(raw.failOn)}`,
      );
    }
    config.failOn = raw.failOn;
  }

  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore)) {
      throw new ConfigError(`${CONFIG_FILENAME}: ignore must be a list`);
    }
    config.ignore = raw.ignore.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new ConfigError(
          `${CONFIG_FILENAME}: ignore[${index}] must be a mapping with rule, path and reason`,
        );
      }
      if (typeof entry.rule !== "string" || entry.rule.length === 0) {
        throw new ConfigError(
          `${CONFIG_FILENAME}: ignore[${index}] is missing a non-empty "rule"`,
        );
      }
      if (typeof entry.path !== "string" || entry.path.length === 0) {
        throw new ConfigError(
          `${CONFIG_FILENAME}: ignore[${index}] is missing a non-empty "path"`,
        );
      }
      if (typeof entry.reason !== "string" || entry.reason.length === 0) {
        throw new ConfigError(
          `${CONFIG_FILENAME}: ignore[${index}] for rule "${entry.rule}" is missing a "reason" — a silence without justification is a hole nobody reviews`,
        );
      }
      return {
        rule: entry.rule,
        path: entry.path,
        reason: entry.reason,
      };
    });
  }

  if (raw.checks !== undefined) {
    if (!isRecord(raw.checks)) {
      throw new ConfigError(`${CONFIG_FILENAME}: checks must be a mapping`);
    }
    for (const [family, value] of Object.entries(raw.checks)) {
      if (!["workflow", "secrets", "deps", "hygiene"].includes(family)) {
        throw new ConfigError(
          `${CONFIG_FILENAME}: unknown check family "${family}" (expected workflow, secrets, deps, hygiene)`,
        );
      }
      if (typeof value !== "boolean") {
        throw new ConfigError(
          `${CONFIG_FILENAME}: checks.${family} must be true or false`,
        );
      }
      config.checks[family as CheckFamily] = value;
    }
  }

  return config;
}

/** The example config `init` writes, matching spec §3. */
export const EXAMPLE_CONFIG = `# pipeline-doctor.yml — example
# Fail the CI on "error" findings only. Set to "warning" to fail on warnings too.
failOn: error            # error | warning
# Silenced findings. Every entry MUST carry a "reason":
# a silence without justification is a hole nobody reviews.
ignore:
  - rule: workflow/unpinned-action
    path: .github/workflows/release.yml
    reason: "internal action, pinned by its own tag"
# Toggle check families on or off. All are on by default.
checks:
  workflow: true
  secrets: true
  deps: true
  hygiene: true
`;
