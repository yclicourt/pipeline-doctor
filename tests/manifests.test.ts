import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStorageSize,
  resolveTemplate,
  loadValues,
  collectManifests,
  collectDjangoMigrations,
} from "../src/manifests.js";

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

const HELM_REPO: Record<string, string> = {
  "helm/values.yaml": `global:
  namespace: tasks-app
backend:
  name: backend-tasks-app
  serviceName: backend-tasks-svc
frontend:
  name: frontend-tasks-app
`,
  "helm/templates/backend/deployment.yml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{.Values.backend.name}}
  namespace: {{.Values.global.namespace}}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{.Values.backend.name}}
  template:
    spec:
      containers:
        - name: {{.Values.backend.name}}
          image: "example.com/backend:abc"
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
  name: {{.Values.frontend_tasks_app.serviceName}}
  namespace: {{.Values.frontend_tasks_app.namespace}}
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
  "backend/tasks/migrations/0002_add_field.py": "# add field\n",
  "backend/tasks/migrations/__init__.py": "",
};

describe("parseStorageSize", () => {
  it("parses binary and decimal suffixes", () => {
    expect(parseStorageSize("2Gi")).toBe(2 * 1024 ** 3);
    expect(parseStorageSize("500Mi")).toBe(500 * 1024 ** 2);
    expect(parseStorageSize("1Ki")).toBe(1024);
    expect(parseStorageSize("1K")).toBe(1000);
    expect(parseStorageSize("10")).toBe(10);
  });

  it("returns null for unparseable sizes", () => {
    expect(parseStorageSize("big")).toBeNull();
    expect(parseStorageSize("")).toBeNull();
  });
});

describe("resolveTemplate", () => {
  const values = {
    global: { namespace: "tasks-app" },
    backend: { name: "backend-tasks-app" },
  };

  it("passes plain strings through", () => {
    expect(resolveTemplate("tasks-db", values)).toBe("tasks-db");
  });

  it("resolves .Values references with and without spaces", () => {
    expect(resolveTemplate("{{.Values.backend.name}}", values)).toBe(
      "backend-tasks-app",
    );
    expect(resolveTemplate("{{ .Values.global.namespace }}", values)).toBe(
      "tasks-app",
    );
    expect(resolveTemplate("svc-{{.Values.backend.name}}", values)).toBe(
      "svc-backend-tasks-app",
    );
  });

  it("returns null for unresolvable or non-.Values expressions", () => {
    expect(resolveTemplate("{{.Values.missing.name}}", values)).toBeNull();
    expect(resolveTemplate("{{if .Values.x}}a{{end}}", values)).toBeNull();
  });
});

describe("loadValues", () => {
  it("loads values.yaml", () => {
    const dir = writeRepo(HELM_REPO);
    const values = loadValues(dir);
    expect(values).toMatchObject({
      global: { namespace: "tasks-app" },
      backend: { name: "backend-tasks-app" },
    });
  });
});

describe("collectManifests", () => {
  it("discovers deployments, services, apps and PVCs with resolved names", () => {
    const dir = writeRepo(HELM_REPO);
    const set = collectManifests(dir);
    expect(set.deployments).toHaveLength(1);
    expect(set.deployments[0]).toMatchObject({
      kind: "Deployment",
      name: "backend-tasks-app",
      namespace: "tasks-app",
      matchLabels: { app: "backend-tasks-app" },
    });
    expect(set.services).toHaveLength(2);
    const backendSvc = set.services.find((s) => s.file.includes("backend"));
    expect(backendSvc).toMatchObject({
      name: "backend-tasks-svc",
      namespace: "tasks-app",
    });
    // The frontend service references values that do not exist —
    // its name is unresolvable, and the check must say so.
    const frontendSvc = set.services.find((s) => s.file.includes("frontend"));
    expect(frontendSvc?.name).toBeNull();
    expect(set.applications).toHaveLength(1);
    expect(set.applications[0]).toMatchObject({ name: "tasks-app" });
    expect(set.pvcs).toHaveLength(1);
    expect(set.pvcs[0]).toMatchObject({
      name: "tasks-db-storage",
      capacityBytes: 2 * 1024 ** 3,
    });
  });
});

describe("collectDjangoMigrations", () => {
  it("collects migration files with their app label", () => {
    const dir = writeRepo(HELM_REPO);
    const migrations = collectDjangoMigrations(dir);
    expect(migrations).toHaveLength(2);
    expect(migrations.map((m) => `${m.app}/${m.name}`).sort()).toEqual([
      "tasks/0001_initial",
      "tasks/0002_add_field",
    ]);
  });
});
