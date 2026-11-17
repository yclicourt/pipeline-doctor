import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDeploy, type DeployCheckOptions } from "../src/checks/deploy.js";
import { DEFAULT_PROBE } from "../src/config.js";
import type { DeployEnv } from "../src/env.js";
import type { PgQuery } from "../src/pg.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-doctor-test-"));
}

function writeRepo(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), {
      recursive: true,
    });
    writeFileSync(path, content);
  }
  return dir;
}

const SHA = "839a924f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9d0e1f2";

const TASKS_APP: Record<string, string> = {
  "helm/values.yaml": `global:
  namespace: tasks-app
  registry:
    url: registry.local:5443
backend:
  name: backend-tasks-app
  serviceName: backend-tasks-svc
  image:
    name: backend-django-tasks
    repository: backend-django-tasks/backend-django-tasks
    tag: ${SHA}
frontend:
  name: frontend-tasks-app
  serviceName: frontend-tasks-svc
  image:
    name: frontend-react-tasks
    repository: frontend-react-tasks/frontend-react-tasks
    tag: ${SHA}
`,
  "helm/templates/backend/deployment.yml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{.Values.backend.name}}
  namespace: {{.Values.global.namespace}}
spec:
  selector:
    matchLabels:
      app: {{.Values.backend.name}}
  template:
    spec:
      containers:
        - name: {{.Values.backend.name}}
          image: "{{.Values.global.registry.url}}/{{.Values.backend.image.repository}}:{{.Values.backend.image.tag}}"
`,
  "helm/templates/frontend/deployment.yml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{.Values.frontend.name}}
  namespace: {{.Values.global.namespace}}
spec:
  selector:
    matchLabels:
      app: {{.Values.frontend.name}}
  template:
    spec:
      containers:
        - name: {{.Values.frontend.name}}
          image: "{{.Values.global.registry.url}}/{{.Values.frontend.image.repository}}:{{.Values.frontend.image.tag}}"
`,
  "helm/templates/backend/service.yml": `apiVersion: v1
kind: Service
metadata:
  name: {{.Values.backend.serviceName}}
  namespace: {{.Values.global.namespace}}
`,
  "helm/templates/frontend/service.yml": `apiVersion: v1
kind: Service
metadata:
  name: {{.Values.frontend.serviceName}}
  namespace: {{.Values.global.namespace}}
`,
  "helm/templates/postgres/statefulset.yml": `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: tasks-db
  namespace: {{.Values.global.namespace}}
spec:
  volumeClaimTemplates:
    - metadata:
        name: tasks-db-storage
      spec:
        resources:
          requests:
            storage: 2Gi
`,
  "platform/app-of-apps/applications/tasks-app.yaml": `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: tasks-app
  namespace: argocd
`,
  "backend/tasks/migrations/0001_initial.py": "# initial\n",
  ".github/workflows/docker.yml": `name: Build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v6
        with:
          tags: |
            registry.local:5443/backend-django-tasks/backend-django-tasks:${SHA}
            registry.local:5443/frontend-react-tasks/frontend-react-tasks:${SHA}
`,
};

// --- Mock fetch -----------------------------------------------------------

type Handler = (url: string, init?: RequestInit) => Response;

function routeFetch(routes: Array<[string | RegExp, Handler]>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, handler] of routes) {
      const match =
        typeof pattern === "string"
          ? url.includes(pattern)
          : pattern.test(url);
      if (match) return handler(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const emptyEnv: DeployEnv = {
  databaseUrl: undefined,
  harborUrl: undefined,
  harborUser: undefined,
  harborToken: undefined,
  argocdUrl: undefined,
  argocdToken: undefined,
  k8sApiUrl: undefined,
  k8sToken: undefined,
  appUrl: undefined,
  appUser: undefined,
  appPassword: undefined,
  githubToken: undefined,
};

function options(
  overrides: Partial<DeployCheckOptions> = {},
): DeployCheckOptions {
  return {
    repoOnly: false,
    budgets: { frontendMb: 75, backendMb: 250, genericMb: 300 },
    probe: structuredClone(DEFAULT_PROBE),
    env: emptyEnv,
    fetchFn: routeFetch([]),
    tlsCheck: async () => ({
      ok: true,
      validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    }),
    ...overrides,
  };
}

const k8sEnv: DeployEnv = {
  ...emptyEnv,
  k8sApiUrl: "https://k8s.example.com",
  k8sToken: "k8s-token",
};

function deploymentImage(
  image: string,
  name = "backend-tasks-app",
): Record<string, unknown> {
  return {
    metadata: { name, generation: 3 },
    spec: {
      replicas: 1,
      template: { spec: { containers: [{ name: "app", image }] } },
    },
    status: {
      observedGeneration: 3,
      updatedReplicas: 1,
      availableReplicas: 1,
      conditions: [],
    },
  };
}

/** A complete deployment for the frontend (used when only the backend is broken). */
function frontendDeployment(): Record<string, unknown> {
  return deploymentImage(
    `registry.local:5443/frontend-react-tasks/frontend-react-tasks:${SHA}`,
    "frontend-tasks-app",
  );
}

/**
 * Healthy defaults for the k8s calls a run makes besides the one
 * under test. A network error in any check aborts the whole run
 * (shared policy), so every k8s mock must answer all four calls —
 * the specific route comes first in the list and wins.
 */
function k8sDefaults(): Array<[string | RegExp, Handler]> {
  return [
    [
      "/deployments/",
      (url) =>
        url.includes("frontend-tasks-app")
          ? json(frontendDeployment())
          : json(
              deploymentImage(
                `registry.local:5443/backend-django-tasks/backend-django-tasks:${SHA}`,
              ),
            ),
    ],
    [
      "/endpoints/",
      () => json({ subsets: [{ addresses: [{ ip: "10.0.0.1" }] }] }),
    ],
    ["/pods", () => json({ items: [] })],
    ["/events", () => json({ items: [] })],
  ];
}

const pgOk: PgQuery = async (sql) => {
  if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
  if (sql.startsWith("SELECT app, name FROM django_migrations"))
    return { rows: [{ app: "tasks", name: "0001_initial" }] };
  if (sql.includes("pg_database_size"))
    return { rows: [{ size: 100 * 1024 * 1024 }] };
  return { rows: [] };
};

describe("checkDeploy", () => {
  it("passes on a clean fixture with no backends (everything skipped)", async () => {
    const dir = writeRepo(TASKS_APP);
    const result = await checkDeploy(dir, options());
    // Repo-only checks run: DEP-02 skipped (no Harbor), DEP-08 skipped
    // (no pg), DEP-11 skipped (no pg). The rest have no backends either.
    expect(result.findings).toEqual([]);
    const skipped = result.skipped.map((s) => s.rule);
    expect(skipped).toContain("deploy/image-size");
    expect(skipped).toContain("deploy/db-disk");
    expect(skipped).toContain("deploy/pending-migrations");
    expect(skipped).toContain("deploy/http-tls");
    expect(skipped).toContain("deploy/end-to-end-probe");
  });

  it("repo-only mode skips the four cluster checks", async () => {
    const dir = writeRepo(TASKS_APP);
    const result = await checkDeploy(dir, options({ repoOnly: true }));
    const skipped = new Map(result.skipped.map((s) => [s.rule, s.reason]));
    for (const rule of [
      "deploy/digest-in-k3s",
      "deploy/rollout-complete",
      "deploy/service-endpoints",
      "deploy/pods-restarting",
    ]) {
      expect(skipped.get(rule)).toMatch(/repo-only mode/);
    }
    expect(result.findings).toEqual([]);
  });

  describe("DEP-01 artifact-vs-git", () => {
    it("passes when the live tag matches the git tag", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch(k8sDefaults());
      const result = await checkDeploy(dir, options({ env: k8sEnv, fetchFn }));
      expect(
        result.findings.filter((f) => f.rule === "deploy/digest-in-k3s"),
      ).toEqual([]);
    });

    it("errors when the live tag differs from git", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/deployments/",
          (url) =>
            url.includes("frontend-tasks-app")
              ? json(frontendDeployment())
              : json(
                  deploymentImage(
                    "registry.local:5443/backend-django-tasks/backend-django-tasks:latest",
                  ),
                ),
        ],
        ...k8sDefaults(),
      ]);
      const result = await checkDeploy(dir, options({ env: k8sEnv, fetchFn }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/digest-in-k3s" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("latest");
    });

    it("errors on a 404 deployment", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/deployments/",
          (url) =>
            url.includes("frontend-tasks-app")
              ? json(frontendDeployment())
              : json({ message: "not found" }, 404),
        ],
        ...k8sDefaults(),
      ]);
      const result = await checkDeploy(dir, options({ env: k8sEnv, fetchFn }));
      expect(
        result.findings.filter(
          (f) => f.rule === "deploy/digest-in-k3s" && f.severity === "error",
        ),
      ).toHaveLength(1);
    });
  });

  describe("DEP-02 image-size", () => {
    const harborEnv: DeployEnv = {
      ...emptyEnv,
      harborUrl: "https://registry.local:5443",
      harborUser: "robot",
      harborToken: "harbor-token",
    };

    it("errors when the backend image exceeds its budget", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/api/v2.0/projects/",
          (url) =>
            url.includes("frontend-react-tasks")
              ? json({ digest: "sha256:abc", size: 50 * 1024 * 1024 })
              : json({
                  digest: "sha256:abc",
                  size: 400 * 1024 * 1024,
                }),
        ],
      ]);
      const result = await checkDeploy(
        dir,
        options({ env: harborEnv, fetchFn }),
      );
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/image-size" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("400.0 MB");
      expect(errors[0].detail).toContain("250 MB");
    });

    it("errors when the image is not in Harbor (404)", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/api/v2.0/projects/",
          (url) =>
            url.includes("backend-django-tasks")
              ? json({ errors: [{ message: "not found" }] }, 404)
              : json({ digest: "sha256:abc", size: 50 * 1024 * 1024 }),
        ],
      ]);
      const result = await checkDeploy(
        dir,
        options({ env: harborEnv, fetchFn }),
      );
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/image-size" && f.severity === "error",
      );
      expect(errors.some((e) => e.detail.includes("not found in Harbor"))).toBe(
        true,
      );
    });
  });

  describe("DEP-03 argocd-sync", () => {
    const argocdEnv: DeployEnv = {
      ...emptyEnv,
      argocdUrl: "https://argocd.example.com",
      argocdToken: "argo-token",
    };

    it("errors on OutOfSync and Degraded", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/api/v1/applications/",
          () =>
            json({
              status: {
                sync: { status: "OutOfSync" },
                health: { status: "Degraded" },
              },
            }),
        ],
      ]);
      const result = await checkDeploy(
        dir,
        options({ env: argocdEnv, fetchFn }),
      );
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/argocd-synced-healthy" && f.severity === "error",
      );
      // Sync and health are reported as two separate findings.
      expect(errors).toHaveLength(2);
      expect(errors.map((e) => e.detail).join(" ")).toContain("OutOfSync");
      expect(errors.map((e) => e.detail).join(" ")).toContain("Degraded");
    });

    it("warns on Progressing health", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/api/v1/applications/",
          () =>
            json({
              status: {
                sync: { status: "Synced" },
                health: { status: "Progressing" },
              },
            }),
        ],
      ]);
      const result = await checkDeploy(
        dir,
        options({ env: argocdEnv, fetchFn }),
      );
      const warnings = result.findings.filter(
        (f) => f.rule === "deploy/argocd-synced-healthy" && f.severity === "warning",
      );
      expect(warnings).toHaveLength(1);
    });
  });

  describe("DEP-04 rollout", () => {
    it("errors when the rollout has not completed", async () => {
      const dir = writeRepo(TASKS_APP);
      const dep = deploymentImage(
        `registry.local:5443/backend-django-tasks/backend-django-tasks:${SHA}`,
      );
      (dep.status as Record<string, unknown>).availableReplicas = 0;
      const fetchFn = routeFetch([
        [
          "/deployments/",
          (url) =>
            url.includes("frontend-tasks-app")
              ? json(frontendDeployment())
              : json(dep),
        ],
        ...k8sDefaults(),
      ]);
      const result = await checkDeploy(dir, options({ env: k8sEnv, fetchFn }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/rollout-complete" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("0/1");
    });
  });

  describe("DEP-05 health", () => {
    const appEnv: DeployEnv = { ...emptyEnv, appUrl: "https://app.example.com" };

    it("errors when the app does not answer 200", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        ["app.example.com", () => new Response("nope", { status: 503 })],
      ]);
      const result = await checkDeploy(dir, options({ env: appEnv, fetchFn }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/http-tls" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("503");
    });

    it("errors when the TLS certificate expires within 7 days", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        ["app.example.com", () => new Response("ok", { status: 200 })],
      ]);
      const result = await checkDeploy(
        dir,
        options({
          env: appEnv,
          fetchFn,
          tlsCheck: async () => ({
            ok: true,
            validTo: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
          }),
        }),
      );
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/http-tls" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("TLS certificate");
    });

    it("warns on plain http", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        ["app.example.com", () => new Response("ok", { status: 200 })],
      ]);
      const result = await checkDeploy(
        dir,
        options({
          env: { ...emptyEnv, appUrl: "http://app.example.com" },
          fetchFn,
        }),
      );
      const warnings = result.findings.filter(
        (f) => f.rule === "deploy/http-tls" && f.severity === "warning",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].detail).toContain("plain HTTP");
    });
  });

  describe("DEP-06 db-connect", () => {
    it("errors when the database connection fails", async () => {
      const dir = writeRepo(TASKS_APP);
      const pgQuery: PgQuery = async () => {
        throw new Error("connection refused");
      };
      const result = await checkDeploy(dir, options({ pgQuery }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/db-select-1" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("did not answer SELECT 1");
    });

    it("shares the connection: a failed db-connect skips the db-dependent checks", async () => {
      const dir = writeRepo(TASKS_APP);
      const pgQuery: PgQuery = async () => {
        throw new Error("connection refused");
      };
      const result = await checkDeploy(dir, options({ pgQuery }));
      const skipped = result.skipped.map((s) => s.rule);
      expect(skipped).toContain("deploy/pending-migrations");
      expect(skipped).toContain("deploy/db-disk");
    });
  });

  describe("DEP-08 migrations", () => {
    it("errors when a git migration was never applied", async () => {
      const dir = writeRepo({
        ...TASKS_APP,
        "backend/tasks/migrations/0002_add_field.py": "# add field\n",
      });
      const result = await checkDeploy(dir, options({ pgQuery: pgOk }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/pending-migrations" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("0002_add_field");
    });

    it("errors when the migrations table does not exist", async () => {
      const dir = writeRepo(TASKS_APP);
      const pgQuery: PgQuery = async (sql) => {
        if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
        throw new Error('relation "django_migrations" does not exist');
      };
      const result = await checkDeploy(dir, options({ pgQuery }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/pending-migrations" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("never been migrated");
    });
  });

  describe("DEP-09 endpoints", () => {
    it("errors when a Service has no endpoints", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/endpoints/",
          (url) =>
            url.includes("frontend-tasks-svc")
              ? json({ subsets: [{ addresses: [{ ip: "10.0.0.2" }] }] })
              : json({ subsets: [] }),
        ],
        ...k8sDefaults(),
      ]);
      const result = await checkDeploy(dir, options({ env: k8sEnv, fetchFn }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/service-endpoints" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("backend-tasks-svc");
    });
  });

  describe("DEP-10 restarts", () => {
    it("errors on 5+ restarts and warns on 1-4", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/pods",
          (url) =>
            url.includes("frontend-tasks-app")
              ? json({ items: [] })
              : json({
                  items: [
                    {
                      metadata: { name: "backend-abc" },
                      status: {
                        containerStatuses: [
                          {
                            name: "app",
                            restartCount: 7,
                            state: { running: {} },
                          },
                          {
                            name: "sidecar",
                            restartCount: 2,
                            state: { running: {} },
                          },
                        ],
                      },
                    },
                  ],
                }),
        ],
        ["/events", () => json({ items: [] })],
        ...k8sDefaults(),
      ]);
      const result = await checkDeploy(dir, options({ env: k8sEnv, fetchFn }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/pods-restarting" && f.severity === "error",
      );
      const warnings = result.findings.filter(
        (f) => f.rule === "deploy/pods-restarting" && f.severity === "warning",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("restarted 7 times");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].detail).toContain("restarted 2 time(s)");
    });

    it("errors on a CrashLoopBackOff container", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "/pods",
          (url) =>
            url.includes("frontend-tasks-app")
              ? json({ items: [] })
              : json({
                  items: [
                    {
                      metadata: { name: "backend-abc" },
                      status: {
                        containerStatuses: [
                          {
                            name: "app",
                            restartCount: 0,
                            state: {
                              waiting: { reason: "CrashLoopBackOff" },
                            },
                          },
                        ],
                      },
                    },
                  ],
                }),
        ],
        ["/events", () => json({ items: [] })],
        ...k8sDefaults(),
      ]);
      const result = await checkDeploy(dir, options({ env: k8sEnv, fetchFn }));
      const errors = result.findings.filter(
        (f) => f.rule === "deploy/pods-restarting" && f.severity === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail).toContain("CrashLoopBackOff");
    });
  });

  describe("DEP-11 db-size", () => {
    it("warns at 80% and errors at 90% of the PVC", async () => {
      const dir = writeRepo(TASKS_APP);
      const warn: PgQuery = async (sql) => {
        if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
        if (sql.startsWith("SELECT app, name FROM django_migrations"))
          return { rows: [{ app: "tasks", name: "0001_initial" }] };
        if (sql.includes("pg_database_size"))
          return { rows: [{ size: Math.floor(0.83 * 2 * 1024 ** 3) }] };
        return { rows: [] };
      };
      const warned = await checkDeploy(dir, options({ pgQuery: warn }));
      expect(
        warned.findings.filter(
          (f) => f.rule === "deploy/db-disk" && f.severity === "warning",
        ),
      ).toHaveLength(1);

      const err: PgQuery = async (sql) => {
        if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
        if (sql.startsWith("SELECT app, name FROM django_migrations"))
          return { rows: [{ app: "tasks", name: "0001_initial" }] };
        if (sql.includes("pg_database_size"))
          return { rows: [{ size: Math.floor(0.93 * 2 * 1024 ** 3) }] };
        return { rows: [] };
      };
      const errored = await checkDeploy(dir, options({ pgQuery: err }));
      expect(
        errored.findings.filter(
          (f) => f.rule === "deploy/db-disk" && f.severity === "error",
        ),
      ).toHaveLength(1);
    });
  });

  describe("DEP-12 probe", () => {
    const appEnv: DeployEnv = { ...emptyEnv, appUrl: "https://app.example.com" };

    it("passes a full create-read-delete cycle and deletes the task", async () => {
      const dir = writeRepo(TASKS_APP);
      const calls: string[] = [];
      const fetchFn = routeFetch([
        [
          "app.example.com",
          (url, init) => {
            calls.push(`${init?.method ?? "GET"} ${url}`);
            // DEP-05 health-checks the bare URL before the probe runs.
            if (url === "https://app.example.com")
              return new Response("ok", { status: 200 });
            if (url.endsWith("/tasks/") && init?.method === "POST")
              return json({ id: 42 }, 201);
            if (url.endsWith("/tasks/42/") && (init?.method === undefined || init?.method === "GET"))
              return json({ id: 42, title: "pipeline-doctor probe" }, 200);
            if (url.endsWith("/tasks/42/") && init?.method === "DELETE")
              return new Response(null, { status: 204 });
            return new Response("not found", { status: 404 });
          },
        ],
      ]);
      const result = await checkDeploy(dir, options({ env: appEnv, fetchFn }));
      expect(
        result.findings.filter((f) => f.rule === "deploy/end-to-end-probe"),
      ).toEqual([]);
      expect(calls).toContain("DELETE https://app.example.com/tasks/42/");
    });

    it("still deletes the task when the read fails", async () => {
      const dir = writeRepo(TASKS_APP);
      const calls: string[] = [];
      const fetchFn = routeFetch([
        [
          "app.example.com",
          (url, init) => {
            calls.push(`${init?.method ?? "GET"} ${url}`);
            if (url === "https://app.example.com")
              return new Response("ok", { status: 200 });
            if (url.endsWith("/tasks/") && init?.method === "POST")
              return json({ id: 42 }, 201);
            if (url.endsWith("/tasks/42/") && (init?.method === undefined || init?.method === "GET"))
              return new Response("not found", { status: 404 });
            if (url.endsWith("/tasks/42/") && init?.method === "DELETE")
              return new Response(null, { status: 204 });
            return new Response("not found", { status: 404 });
          },
        ],
      ]);
      const result = await checkDeploy(dir, options({ env: appEnv, fetchFn }));
      expect(
        result.findings.filter(
          (f) => f.rule === "deploy/end-to-end-probe" && f.severity === "error",
        ),
      ).toHaveLength(1);
      expect(calls).toContain("DELETE https://app.example.com/tasks/42/");
    });

    it("warns when the delete fails", async () => {
      const dir = writeRepo(TASKS_APP);
      const fetchFn = routeFetch([
        [
          "app.example.com",
          (url, init) => {
            if (url === "https://app.example.com")
              return new Response("ok", { status: 200 });
            if (url.endsWith("/tasks/") && init?.method === "POST")
              return json({ id: 42 }, 201);
            if (url.endsWith("/tasks/42/") && (init?.method === undefined || init?.method === "GET"))
              return json({ id: 42 }, 200);
            if (url.endsWith("/tasks/42/") && init?.method === "DELETE")
              return new Response("error", { status: 500 });
            return new Response("not found", { status: 404 });
          },
        ],
      ]);
      const result = await checkDeploy(dir, options({ env: appEnv, fetchFn }));
      const warnings = result.findings.filter(
        (f) => f.rule === "deploy/end-to-end-probe" && f.severity === "warning",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].detail).toContain("could not be deleted");
    });

    it("sends the login token on every step when a login is configured", async () => {
      const dir = writeRepo(TASKS_APP);
      const probe = structuredClone(DEFAULT_PROBE);
      probe.login = {
        path: "/api/auth/login/",
        usernameField: "username",
        passwordField: "password",
        tokenField: "access",
        tokenScheme: "Bearer",
      };
      const authHeaders: Array<string | undefined> = [];
      const fetchFn = routeFetch([
        [
          "app.example.com",
          (url, init) => {
            // Only the probe calls carry a token; DEP-05's health
            // check hits the same host without one.
            if (
              url.includes("/tasks/") ||
              url.includes("/api/auth/login/")
            ) {
              authHeaders.push(
                (init?.headers as Record<string, string>)?.["Authorization"],
              );
            }
            if (url === "https://app.example.com")
              return new Response("ok", { status: 200 });
            if (url.endsWith("/api/auth/login/"))
              return json({ access: "tok123" }, 200);
            if (url.endsWith("/tasks/") && init?.method === "POST")
              return json({ id: 42 }, 201);
            if (url.endsWith("/tasks/42/") && (init?.method === undefined || init?.method === "GET"))
              return json({ id: 42 }, 200);
            if (url.endsWith("/tasks/42/") && init?.method === "DELETE")
              return new Response(null, { status: 204 });
            return new Response("not found", { status: 404 });
          },
        ],
      ]);
      const result = await checkDeploy(
        dir,
        options({
          env: { ...appEnv, appUser: "probe", appPassword: "secret" },
          fetchFn,
          probe,
        }),
      );
      expect(
        result.findings.filter((f) => f.rule === "deploy/end-to-end-probe"),
      ).toEqual([]);
      // Login itself has no token; the three probe steps carry it.
      expect(authHeaders.slice(1)).toEqual([
        "Bearer tok123",
        "Bearer tok123",
        "Bearer tok123",
      ]);
    });

    it("skips when a login is configured but no app credentials are set", async () => {
      const dir = writeRepo(TASKS_APP);
      const probe = structuredClone(DEFAULT_PROBE);
      probe.login = {
        path: "/api/auth/login/",
        usernameField: "username",
        passwordField: "password",
        tokenField: "access",
        tokenScheme: "Bearer",
      };
      // DEP-05 still health-checks the app; the probe itself skips.
      const fetchFn = routeFetch([
        [
          "app.example.com",
          (url) =>
            url === "https://app.example.com"
              ? new Response("ok", { status: 200 })
              : new Response("not found", { status: 404 }),
        ],
      ]);
      const result = await checkDeploy(
        dir,
        options({ env: appEnv, fetchFn, probe }),
      );
      const skipped = result.skipped.map((s) => s.rule);
      expect(skipped).toContain("deploy/end-to-end-probe");
      expect(result.findings).toEqual([]);
    });
  });
});
