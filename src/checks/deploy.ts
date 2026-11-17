import tls from "node:tls";
import {
  collectImageReferences,
  ciBuiltRepositories,
  parseImageRef,
  type ImageRef,
} from "./images.js";
import {
  collectManifests,
  collectDjangoMigrations,
  type ManifestSet,
} from "../manifests.js";
import { getHarborArtifact } from "../harbor.js";
import {
  getDeployment,
  getEndpoints,
  listPods,
  listEvents,
} from "../k8s.js";
import { getApplication } from "../argocd.js";
import { connectPostgres, type PgQuery } from "../pg.js";
import { missingVarsReason, type DeployEnv } from "../env.js";
import { REQUEST_TIMEOUT_MS } from "../http.js";
import type {
  DeployBudgets,
  ProbeConfig,
} from "../config.js";
import type { Finding, SkippedCheck } from "../types.js";

/**
 * Deploy family (0.2.0, Fase 2).
 *
 * Verifies that the app is actually deployed correctly — not just
 * that CI went green. Reference pipeline: tasks-app-platform-devops
 * (k3s + ArgoCD + Harbor).
 *
 *   DEP-01 digest in k3s ............... the image running in the
 *     cluster matches what git declares (digest, else tag)
 *   DEP-02 image size ................. within budget: frontend
 *     75 MB, backend 250 MB, generic 300 MB (Harbor API)
 *   DEP-03 ArgoCD Synced + Healthy ..... the app is Synced and
 *     Healthy in ArgoCD (ArgoCD API)
 *   DEP-04 rollout complete ........... the Deployment rollout
 *     finished, no stuck pods
 *   DEP-05 HTTP + TLS ................. the app answers HTTP 200
 *     and the certificate is valid and not expiring
 *   DEP-06 SELECT 1 ................... the database answers
 *     (same Postgres connection as DEP-08 and DEP-11, no kubectl)
 *   DEP-07 no drift ................... live state matches git
 *     (ArgoCD API, per resource)
 *   DEP-08 pending migrations ......... django_migrations in the
 *     DB matches the migrations in git
 *   DEP-09 service has endpoints ...... the Service has at least
 *     one ready endpoint
 *   DEP-10 pods restarting ............ no pod with a high
 *     restartCount, CrashLoopBackOff, or a recent BackOff event
 *   DEP-11 DB disk, no cluster ........ real DB size via
 *     pg_database_size vs the PVC capacity declared in git;
 *     warning at 80%, error at 90%
 *   DEP-12 end-to-end probe ........... login (when configured),
 *     create a task via the API, read it back, delete it — the
 *     ONLY check that writes application data (one ephemeral write)
 *
 * In repo-only mode (decision 02) DEP-01, DEP-04, DEP-09 and DEP-10
 * are reported as skipped, never as failures.
 *
 * Two different failure kinds, on purpose:
 * - Harbor, ArgoCD and the Kubernetes API are data sources: when
 *   they cannot be reached (network error, 429, 5xx) the run fails
 *   loudly (exit 2) — the check cannot verify anything.
 * - Postgres and the app are deploy TARGETS: when they do not
 *   answer, that is itself a finding (exit 1).
 * Missing credentials are always a skip with the variable named.
 */

export interface DeployCheckResult {
  findings: Finding[];
  skipped: SkippedCheck[];
}

export type TlsResult =
  | { ok: true; validTo: Date }
  | { ok: false; error: string };

export interface DeployCheckOptions {
  repoOnly: boolean;
  budgets: DeployBudgets;
  probe: ProbeConfig;
  env: DeployEnv;
  /** Injectable for tests — production passes the global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests — production opens a real pg connection. */
  pgQuery?: PgQuery;
  /** Injectable for tests — production uses node:tls. */
  tlsCheck?: (host: string, port: number) => Promise<TlsResult>;
}

interface DeployContext {
  targetDir: string;
  repoOnly: boolean;
  budgets: DeployBudgets;
  probe: ProbeConfig;
  env: DeployEnv;
  fetchFn: typeof fetch;
  pg: PgQuery | null;
  pgFailed: string | null;
  tlsCheck: (host: string, port: number) => Promise<TlsResult>;
  manifests: ManifestSet;
  imageRefs: ImageRef[];
  findings: Finding[];
  skipped: SkippedCheck[];
}

function errorFinding(
  rule: string,
  file: string,
  line: number,
  detail: string,
  fix: string,
): Finding {
  return { rule, severity: "error", file, line, detail, fix };
}

function warningFinding(
  rule: string,
  file: string,
  line: number,
  detail: string,
  fix: string,
): Finding {
  return { rule, severity: "warning", file, line, detail, fix };
}

function skip(ctx: DeployContext, rule: string, reason: string): void {
  ctx.skipped.push({ rule, reason });
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  const cleanBase = stripTrailingSlash(base);
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function harborMissing(ctx: DeployContext): boolean {
  return (
    ctx.env.harborUrl === undefined ||
    ctx.env.harborUser === undefined ||
    ctx.env.harborToken === undefined
  );
}

function k8sMissing(ctx: DeployContext): boolean {
  return (
    ctx.env.k8sApiUrl === undefined || ctx.env.k8sToken === undefined
  );
}

function argocdMissing(ctx: DeployContext): boolean {
  return (
    ctx.env.argocdUrl === undefined || ctx.env.argocdToken === undefined
  );
}

function clusterSkipped(
  ctx: DeployContext,
  rule: string,
): boolean {
  if (ctx.repoOnly) {
    skip(ctx, rule, "repo-only mode: no cluster access");
    return true;
  }
  if (k8sMissing(ctx)) {
    skip(ctx, rule, missingVarsReason("k8s"));
    return true;
  }
  return false;
}

/* --- DEP-01: digest in k3s -------------------------------------------- */

async function checkDigestInK3s(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/digest-in-k3s";
  if (clusterSkipped(ctx, RULE)) return;
  const deployments = ctx.manifests.deployments.filter(
    (d) => d.name !== null,
  );
  if (deployments.length === 0) {
    skip(ctx, RULE, "no Deployments declared in git");
    return;
  }
  let noGitCount = 0;
  for (const dep of deployments) {
    const name = dep.name as string;
    const live = await getDeployment(ctx.env, dep.namespace, name, ctx.fetchFn);
    if (!live.ok) {
      if (live.status === 404) {
        ctx.findings.push(
          errorFinding(
            RULE,
            dep.file,
            dep.line,
            `Deployment ${name} (${dep.namespace}) is declared in git but not found in the cluster`,
            "deploy it or remove it from git",
          ),
        );
      } else {
        skip(
          ctx,
          RULE,
          `Kubernetes API returned HTTP ${live.status} for Deployment ${name}`,
        );
      }
      continue;
    }
    const containers =
      live.body.spec?.template?.spec?.containers ?? [];
    for (const container of containers) {
      const liveRef = parseImageRef(container.image, dep.file, dep.line, "manifest");
      const gitRef = ctx.imageRefs.find(
        (r) =>
          r.repository === liveRef.repository &&
          (r.source === "manifest" || r.source === "workflow-tags"),
      );
      if (!gitRef) {
        noGitCount++;
        continue;
      }
      if (gitRef.digest !== undefined) {
        let runningDigest = liveRef.digest;
        if (runningDigest === undefined && liveRef.tag !== undefined) {
          // The cluster image is tag-only: resolve the tag to its
          // digest in Harbor and compare that with git's pin.
          if (harborMissing(ctx)) {
            skip(
              ctx,
              RULE,
              `cannot resolve ${liveRef.repository}:${liveRef.tag} without Harbor credentials`,
            );
            continue;
          }
          const harborHost = new URL(ctx.env.harborUrl as string).host;
          if (liveRef.registry !== undefined && liveRef.registry !== harborHost) {
            skip(
              ctx,
              RULE,
              `${liveRef.repository} is not a Harbor image`,
            );
            continue;
          }
          const artifact = await getHarborArtifact(
            ctx.env,
            liveRef.repository,
            liveRef.tag,
            ctx.fetchFn,
          );
          if (!artifact.ok) {
            if (artifact.status === 404) {
              ctx.findings.push(
                errorFinding(
                  RULE,
                  dep.file,
                  dep.line,
                  `image ${liveRef.repository}:${liveRef.tag} running in the cluster is not in Harbor`,
                  "push the image to Harbor or fix the deployed tag",
                ),
              );
            } else {
              skip(
                ctx,
                RULE,
                `Harbor API returned HTTP ${artifact.status} for ${liveRef.repository}`,
              );
            }
            continue;
          }
          runningDigest = artifact.artifact.digest;
        }
        if (runningDigest !== undefined && runningDigest !== gitRef.digest) {
          ctx.findings.push(
            errorFinding(
              RULE,
              dep.file,
              dep.line,
              `cluster runs ${liveRef.repository} at ${runningDigest}, but git pins ${gitRef.digest}`,
              `deploy the image git declares (${gitRef.digest})`,
            ),
          );
        }
      } else if (gitRef.tag !== undefined) {
        if (liveRef.tag !== gitRef.tag) {
          ctx.findings.push(
            errorFinding(
              RULE,
              dep.file,
              dep.line,
              `cluster runs ${liveRef.repository}:${liveRef.tag ?? "(no tag)"}, but git declares :${gitRef.tag}`,
              "deploy the image git declares or update git to the deployed tag",
            ),
          );
        }
      }
    }
  }
  if (noGitCount > 0) {
    skip(
      ctx,
      RULE,
      `${noGitCount} running image(s) have no declared image in git`,
    );
  }
}

/* --- DEP-02: image size ------------------------------------------------ */

async function checkImageSize(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/image-size";
  if (harborMissing(ctx)) {
    skip(ctx, RULE, missingVarsReason("harbor"));
    return;
  }
  // The images the pipeline builds: workflow tags, plus the manifest
  // images for those same repositories, plus manifest images that
  // point at the Harbor registry. Values.yaml images carry no
  // registry and workflow tags carry it as a CI variable
  // (${{ vars.HARBOR_REGISTRY }}) that cannot be resolved
  // statically, so the registry match is one signal among two, not
  // the only one. An image CI builds but Harbor does not have is a
  // 404 error below, which says exactly that.
  const host = new URL(ctx.env.harborUrl as string).host;
  const built = ciBuiltRepositories(ctx.imageRefs);
  const refs = ctx.imageRefs.filter(
    (r) =>
      r.source === "workflow-tags" ||
      (r.source === "manifest" &&
        (built.has(r.repository) || r.registry === host)),
  );
  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    const key = `${r.repository}@${r.digest ?? r.tag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    skip(ctx, RULE, "no Harbor images in repo");
    return;
  }
  for (const ref of unique) {
    const reference = (ref.digest ?? ref.tag) as string;
    const result = await getHarborArtifact(
      ctx.env,
      ref.repository,
      reference,
      ctx.fetchFn,
    );
    if (!result.ok) {
      if (result.status === 404) {
        ctx.findings.push(
          errorFinding(
            RULE,
            ref.file,
            ref.line,
            `image ${ref.repository}:${reference} not found in Harbor`,
            "push the image to Harbor or fix the reference",
          ),
        );
      } else {
        skip(
          ctx,
          RULE,
          `Harbor API returned HTTP ${result.status} for ${ref.repository}`,
        );
      }
      continue;
    }
    const budgetMb = ref.repository.includes("frontend")
      ? ctx.budgets.frontendMb
      : ref.repository.includes("backend")
        ? ctx.budgets.backendMb
        : ctx.budgets.genericMb;
    if (result.artifact.size === undefined) {
      ctx.findings.push(
        errorFinding(
          RULE,
          ref.file,
          ref.line,
          `image ${ref.repository} has no size in Harbor — cannot check it against the ${budgetMb} MB budget`,
          "check the Harbor artifact response",
        ),
      );
      continue;
    }
    const sizeMb = result.artifact.size / (1024 * 1024);
    if (sizeMb > budgetMb) {
      ctx.findings.push(
        errorFinding(
          RULE,
          ref.file,
          ref.line,
          `image ${ref.repository} is ${sizeMb.toFixed(1)} MB — over the ${budgetMb} MB budget`,
          "slim the image (multi-stage build, smaller base, fewer layers)",
        ),
      );
    }
  }
}

/* --- DEP-03: ArgoCD Synced + Healthy ----------------------------------- */

async function checkArgoCdHealth(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/argocd-synced-healthy";
  if (argocdMissing(ctx)) {
    skip(ctx, RULE, missingVarsReason("argocd"));
    return;
  }
  const apps = ctx.manifests.applications.filter((a) => a.name !== null);
  if (apps.length === 0) {
    skip(ctx, RULE, "no ArgoCD Applications declared in git");
    return;
  }
  for (const app of apps) {
    const name = app.name as string;
    const res = await getApplication(ctx.env, name, ctx.fetchFn);
    if (!res.ok) {
      if (res.status === 404) {
        ctx.findings.push(
          errorFinding(
            RULE,
            app.file,
            app.line,
            `ArgoCD Application ${name} is declared in git but not found in ArgoCD`,
            "create the Application or remove it from git",
          ),
        );
      } else {
        skip(
          ctx,
          RULE,
          `ArgoCD API returned HTTP ${res.status} for ${name}`,
        );
      }
      continue;
    }
    const sync = res.body.status?.sync?.status;
    const health = res.body.status?.health?.status;
    if (sync !== undefined && sync !== "Synced") {
      ctx.findings.push(
        errorFinding(
          RULE,
          app.file,
          app.line,
          `ArgoCD app ${name} is ${sync} (not Synced)`,
          "sync it from ArgoCD or fix the drift (see DEP-07)",
        ),
      );
    }
    if (health === "Degraded") {
      ctx.findings.push(
        errorFinding(
          RULE,
          app.file,
          app.line,
          `ArgoCD app ${name} is Degraded`,
          "check the failing resources in ArgoCD",
        ),
      );
    } else if (
      health === "Progressing" ||
      health === "Unknown" ||
      health === undefined
    ) {
      ctx.findings.push(
        warningFinding(
          RULE,
          app.file,
          app.line,
          `ArgoCD app ${name} health is ${health ?? "unknown"}`,
          "wait for the rollout or check the app in ArgoCD",
        ),
      );
    }
  }
}

/* --- DEP-04: rollout complete ------------------------------------------ */

async function checkRollout(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/rollout-complete";
  if (clusterSkipped(ctx, RULE)) return;
  const deployments = ctx.manifests.deployments.filter(
    (d) => d.name !== null,
  );
  if (deployments.length === 0) {
    skip(ctx, RULE, "no Deployments declared in git");
    return;
  }
  for (const dep of deployments) {
    const name = dep.name as string;
    const live = await getDeployment(ctx.env, dep.namespace, name, ctx.fetchFn);
    if (!live.ok) {
      if (live.status === 404) {
        ctx.findings.push(
          errorFinding(
            RULE,
            dep.file,
            dep.line,
            `Deployment ${name} (${dep.namespace}) is declared in git but not found in the cluster`,
            "deploy it or remove it from git",
          ),
        );
      } else {
        skip(
          ctx,
          RULE,
          `Kubernetes API returned HTTP ${live.status} for Deployment ${name}`,
        );
      }
      continue;
    }
    const desired = live.body.spec?.replicas ?? 1;
    const updated = live.body.status?.updatedReplicas ?? 0;
    const available = live.body.status?.availableReplicas ?? 0;
    const observed = live.body.status?.observedGeneration ?? 0;
    const generation = live.body.metadata?.generation ?? 0;
    const deadline = (live.body.status?.conditions ?? []).find(
      (c) => c.reason === "ProgressDeadlineExceeded" && c.status === "True",
    );
    if (deadline) {
      ctx.findings.push(
        errorFinding(
          RULE,
          dep.file,
          dep.line,
          `Deployment ${name} exceeded its progress deadline — the new ReplicaSet is stuck`,
          "check the pods — a container may be crashing or the image may not pull",
        ),
      );
    } else if (updated < desired || available < desired || observed < generation) {
      ctx.findings.push(
        errorFinding(
          RULE,
          dep.file,
          dep.line,
          `Deployment ${name} rollout incomplete: ${available}/${desired} available, ${updated}/${desired} updated`,
          "wait for the rollout or check the failing pods",
        ),
      );
    }
  }
}

/* --- DEP-05: HTTP + TLS ------------------------------------------------- */

async function defaultTlsCheck(
  host: string,
  port: number,
): Promise<TlsResult> {
  return new Promise<TlsResult>((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "TLS handshake timed out" });
    }, REQUEST_TIMEOUT_MS);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) {
        resolve({ ok: false, error: "no certificate presented" });
      } else {
        resolve({ ok: true, validTo: new Date(cert.valid_to) });
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}

async function checkHttpTls(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/http-tls";
  if (ctx.env.appUrl === undefined) {
    skip(ctx, RULE, "missing PIPELINE_DOCTOR_APP_URL");
    return;
  }
  const url = ctx.env.appUrl;
  let response: Response;
  try {
    response = await ctx.fetchFn(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    ctx.findings.push(
      errorFinding(
        RULE,
        url,
        1,
        `app did not answer: ${errorMessage(error)}`,
        "check the app is up and the URL is reachable",
      ),
    );
    return;
  }
  if (response.status !== 200) {
    ctx.findings.push(
      errorFinding(
        RULE,
        url,
        1,
        `app returned HTTP ${response.status} (expected 200)`,
        "check the app logs — it answers but not OK",
      ),
    );
    return;
  }
  if (!url.startsWith("https://")) {
    ctx.findings.push(
      warningFinding(
        RULE,
        url,
        1,
        "app URL uses plain HTTP — no TLS to verify",
        "serve the app over HTTPS",
      ),
    );
    return;
  }
  const host = new URL(url).hostname;
  const tlsResult = await ctx.tlsCheck(host, 443);
  if (!tlsResult.ok) {
    ctx.findings.push(
      errorFinding(
        RULE,
        url,
        1,
        `TLS certificate invalid: ${tlsResult.error}`,
        "renew or fix the certificate",
      ),
    );
    return;
  }
  const days = (tlsResult.validTo.getTime() - Date.now()) / 86_400_000;
  if (days < 0) {
    ctx.findings.push(
      errorFinding(RULE, url, 1, "TLS certificate expired", "renew the certificate now"),
    );
  } else if (days < 7) {
    ctx.findings.push(
      errorFinding(
        RULE,
        url,
        1,
        `TLS certificate expires in ${days.toFixed(0)} day(s)`,
        "renew the certificate",
      ),
    );
  } else if (days < 30) {
    ctx.findings.push(
      warningFinding(
        RULE,
        url,
        1,
        `TLS certificate expires in ${days.toFixed(0)} days`,
        "plan the renewal",
      ),
    );
  }
}

/* --- DEP-06: SELECT 1 --------------------------------------------------- */

async function checkDbSelect1(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/db-select-1";
  if (ctx.pg === null) {
    if (ctx.pgFailed !== null) {
      ctx.findings.push(
        errorFinding(
          RULE,
          ".",
          1,
          `could not connect to Postgres: ${ctx.pgFailed}`,
          "check DATABASE_URL and that Postgres accepts connections",
        ),
      );
    } else {
      skip(ctx, RULE, "missing DATABASE_URL");
    }
    return;
  }
  try {
    await ctx.pg("SELECT 1");
  } catch (error) {
    // The database is unreachable — DEP-08 and DEP-11 run against
    // the same connection, so they skip instead of reporting the
    // same failure twice more.
    ctx.pgFailed = errorMessage(error);
    ctx.findings.push(
      errorFinding(
        RULE,
        ".",
        1,
        `database did not answer SELECT 1: ${errorMessage(error)}`,
        "check Postgres is up and the credentials work",
      ),
    );
  }
}

/* --- DEP-07: no drift ---------------------------------------------------- */

async function checkDrift(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/no-drift";
  if (argocdMissing(ctx)) {
    skip(ctx, RULE, missingVarsReason("argocd"));
    return;
  }
  const apps = ctx.manifests.applications.filter((a) => a.name !== null);
  if (apps.length === 0) {
    skip(ctx, RULE, "no ArgoCD Applications declared in git");
    return;
  }
  for (const app of apps) {
    const name = app.name as string;
    const res = await getApplication(ctx.env, name, ctx.fetchFn);
    if (!res.ok) {
      if (res.status === 404) {
        ctx.findings.push(
          errorFinding(
            RULE,
            app.file,
            app.line,
            `ArgoCD Application ${name} is declared in git but not found in ArgoCD`,
            "create the Application or remove it from git",
          ),
        );
      } else {
        skip(
          ctx,
          RULE,
          `ArgoCD API returned HTTP ${res.status} for ${name}`,
        );
      }
      continue;
    }
    const sync = res.body.status?.sync?.status;
    if (sync === "Synced") continue;
    const drifted = (res.body.status?.resources ?? []).filter(
      (r) => r.status === "OutOfSync",
    );
    if (drifted.length > 0) {
      const shown = drifted
        .slice(0, 5)
        .map((r) => `${r.kind}/${r.name}`)
        .join(", ");
      const more =
        drifted.length > 5 ? ` (+${drifted.length - 5} more)` : "";
      ctx.findings.push(
        errorFinding(
          RULE,
          app.file,
          app.line,
          `app ${name} drifted: ${shown}${more}`,
          "sync the app in ArgoCD or fix the live resources",
        ),
      );
    } else {
      ctx.findings.push(
        errorFinding(
          RULE,
          app.file,
          app.line,
          `app ${name} is ${sync ?? "unknown"} (not Synced)`,
          "sync the app in ArgoCD",
        ),
      );
    }
  }
}

/* --- DEP-08: pending migrations ------------------------------------------ */

async function checkMigrations(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/pending-migrations";
  if (ctx.pgFailed !== null) {
    skip(ctx, RULE, "database unreachable (see DEP-06)");
    return;
  }
  if (ctx.pg === null) {
    if (ctx.pgFailed !== null) {
      skip(ctx, RULE, "database unreachable (see DEP-06)");
    } else {
      skip(ctx, RULE, "missing DATABASE_URL");
    }
    return;
  }
  const gitMigrations = collectDjangoMigrations(ctx.targetDir);
  if (gitMigrations.length === 0) {
    skip(ctx, RULE, "no Django migrations in repo");
    return;
  }
  let rows: Record<string, unknown>[];
  try {
    const res = await ctx.pg("SELECT app, name FROM django_migrations");
    rows = res.rows;
  } catch (error) {
    const msg = errorMessage(error);
    if (msg.includes("django_migrations") && msg.includes("does not exist")) {
      ctx.findings.push(
        errorFinding(
          RULE,
          ".",
          1,
          "django_migrations table not found — the database has never been migrated",
          "run the migrations (the deploy initContainer should do it)",
        ),
      );
    } else {
      ctx.findings.push(
        errorFinding(
          RULE,
          ".",
          1,
          `could not read django_migrations: ${msg}`,
          "check the database user can read django_migrations",
        ),
      );
    }
    return;
  }
  const applied = new Set(
    rows.map((r) => `${String(r.app)}/${String(r.name)}`),
  );
  const pending = gitMigrations.filter(
    (m) => !applied.has(`${m.app}/${m.name}`),
  );
  if (pending.length > 0) {
    const shown = pending
      .slice(0, 5)
      .map((m) => `${m.app}/${m.name}`)
      .join(", ");
    const more = pending.length > 5 ? ` (+${pending.length - 5} more)` : "";
    ctx.findings.push(
      errorFinding(
        RULE,
        ".",
        1,
        `${pending.length} migration(s) pending: ${shown}${more}`,
        "run the migrations — the app may be running against an old schema",
      ),
    );
  }
  const gitSet = new Set(gitMigrations.map((m) => `${m.app}/${m.name}`));
  const extra = rows.filter(
    (r) => !gitSet.has(`${String(r.app)}/${String(r.name)}`),
  );
  if (extra.length > 0) {
    const shown = extra
      .slice(0, 5)
      .map((r) => `${String(r.app)}/${String(r.name)}`)
      .join(", ");
    ctx.findings.push(
      warningFinding(
        RULE,
        ".",
        1,
        `${extra.length} applied migration(s) not in git: ${shown}`,
        "check whether a migration file was deleted",
      ),
    );
  }
}

/* --- DEP-09: service has endpoints -------------------------------------- */

async function checkEndpoints(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/service-endpoints";
  if (clusterSkipped(ctx, RULE)) return;
  const services = ctx.manifests.services.filter((s) => s.name !== null);
  if (services.length === 0) {
    skip(ctx, RULE, "no Services declared in git");
    return;
  }
  for (const svc of services) {
    const name = svc.name as string;
    const res = await getEndpoints(ctx.env, svc.namespace, name, ctx.fetchFn);
    if (!res.ok) {
      if (res.status === 404) {
        ctx.findings.push(
          errorFinding(
            RULE,
            svc.file,
            svc.line,
            `Service ${name} (${svc.namespace}) is declared in git but not found in the cluster`,
            "deploy it or remove it from git",
          ),
        );
      } else {
        skip(
          ctx,
          RULE,
          `Kubernetes API returned HTTP ${res.status} for Service ${name}`,
        );
      }
      continue;
    }
    const addresses = (res.body.subsets ?? []).flatMap(
      (s) => s.addresses ?? [],
    );
    if (addresses.length === 0) {
      ctx.findings.push(
        errorFinding(
          RULE,
          svc.file,
          svc.line,
          `Service ${name} has no ready endpoints — traffic has nowhere to go`,
          "check the pods behind it (labels) and the Deployment rollout",
        ),
      );
    }
  }
}

/* --- DEP-10: pods restarting --------------------------------------------- */

const BAD_EVENT_REASONS = new Set([
  "BackOff",
  "CrashLoopBackOff",
  "OOMKilled",
]);

async function checkRestarts(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/pods-restarting";
  if (clusterSkipped(ctx, RULE)) return;
  const deployments = ctx.manifests.deployments.filter(
    (d) => d.name !== null && Object.keys(d.matchLabels).length > 0,
  );
  if (deployments.length === 0) {
    skip(ctx, RULE, "no Deployments with pod selectors declared in git");
    return;
  }
  // Recent bad events, once per namespace (auxiliary signal — a
  // failed events call degrades to restartCount alone, it never
  // fails the run).
  const badEvents = new Map<string, string>();
  const namespaces = [...new Set(deployments.map((d) => d.namespace))];
  for (const namespace of namespaces) {
    try {
      const events = await listEvents(ctx.env, namespace, ctx.fetchFn);
      if (!events.ok) continue;
      const dayAgo = Date.now() - 86_400_000;
      for (const event of events.body.items ?? []) {
        if (event.type !== "Warning") continue;
        if (!BAD_EVENT_REASONS.has(event.reason)) continue;
        if (event.involvedObject?.kind !== "Pod") continue;
        const when = event.lastTimestamp
          ? Date.parse(event.lastTimestamp)
          : NaN;
        if (!Number.isNaN(when) && when < dayAgo) continue;
        badEvents.set(event.involvedObject.name, event.reason);
      }
    } catch {
      continue;
    }
  }
  const reportedPods = new Set<string>();
  for (const dep of deployments) {
    const name = dep.name as string;
    const selector = Object.entries(dep.matchLabels)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const pods = await listPods(ctx.env, dep.namespace, selector, ctx.fetchFn);
    if (!pods.ok) {
      skip(
        ctx,
        RULE,
        `Kubernetes API returned HTTP ${pods.status} for pods of ${name}`,
      );
      continue;
    }
    for (const pod of pods.body.items ?? []) {
      const podName = pod.metadata.name;
      for (const container of pod.status?.containerStatuses ?? []) {
        const restarts = container.restartCount ?? 0;
        const waiting = container.state?.waiting?.reason;
        if (waiting === "CrashLoopBackOff") {
          ctx.findings.push(
            errorFinding(
              RULE,
              dep.file,
              dep.line,
              `pod ${podName} container ${container.name} is in CrashLoopBackOff`,
              "check the container logs — it crashes on start",
            ),
          );
          reportedPods.add(podName);
        } else if (restarts >= 5) {
          ctx.findings.push(
            errorFinding(
              RULE,
              dep.file,
              dep.line,
              `pod ${podName} container ${container.name} restarted ${restarts} times`,
              "check the container logs and resource limits",
            ),
          );
          reportedPods.add(podName);
        } else if (restarts > 0) {
          ctx.findings.push(
            warningFinding(
              RULE,
              dep.file,
              dep.line,
              `pod ${podName} container ${container.name} restarted ${restarts} time(s)`,
              "check whether the restarts were a one-off or a pattern",
            ),
          );
          reportedPods.add(podName);
        }
      }
      const eventReason = badEvents.get(podName);
      if (eventReason !== undefined && !reportedPods.has(podName)) {
        ctx.findings.push(
          errorFinding(
            RULE,
            dep.file,
            dep.line,
            `pod ${podName} has a recent ${eventReason} event`,
            "check the container logs — it failed within the last day",
          ),
        );
        reportedPods.add(podName);
      }
    }
  }
}

/* --- DEP-11: DB disk, no cluster ----------------------------------------- */

async function checkDbDisk(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/db-disk";
  if (ctx.pgFailed !== null) {
    skip(ctx, RULE, "database unreachable (see DEP-06)");
    return;
  }
  if (ctx.pg === null) {
    if (ctx.pgFailed !== null) {
      skip(ctx, RULE, "database unreachable (see DEP-06)");
    } else {
      skip(ctx, RULE, "missing DATABASE_URL");
    }
    return;
  }
  const pvcs = ctx.manifests.pvcs;
  if (pvcs.length === 0) {
    skip(ctx, RULE, "no PVC capacity declared in git");
    return;
  }
  // The PVC that holds the database: prefer a db-named claim; a
  // single PVC is unambiguous; several unnamed ones cannot be told
  // apart, so the check says so instead of guessing.
  let pvc = pvcs.find((p) => /db|postgres|database|data/i.test(p.name));
  if (!pvc && pvcs.length === 1) pvc = pvcs[0];
  if (!pvc) {
    skip(ctx, RULE, "cannot tell which PVC holds the database");
    return;
  }
  let sizeBytes: number;
  try {
    const res = await ctx.pg(
      "SELECT pg_database_size(current_database()) AS size",
    );
    sizeBytes = Number(res.rows[0]?.size);
    if (!Number.isFinite(sizeBytes)) {
      throw new Error("pg_database_size returned no size");
    }
  } catch (error) {
    ctx.findings.push(
      errorFinding(
        RULE,
        ".",
        1,
        `could not measure the database size: ${errorMessage(error)}`,
        "check the database user can run pg_database_size",
      ),
    );
    return;
  }
  const pct = (sizeBytes / pvc.capacityBytes) * 100;
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
  const capMb = (pvc.capacityBytes / (1024 * 1024)).toFixed(0);
  const detail =
    `database is ${sizeMb} MB of the ${capMb} MB PVC (${pct.toFixed(0)}%) ` +
    "— measured with pg_database_size, which excludes WAL and temp files, so real usage can be slightly higher";
  if (pct >= 90) {
    ctx.findings.push(
      errorFinding(
        RULE,
        pvc.file,
        pvc.line,
        detail,
        "grow the PVC or clean the database before writes stop",
      ),
    );
  } else if (pct >= 80) {
    ctx.findings.push(
      warningFinding(
        RULE,
        pvc.file,
        pvc.line,
        detail,
        "plan to grow the PVC or clean the database",
      ),
    );
  }
}

/* --- DEP-12: end-to-end probe -------------------------------------------- */

async function checkEndToEnd(ctx: DeployContext): Promise<void> {
  const RULE = "deploy/end-to-end-probe";
  if (ctx.env.appUrl === undefined) {
    skip(ctx, RULE, "missing PIPELINE_DOCTOR_APP_URL");
    return;
  }
  const probe = ctx.probe;
  const base = stripTrailingSlash(ctx.env.appUrl);
  const fail = (detail: string, fix: string): void => {
    ctx.findings.push(errorFinding(RULE, base, 1, detail, fix));
  };
  let createdId: string | number | undefined;
  // Declared outside the try so the finally block (the delete) can
  // send the same token the probe steps used.
  const authHeaders: Record<string, string> = {};
  try {
    if (probe.login !== undefined) {
      if (
        ctx.env.appUser === undefined ||
        ctx.env.appPassword === undefined
      ) {
        skip(
          ctx,
          RULE,
          "missing PIPELINE_DOCTOR_APP_USER and PIPELINE_DOCTOR_APP_PASSWORD",
        );
        return;
      }
      const body: Record<string, string> = {
        [probe.login.usernameField]: ctx.env.appUser,
        [probe.login.passwordField]: ctx.env.appPassword,
      };
      let loginRes: Response;
      try {
        loginRes = await ctx.fetchFn(joinUrl(base, probe.login.path), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        fail(
          `probe login failed: ${probe.login.path} did not answer (${errorMessage(error)})`,
          "check the app is up and the login endpoint is right",
        );
        return;
      }
      if (loginRes.status !== 200 && loginRes.status !== 201) {
        fail(
          `probe login failed: ${probe.login.path} returned HTTP ${loginRes.status}`,
          "check the probe credentials and the login endpoint",
        );
        return;
      }
      const loginBody: unknown = await loginRes.json().catch(() => null);
      const token =
        loginBody !== null &&
        typeof loginBody === "object" &&
        probe.login.tokenField in loginBody
          ? (loginBody as Record<string, unknown>)[probe.login.tokenField]
          : undefined;
      if (typeof token !== "string" || token.length === 0) {
        fail(
          `probe login did not return a ${probe.login.tokenField}`,
          "check the probe login tokenField matches the API response",
        );
        return;
      }
      authHeaders.Authorization = `${probe.login.tokenScheme} ${token}`;
    }

    let createRes: Response;
    try {
      createRes = await ctx.fetchFn(joinUrl(base, probe.create.path), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(probe.create.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      fail(
        `probe create failed: ${probe.create.path} did not answer (${errorMessage(error)})`,
        "check the app is up and the create endpoint is right",
      );
      return;
    }
    if (createRes.status !== 200 && createRes.status !== 201) {
      fail(
        `probe create failed: ${probe.create.path} returned HTTP ${createRes.status}`,
        "check the probe create path and body match the API",
      );
      return;
    }
    const created: unknown = await createRes.json().catch(() => null);
    const id =
      created !== null &&
      typeof created === "object" &&
      probe.create.idField in created
        ? (created as Record<string, unknown>)[probe.create.idField]
        : undefined;
    if (typeof id !== "string" && typeof id !== "number") {
      fail(
        `probe create did not return an ${probe.create.idField}`,
        "check the probe create idField matches the API response",
      );
      return;
    }
    createdId = id;

    const readPath = probe.read.path.replace("{id}", String(id));
    let readRes: Response;
    try {
      readRes = await ctx.fetchFn(joinUrl(base, readPath), {
        headers: { ...authHeaders },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      fail(
        `probe read failed: ${readPath} did not answer (${errorMessage(error)})`,
        "check the app is up and the read endpoint is right",
      );
      return;
    }
    if (readRes.status !== 200) {
      fail(
        `probe read failed: ${readPath} returned HTTP ${readRes.status}`,
        "the task was created but cannot be read back — check the API",
      );
      return;
    }
  } finally {
    // The probe task is ephemeral: whatever happened after the
    // create, it gets deleted. A failed delete is a warning, not an
    // error — the probe itself already reported its verdict.
    if (createdId !== undefined) {
      const deletePath = probe.delete.path.replace("{id}", String(createdId));
      try {
        const deleteRes = await ctx.fetchFn(joinUrl(base, deletePath), {
          method: "DELETE",
          headers: { ...authHeaders },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (deleteRes.status !== 200 && deleteRes.status !== 204) {
          ctx.findings.push(
            warningFinding(
              RULE,
              base,
              1,
              `probe task ${createdId} could not be deleted (HTTP ${deleteRes.status}) — remove it by hand`,
              "delete the probe task from the app",
            ),
          );
        }
      } catch {
        ctx.findings.push(
          warningFinding(
            RULE,
            base,
            1,
            `probe task ${createdId} could not be deleted — remove it by hand`,
            "delete the probe task from the app",
          ),
        );
      }
    }
  }
}

/* --- entry point -------------------------------------------------------- */

export async function checkDeploy(
  targetDir: string,
  options: DeployCheckOptions,
): Promise<DeployCheckResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const findings: Finding[] = [];
  const skipped: SkippedCheck[] = [];

  const manifests = collectManifests(targetDir);
  const imageRefs = collectImageReferences(targetDir);

  // One Postgres connection for DEP-06, DEP-08 and DEP-11
  // (decision 04). A failed connect is reported once, by DEP-06.
  let pg: PgQuery | null = options.pgQuery ?? null;
  let pgClose: (() => Promise<void>) | null = null;
  let pgFailed: string | null = null;
  if (pg === null && options.env.databaseUrl !== undefined) {
    try {
      const conn = await connectPostgres(options.env);
      if (conn !== null) {
        pg = conn.query;
        pgClose = conn.close;
      }
    } catch (error) {
      pgFailed = errorMessage(error);
    }
  }

  const ctx: DeployContext = {
    targetDir,
    repoOnly: options.repoOnly,
    budgets: options.budgets,
    probe: options.probe,
    env: options.env,
    fetchFn,
    pg,
    pgFailed,
    tlsCheck: options.tlsCheck ?? defaultTlsCheck,
    manifests,
    imageRefs,
    findings,
    skipped,
  };

  try {
    await checkDigestInK3s(ctx);
    await checkImageSize(ctx);
    await checkArgoCdHealth(ctx);
    await checkRollout(ctx);
    await checkHttpTls(ctx);
    await checkDbSelect1(ctx);
    await checkDrift(ctx);
    await checkMigrations(ctx);
    await checkEndpoints(ctx);
    await checkRestarts(ctx);
    await checkDbDisk(ctx);
    await checkEndToEnd(ctx);
  } finally {
    if (pgClose !== null) {
      await pgClose().catch(() => {});
    }
  }

  return { findings, skipped };
}
