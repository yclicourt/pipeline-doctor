/**
 * Deploy credentials (0.2.0, decision 01).
 *
 * Read-only credentials come from environment variables ONLY — never
 * from pipeline-doctor.yml, never from the repo. Every value here is
 * a token or a URL; the CLI never prints them (findings carry only
 * the rule and the reason a check was skipped).
 *
 * Backends and what they feed:
 * - DATABASE_URL ................. Postgres (DEP-06 SELECT 1, DEP-08
 *   pending migrations, DEP-11 disk via pg_database_size)
 * - PIPELINE_DOCTOR_HARBOR_URL ... Harbor registry API (CI-02 digest
 *   vs Harbor, DEP-02 image size)
 * - PIPELINE_DOCTOR_HARBOR_USER .. Harbor robot-account username
 *   (robot$project+name); the token is its password (HTTP Basic)
 * - PIPELINE_DOCTOR_HARBOR_TOKEN . Harbor robot-account token
 * - PIPELINE_DOCTOR_ARGOCD_URL ... ArgoCD API (DEP-03 sync/health,
 *   DEP-07 drift)
 * - PIPELINE_DOCTOR_ARGOCD_TOKEN . ArgoCD API token
 * - PIPELINE_DOCTOR_K8S_API_URL .. Kubernetes API (DEP-01 digest in
 *   k3s, DEP-04 rollout, DEP-09 endpoints, DEP-10 restarts)
 * - PIPELINE_DOCTOR_K8S_TOKEN .... Kubernetes bearer token (read-only
 *   ServiceAccount)
 * - PIPELINE_DOCTOR_APP_URL ...... the deployed app (CI-06 security
 *   headers, DEP-05 HTTP/TLS, DEP-12 end-to-end probe)
 * - PIPELINE_DOCTOR_APP_USER ..... probe login username (DEP-12,
 *   only when the probe has a login step)
 * - PIPELINE_DOCTOR_APP_PASSWORD . probe login password (DEP-12,
 *   only when the probe has a login step)
 * - GITHUB_TOKEN ................. GitHub API (CI-07 last run
 *   all-green); the standard name — Actions runners provide it
 *
 * A backend is "configured" only when ALL its variables are present
 * and non-empty. Anything else is reported as skipped with the exact
 * missing variable named — never a silent pass.
 */

export interface DeployEnv {
  databaseUrl?: string;
  harborUrl?: string;
  harborUser?: string;
  harborToken?: string;
  argocdUrl?: string;
  argocdToken?: string;
  k8sApiUrl?: string;
  k8sToken?: string;
  appUrl?: string;
  appUser?: string;
  appPassword?: string;
  githubToken?: string;
}

export type DeployBackend =
  | "database"
  | "harbor"
  | "argocd"
  | "k8s"
  | "app";

/** The env variables each backend needs. */
export const BACKEND_ENV_VARS: Record<DeployBackend, string[]> = {
  database: ["DATABASE_URL"],
  harbor: [
    "PIPELINE_DOCTOR_HARBOR_URL",
    "PIPELINE_DOCTOR_HARBOR_USER",
    "PIPELINE_DOCTOR_HARBOR_TOKEN",
  ],
  argocd: ["PIPELINE_DOCTOR_ARGOCD_URL", "PIPELINE_DOCTOR_ARGOCD_TOKEN"],
  k8s: ["PIPELINE_DOCTOR_K8S_API_URL", "PIPELINE_DOCTOR_K8S_TOKEN"],
  app: ["PIPELINE_DOCTOR_APP_URL"],
};

function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** Reads the deploy environment. `env` is injectable for tests. */
export function readDeployEnv(env: NodeJS.ProcessEnv = process.env): DeployEnv {
  return {
    databaseUrl: readVar(env, "DATABASE_URL"),
    harborUrl: readVar(env, "PIPELINE_DOCTOR_HARBOR_URL"),
    harborUser: readVar(env, "PIPELINE_DOCTOR_HARBOR_USER"),
    harborToken: readVar(env, "PIPELINE_DOCTOR_HARBOR_TOKEN"),
    argocdUrl: readVar(env, "PIPELINE_DOCTOR_ARGOCD_URL"),
    argocdToken: readVar(env, "PIPELINE_DOCTOR_ARGOCD_TOKEN"),
    k8sApiUrl: readVar(env, "PIPELINE_DOCTOR_K8S_API_URL"),
    k8sToken: readVar(env, "PIPELINE_DOCTOR_K8S_TOKEN"),
    appUrl: readVar(env, "PIPELINE_DOCTOR_APP_URL"),
    appUser: readVar(env, "PIPELINE_DOCTOR_APP_USER"),
    appPassword: readVar(env, "PIPELINE_DOCTOR_APP_PASSWORD"),
    githubToken: readVar(env, "GITHUB_TOKEN"),
  };
}

/**
 * Backends that are NOT fully configured. A check that needs one of
 * these must report itself as skipped, naming the missing variables.
 */
export function missingBackends(env: DeployEnv): DeployBackend[] {
  const missing: DeployBackend[] = [];
  if (env.databaseUrl === undefined) missing.push("database");
  if (
    env.harborUrl === undefined ||
    env.harborUser === undefined ||
    env.harborToken === undefined
  ) {
    missing.push("harbor");
  }
  if (env.argocdUrl === undefined || env.argocdToken === undefined) {
    missing.push("argocd");
  }
  if (env.k8sApiUrl === undefined || env.k8sToken === undefined) {
    missing.push("k8s");
  }
  if (env.appUrl === undefined) missing.push("app");
  return missing;
}

/** Human-readable reason for a skipped check: which vars are missing. */
export function missingVarsReason(backend: DeployBackend): string {
  return `missing ${BACKEND_ENV_VARS[backend].join(" and ")}`;
}
