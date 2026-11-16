import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseImageRef,
  isShaTag,
  isLatestTag,
  collectImageReferences,
  ciBuiltRepositories,
} from "../src/checks/images.js";

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

describe("parseImageRef", () => {
  it("parses a bare name", () => {
    const ref = parseImageRef("nginx", "f", 1, "compose");
    expect(ref.repository).toBe("nginx");
    expect(ref.tag).toBeUndefined();
    expect(ref.registry).toBeUndefined();
    expect(ref.digest).toBeUndefined();
  });

  it("parses name:tag", () => {
    const ref = parseImageRef("postgres:alpine", "f", 1, "compose");
    expect(ref.repository).toBe("postgres");
    expect(ref.tag).toBe("alpine");
  });

  it("parses registry/repo:tag", () => {
    const ref = parseImageRef(
      "quay.io/minio/minio:latest",
      "f",
      1,
      "manifest",
    );
    expect(ref.registry).toBe("quay.io");
    expect(ref.repository).toBe("minio/minio");
    expect(ref.tag).toBe("latest");
  });

  it("parses a digest pin", () => {
    const ref = parseImageRef(
      "harbor.example.com/proj/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "f",
      1,
      "manifest",
    );
    expect(ref.registry).toBe("harbor.example.com");
    expect(ref.repository).toBe("proj/app");
    expect(ref.digest).toBe(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(ref.tag).toBeUndefined();
  });

  it("treats a registry expression as the registry", () => {
    const ref = parseImageRef(
      "${{vars.HARBOR_REGISTRY}}/backend-django-tasks/backend-django-tasks:${{ github.sha }}",
      "f",
      1,
      "workflow-tags",
    );
    expect(ref.isExpression).toBe(true);
    expect(ref.repository).toBe("backend-django-tasks/backend-django-tasks");
    expect(ref.tag).toBe("${{ github.sha }}");
  });

  it("parses a registry with a port", () => {
    const ref = parseImageRef("localhost:5000/app:1.0", "f", 1, "compose");
    expect(ref.registry).toBe("localhost:5000");
    expect(ref.repository).toBe("app");
    expect(ref.tag).toBe("1.0");
  });
});

describe("isShaTag / isLatestTag", () => {
  it("accepts 40- and 64-hex SHAs only", () => {
    expect(isShaTag("839a92fa2dc339c9d3a5a3316e07ed6dd0bae30b")).toBe(true);
    expect(isShaTag("a".repeat(64))).toBe(true);
    expect(isShaTag("latest")).toBe(false);
    expect(isShaTag("v1.2.3")).toBe(false);
    expect(isShaTag(undefined)).toBe(false);
  });

  it("treats untagged as latest, digest as not-latest", () => {
    expect(isLatestTag(parseImageRef("app:latest", "f", 1, "compose"))).toBe(
      true,
    );
    expect(isLatestTag(parseImageRef("app", "f", 1, "compose"))).toBe(true);
    expect(isLatestTag(parseImageRef("app:alpine", "f", 1, "compose"))).toBe(
      false,
    );
    expect(
      isLatestTag(
        parseImageRef(
          "app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "f",
          1,
          "manifest",
        ),
      ),
    ).toBe(false);
  });
});

describe("collectImageReferences", () => {
  it("collects refs from workflows, manifests, compose and Dockerfiles", () => {
    const dir = writeRepo({
      ".github/workflows/ci.yml": `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres:alpine
    steps:
      - uses: docker/build-push-action@v6
        with:
          tags: |
            harbor.example.com/proj/app:\${{ github.sha }}
            harbor.example.com/proj/app:latest
`,
      "helm/values.yaml": `frontend:
  image:
    repository: proj/app
    tag: latest
backend:
  image:
    repository: proj/api
    tag: 839a92fa2dc339c9d3a5a3316e07ed6dd0bae30b
db:
  image: proj/db@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`,
      "helm/values.example.yaml": `frontend:
  image:
    repository: proj/app
    tag: latest
`,
      "docker-compose.yml": `services:
  cache:
    image: redis:7-alpine
`,
      "Dockerfile": `FROM node:22-alpine AS build
COPY . .
FROM nginx:alpine
`,
    });
    const refs = collectImageReferences(dir);
    // 2 workflow tags + 1 service image + 3 manifest + 1 compose + 2 FROM.
    // The *.example.yaml is excluded on purpose.
    expect(refs).toHaveLength(9);
    const bySource = (source: string) =>
      refs.filter((r) => r.source === source);
    expect(bySource("workflow-tags")).toHaveLength(2);
    expect(bySource("workflow-image")).toHaveLength(1);
    expect(bySource("manifest")).toHaveLength(3);
    expect(bySource("compose")).toHaveLength(1);
    expect(bySource("dockerfile")).toHaveLength(2);

    const built = ciBuiltRepositories(refs);
    expect(built).toEqual(new Set(["proj/app"]));
  });

  it("reads every document of a multi-document manifest", () => {
    const dir = writeRepo({
      "k8s/apps.yaml": `apiVersion: v1
kind: Pod
metadata:
  name: one
spec:
  containers:
    - name: one
      image: quay.io/minio/minio:latest
---
apiVersion: v1
kind: Pod
metadata:
  name: two
spec:
  containers:
    - name: two
      image: quay.io/minio/mc:latest
`,
    });
    const refs = collectImageReferences(dir);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.raw).sort()).toEqual([
      "quay.io/minio/mc:latest",
      "quay.io/minio/minio:latest",
    ]);
  });

  it("ignores policy patterns like Kyverno's !*:latest", () => {
    const dir = writeRepo({
      "policies/disallow-latest.yaml": `apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
spec:
  rules:
    - name: no-latest
      match:
        any:
          - resources:
              kinds: ["Pod"]
      validate:
        message: "No latest"
        pattern:
          spec:
            containers:
              - image: "!*:latest"
`,
    });
    expect(collectImageReferences(dir)).toHaveLength(0);
  });

  it("reads Helm templates without crashing and skips templated images", () => {
    const dir = writeRepo({
      "helm/templates/app.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: "{{ .Values.app.image.repository }}:{{ .Values.app.image.tag }}"
          env:
            - name: DB
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.app.secretName }}
                  key: password
            - name: DB2
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.app.secretName }}
                  key: password
        - name: sidecar
          image: nginx:alpine
`,
    });
    const refs = collectImageReferences(dir);
    // Only the hardcoded sidecar survives; the templated image and
    // the duplicate keys (legal in a template) cause no crash.
    expect(refs).toHaveLength(1);
    expect(refs[0].raw).toBe("nginx:alpine");
  });
});
