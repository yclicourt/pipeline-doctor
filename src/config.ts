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

export interface DeployBudgets {
  /** Max image size (MB) for a frontend image. Default 75. */
  frontendMb: number;
  /** Max image size (MB) for a backend image. Default 250. */
  backendMb: number;
  /** Max image size (MB) when the image role is unknown. Default 300. */
  genericMb: number;
}

/**
 * The end-to-end probe (DEP-12). Paths are relative to
 * PIPELINE_DOCTOR_APP_URL; "{id}" in read/delete is replaced with
 * the id the create step returned.
 *
 * The DEFAULTS describe a plain DRF-style CRUD API with no login
 * (the tasks-app reference pipeline): POST /tasks/ with a title,
 * GET /tasks/{id}/, DELETE /tasks/{id}/. An API with auth adds a
 * `login:` step — its credentials come from PIPELINE_DOCTOR_APP_USER
 * and PIPELINE_DOCTOR_APP_PASSWORD, never from this file.
 */
export interface ProbeLoginConfig {
  path: string;
  usernameField: string;
  passwordField: string;
  /** Response field holding the token ("token", "access", ...). */
  tokenField: string;
  /** Authorization scheme. Default "Bearer". */
  tokenScheme: string;
}

export interface ProbeCreateConfig {
  path: string;
  body: Record<string, unknown>;
  /** Response field holding the created id. Default "id". */
  idField: string;
}

export interface ProbeStepConfig {
  path: string;
}

export interface ProbeConfig {
  login?: ProbeLoginConfig;
  create: ProbeCreateConfig;
  read: ProbeStepConfig;
  delete: ProbeStepConfig;
}

export const DEFAULT_PROBE: ProbeConfig = {
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
};

export interface DeployConfig {
  /**
   * Repo-only mode: no cluster access. The four cluster-dependent
   * deploy checks (DEP-01 digest in k3s, DEP-04 rollout, DEP-09
   * endpoints, DEP-10 restarts) are reported as skipped, never as
   * failures. Also settable per run with --repo-only.
   */
  repoOnly: boolean;
  budgets: DeployBudgets;
  probe: ProbeConfig;
}

export interface PipelineDoctorConfig {
  failOn: "error" | "warning";
  ignore: IgnoreEntry[];
  checks: Record<CheckFamily, boolean>;
  deploy: DeployConfig;
}

export const DEFAULT_DEPLOY_BUDGETS: DeployBudgets = {
  frontendMb: 75,
  backendMb: 250,
  genericMb: 300,
};

export const DEFAULT_CONFIG: PipelineDoctorConfig = {
  failOn: "error",
  ignore: [],
  checks: {
    workflow: true,
    secrets: true,
    deps: true,
    hygiene: true,
    ci: true,
    deploy: true,
  },
  deploy: {
    repoOnly: false,
    budgets: { ...DEFAULT_DEPLOY_BUDGETS },
    probe: structuredClone(DEFAULT_PROBE),
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
      if (
        !["workflow", "secrets", "deps", "hygiene", "ci", "deploy"].includes(
          family,
        )
      ) {
        throw new ConfigError(
          `${CONFIG_FILENAME}: unknown check family "${family}" (expected workflow, secrets, deps, hygiene, ci, deploy)`,
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

  if (raw.deploy !== undefined) {
    if (!isRecord(raw.deploy)) {
      throw new ConfigError(`${CONFIG_FILENAME}: deploy must be a mapping`);
    }
    if (raw.deploy.repoOnly !== undefined) {
      if (typeof raw.deploy.repoOnly !== "boolean") {
        throw new ConfigError(
          `${CONFIG_FILENAME}: deploy.repoOnly must be true or false`,
        );
      }
      config.deploy.repoOnly = raw.deploy.repoOnly;
    }
    if (raw.deploy.budgets !== undefined) {
      if (!isRecord(raw.deploy.budgets)) {
        throw new ConfigError(
          `${CONFIG_FILENAME}: deploy.budgets must be a mapping`,
        );
      }
      for (const [key, value] of Object.entries(raw.deploy.budgets)) {
        if (!["frontendMb", "backendMb", "genericMb"].includes(key)) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: unknown deploy budget "${key}" (expected frontendMb, backendMb, genericMb)`,
          );
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: deploy.budgets.${key} must be a positive number (MB)`,
          );
        }
        config.deploy.budgets[key as keyof DeployBudgets] = value;
      }
    }
    if (raw.deploy.probe !== undefined) {
      if (!isRecord(raw.deploy.probe)) {
        throw new ConfigError(
          `${CONFIG_FILENAME}: deploy.probe must be a mapping`,
        );
      }
      for (const key of Object.keys(raw.deploy.probe)) {
        if (!["login", "create", "read", "delete"].includes(key)) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: unknown deploy probe step "${key}" (expected login, create, read, delete)`,
          );
        }
      }
      const probe = raw.deploy.probe;
      if (probe.login !== undefined) {
        if (!isRecord(probe.login)) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: deploy.probe.login must be a mapping`,
          );
        }
        for (const field of [
          "path",
          "usernameField",
          "passwordField",
          "tokenField",
        ]) {
          if (
            typeof probe.login[field] !== "string" ||
            (probe.login[field] as string).length === 0
          ) {
            throw new ConfigError(
              `${CONFIG_FILENAME}: deploy.probe.login.${field} must be a non-empty string`,
            );
          }
        }
        if (
          probe.login.tokenScheme !== undefined &&
          typeof probe.login.tokenScheme !== "string"
        ) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: deploy.probe.login.tokenScheme must be a string`,
          );
        }
        config.deploy.probe.login = {
          path: probe.login.path as string,
          usernameField: probe.login.usernameField as string,
          passwordField: probe.login.passwordField as string,
          tokenField: probe.login.tokenField as string,
          tokenScheme: (probe.login.tokenScheme as string | undefined) ?? "Bearer",
        };
      }
      if (probe.create !== undefined) {
        if (!isRecord(probe.create)) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: deploy.probe.create must be a mapping`,
          );
        }
        if (
          probe.create.path !== undefined &&
          typeof probe.create.path !== "string"
        ) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: deploy.probe.create.path must be a string`,
          );
        }
        if (
          probe.create.body !== undefined &&
          !isRecord(probe.create.body)
        ) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: deploy.probe.create.body must be a mapping`,
          );
        }
        if (
          probe.create.idField !== undefined &&
          typeof probe.create.idField !== "string"
        ) {
          throw new ConfigError(
            `${CONFIG_FILENAME}: deploy.probe.create.idField must be a string`,
          );
        }
        config.deploy.probe.create = {
          path: (probe.create.path as string | undefined) ?? DEFAULT_PROBE.create.path,
          body: (probe.create.body as Record<string, unknown> | undefined) ??
            structuredClone(DEFAULT_PROBE.create.body),
          idField: (probe.create.idField as string | undefined) ?? "id",
        };
      }
      for (const step of ["read", "delete"] as const) {
        if (probe[step] !== undefined) {
          if (!isRecord(probe[step])) {
            throw new ConfigError(
              `${CONFIG_FILENAME}: deploy.probe.${step} must be a mapping`,
            );
          }
          if (
            probe[step].path !== undefined &&
            typeof probe[step].path !== "string"
          ) {
            throw new ConfigError(
              `${CONFIG_FILENAME}: deploy.probe.${step}.path must be a string`,
            );
          }
          config.deploy.probe[step] = {
            path:
              (probe[step].path as string | undefined) ??
              DEFAULT_PROBE[step].path,
          };
        }
      }
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
  ci: true
  deploy: true
# Deploy checks (0.2.0). Credentials come from environment variables only,
# never from this file: DATABASE_URL, PIPELINE_DOCTOR_HARBOR_URL,
# PIPELINE_DOCTOR_HARBOR_USER, PIPELINE_DOCTOR_HARBOR_TOKEN,
# PIPELINE_DOCTOR_ARGOCD_URL, PIPELINE_DOCTOR_ARGOCD_TOKEN,
# PIPELINE_DOCTOR_K8S_API_URL, PIPELINE_DOCTOR_K8S_TOKEN,
# PIPELINE_DOCTOR_APP_URL, GITHUB_TOKEN.
deploy:
  # repoOnly: true means no cluster access — the cluster-dependent
  # checks (DEP-01, DEP-04, DEP-09, DEP-10) are reported as skipped.
  repoOnly: false
  # Max image size in MB (DEP-02).
  budgets:
    frontendMb: 75
    backendMb: 250
    genericMb: 300
  # End-to-end probe (DEP-12). Defaults describe a plain DRF-style
  # CRUD API with no login: POST /tasks/, GET /tasks/{id}/,
  # DELETE /tasks/{id}/. Uncomment the login step for an API with
  # auth — its credentials come from PIPELINE_DOCTOR_APP_USER and
  # PIPELINE_DOCTOR_APP_PASSWORD, never from this file.
  # probe:
  #   login:
  #     path: /api/auth/login/
  #     usernameField: username
  #     passwordField: password
  #     tokenField: token
  #     tokenScheme: Bearer
  #   create:
  #     path: /tasks/
  #     body: { title: "pipeline-doctor probe" }
  #     idField: id
  #   read:
  #     path: /tasks/{id}/
  #   delete:
  #     path: /tasks/{id}/
`;
