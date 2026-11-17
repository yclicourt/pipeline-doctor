import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkCi } from "../src/checks/ci.js";
import type { DeployEnv } from "../src/env.js";

const SHA40 = "839a92fa2dc339c9d3a5a3316e07ed6dd0bae30b";
const DIGEST = `sha256:${"a".repeat(64)}`;
const DIGEST_OTHER = `sha256:${"b".repeat(64)}`;

const ALL_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=()",
};

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

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function initRepoWithRemote(remote: string): string {
  const dir = tempDir();
  git(dir, "init", "-q");
  git(
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-qm",
    "init",
  );
  git(dir, "remote", "add", "origin", remote);
  return dir;
}

const EMPTY_ENV: DeployEnv = {};

const noFetch: typeof fetch = (async () => {
  throw new Error("unexpected fetch call");
}) as typeof fetch;

function mockFetch(
  handler: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request) =>
    handler(String(input))) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function findingsFor(
  result: Awaited<ReturnType<typeof checkCi>>,
  rule: string,
) {
  return result.findings.filter((f) => f.rule === rule);
}

function skippedFor(
  result: Awaited<ReturnType<typeof checkCi>>,
  rule: string,
) {
  return result.skipped.filter((s) => s.rule === rule);
}

const WORKFLOW_SHA_TAGS = `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v6
        with:
          tags: |
            harbor.example.com/proj/app:\${{ github.sha }}
`;

describe("CI-01 image tag is a SHA", () => {
  it("passes when CI tags with github.sha and the manifest carries a SHA", async () => {
    const dir = writeRepo({
      ".github/workflows/ci.yml": WORKFLOW_SHA_TAGS,
      "helm/values.yaml": `backend:
  image:
    repository: proj/app
    tag: ${SHA40}
`,
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(findingsFor(result, "ci/unpinned-image-tag")).toEqual([]);
  });

  it("flags a literal tag in the workflow and in the manifest", async () => {
    const dir = writeRepo({
      ".github/workflows/ci.yml": `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v6
        with:
          tags: |
            harbor.example.com/proj/app:v1.2.3
`,
      "helm/values.yaml": `frontend:
  image:
    repository: proj/app
    tag: latest
`,
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    const found = findingsFor(result, "ci/unpinned-image-tag");
    expect(found).toHaveLength(2);
    expect(found[0].severity).toBe("error");
  });

  it("skips when no images are built in workflows", async () => {
    const dir = writeRepo({});
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(skippedFor(result, "ci/unpinned-image-tag")).toHaveLength(1);
  });

  it("does not hold third-party images to the SHA rule", async () => {
    const dir = writeRepo({
      ".github/workflows/ci.yml": WORKFLOW_SHA_TAGS,
      "helm/values.yaml": `postgres:
  image:
    repository: oficial-images/postgres
    tag: alpine
`,
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(findingsFor(result, "ci/unpinned-image-tag")).toEqual([]);
  });
});

describe("CI-02 digest matches Harbor", () => {
  const HARBOR_ENV: DeployEnv = {
    harborUrl: "https://harbor.example.com",
    harborUser: "robot$test+ci",
    harborToken: "harbor-token",
  };

  function manifestWithDigest(digest: string): Record<string, string> {
    return {
      "helm/values.yaml": `app:
  image: harbor.example.com/proj/app@${digest}
`,
    };
  }

  it("passes when Harbor stores the pinned digest", async () => {
    const dir = writeRepo(manifestWithDigest(DIGEST));
    let seenUrl = "";
    const fetchFn = mockFetch((url) => {
      seenUrl = url;
      return jsonResponse({ digest: DIGEST });
    });
    const result = await checkCi(dir, { env: HARBOR_ENV, fetchFn });
    expect(findingsFor(result, "ci/digest-mismatch-harbor")).toEqual([]);
    expect(seenUrl).toContain(
      "/api/v2.0/projects/proj/repositories/app/artifacts/",
    );
  });

  it("flags a digest mismatch", async () => {
    const dir = writeRepo(manifestWithDigest(DIGEST));
    const fetchFn = mockFetch(() => jsonResponse({ digest: DIGEST_OTHER }));
    const result = await checkCi(dir, { env: HARBOR_ENV, fetchFn });
    const found = findingsFor(result, "ci/digest-mismatch-harbor");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain(DIGEST_OTHER);
  });

  it("flags an image missing from Harbor", async () => {
    const dir = writeRepo(manifestWithDigest(DIGEST));
    const fetchFn = mockFetch(() => jsonResponse({ errors: [] }, 404));
    const result = await checkCi(dir, { env: HARBOR_ENV, fetchFn });
    expect(findingsFor(result, "ci/digest-mismatch-harbor")).toHaveLength(1);
  });

  it("skips when Harbor credentials are missing", async () => {
    const dir = writeRepo(manifestWithDigest(DIGEST));
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    const skipped = skippedFor(result, "ci/digest-mismatch-harbor");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("PIPELINE_DOCTOR_HARBOR_URL");
  });

  it("skips when nothing is pinned by digest", async () => {
    const dir = writeRepo({});
    const result = await checkCi(dir, { env: HARBOR_ENV, fetchFn: noFetch });
    expect(skippedFor(result, "ci/digest-mismatch-harbor")).toHaveLength(1);
  });
});

describe("CI-03 no latest anywhere", () => {
  it("flags latest in a manifest, an untagged compose image and a FROM", async () => {
    const dir = writeRepo({
      "helm/values.yaml": `app:
  image: my-app:latest
`,
      "docker-compose.yml": `services:
  cache:
    image: redis
`,
      "Dockerfile": `FROM node:latest
`,
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(findingsFor(result, "ci/latest-tag")).toHaveLength(3);
  });

  it("passes when every image is pinned", async () => {
    const dir = writeRepo({
      "helm/values.yaml": `app:
  image: my-app:${SHA40}
`,
      "Dockerfile": `FROM node:22-alpine
USER app
HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1
COPY . .
`,
      ".dockerignore": "node_modules\n",
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(findingsFor(result, "ci/latest-tag")).toEqual([]);
  });
});

describe("CI-04 commit is HEAD, tree clean", () => {
  it("passes on a clean repo", async () => {
    const dir = initRepoWithRemote("https://github.com/o/r.git");
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(findingsFor(result, "ci/dirty-tree")).toEqual([]);
  });

  it("flags uncommitted changes", async () => {
    const dir = initRepoWithRemote("https://github.com/o/r.git");
    writeFileSync(join(dir, "dirty.txt"), "x\n");
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    const found = findingsFor(result, "ci/dirty-tree");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("1 uncommitted change");
  });

  it("skips when the directory is not a git repo", async () => {
    const dir = writeRepo({});
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(skippedFor(result, "ci/dirty-tree")).toHaveLength(1);
  });
});

describe("CI-05 OWASP Docker Top 10", () => {
  it("passes a clean Dockerfile", async () => {
    const dir = writeRepo({
      "Dockerfile": `FROM node:22-alpine
USER app
HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1
COPY . .
`,
      ".dockerignore": "node_modules\n",
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(
      result.findings.filter((f) => f.rule.startsWith("ci/docker-")),
    ).toEqual([]);
  });

  it("flags root, no healthcheck, ADD, apt and no .dockerignore", async () => {
    const dir = writeRepo({
      "Dockerfile": `FROM node:22-alpine
RUN apt-get update && apt-get install -y curl
ADD . /app
`,
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    const docker = result.findings.filter((f) =>
      f.rule.startsWith("ci/docker-"),
    );
    expect(docker.map((f) => f.rule).sort()).toEqual([
      "ci/docker-add",
      "ci/docker-apt",
      "ci/docker-no-dockerignore",
      "ci/docker-no-healthcheck",
      "ci/docker-no-user",
    ]);
    expect(
      docker.find((f) => f.rule === "ci/docker-no-user")?.severity,
    ).toBe("error");
  });

  it("flags USER root in the final stage", async () => {
    const dir = writeRepo({
      "Dockerfile": `FROM node:22-alpine AS build
USER root
FROM node:22-alpine
USER root
`,
      ".dockerignore": "x\n",
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    const found = findingsFor(result, "ci/docker-no-user");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("USER root");
  });

  it("does not flag a builder stage that runs as root", async () => {
    const dir = writeRepo({
      "Dockerfile": `FROM node:22-alpine AS build
USER root
RUN npm ci
FROM node:22-alpine
USER app
HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1
COPY --from=build /app /app
`,
      ".dockerignore": "x\n",
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(findingsFor(result, "ci/docker-no-user")).toEqual([]);
  });

  it("accepts a BuildKit cache mount instead of apt cleanup", async () => {
    const dir = writeRepo({
      "Dockerfile": `FROM python:3.12-slim
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update && apt-get install -y --no-install-recommends curl
USER app
HEALTHCHECK CMD curl -f http://localhost:8000/health || exit 1
COPY . .
`,
      ".dockerignore": "x\n",
    });
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(
      result.findings.filter((f) => f.rule.startsWith("ci/docker-")),
    ).toEqual([]);
  });

  it("skips when there is no Dockerfile", async () => {
    const dir = writeRepo({});
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(skippedFor(result, "ci/docker-no-user")).toHaveLength(1);
  });
});

describe("CI-06 OWASP security headers", () => {
  const APP_ENV: DeployEnv = { appUrl: "https://app.example.com" };

  it("passes when all six headers are present", async () => {
    const dir = writeRepo({});
    const fetchFn = mockFetch(
      () => new Response("ok", { status: 200, headers: ALL_HEADERS }),
    );
    const result = await checkCi(dir, { env: APP_ENV, fetchFn });
    expect(findingsFor(result, "ci/missing-security-header")).toEqual([]);
  });

  it("warns once per missing header", async () => {
    const dir = writeRepo({});
    const fetchFn = mockFetch(
      () =>
        new Response("ok", {
          status: 200,
          headers: {
            "Strict-Transport-Security": "max-age=31536000",
            "X-Content-Type-Options": "nosniff",
          },
        }),
    );
    const result = await checkCi(dir, { env: APP_ENV, fetchFn });
    expect(findingsFor(result, "ci/missing-security-header")).toHaveLength(4);
  });

  it("skips without an app URL", async () => {
    const dir = writeRepo({});
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(skippedFor(result, "ci/missing-security-header")).toHaveLength(1);
  });

  it("skips when the app does not answer", async () => {
    const dir = writeRepo({});
    const fetchFn = mockFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await checkCi(dir, { env: APP_ENV, fetchFn });
    const skipped = skippedFor(result, "ci/missing-security-header");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("DEP-05");
  });
});

describe("CI-07 last CI run all-green", () => {
  const GH_ENV: DeployEnv = { githubToken: "ghp_testtoken" };

  function githubFetch(conclusion: string | null, status = 200): typeof fetch {
    return mockFetch((url) => {
      if (url.includes("/actions/runs")) {
        return jsonResponse(
          {
            workflow_runs:
              conclusion === null
                ? []
                : [
                    {
                      conclusion,
                      html_url: "https://github.com/o/r/actions/runs/1",
                      head_branch: "main",
                    },
                  ],
          },
          status,
        );
      }
      return jsonResponse({ default_branch: "main" });
    });
  }

  it("passes when the latest run succeeded", async () => {
    const dir = initRepoWithRemote("https://github.com/o/r.git");
    const result = await checkCi(dir, {
      env: GH_ENV,
      fetchFn: githubFetch("success"),
    });
    expect(findingsFor(result, "ci/last-run-not-green")).toEqual([]);
  });

  it("flags a failed latest run", async () => {
    const dir = initRepoWithRemote("https://github.com/o/r.git");
    const result = await checkCi(dir, {
      env: GH_ENV,
      fetchFn: githubFetch("failure"),
    });
    const found = findingsFor(result, "ci/last-run-not-green");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].detail).toContain("failure");
  });

  it("skips without a token", async () => {
    const dir = initRepoWithRemote("https://github.com/o/r.git");
    const result = await checkCi(dir, { env: EMPTY_ENV, fetchFn: noFetch });
    expect(skippedFor(result, "ci/last-run-not-green")).toHaveLength(1);
  });

  it("skips for a non-GitHub remote", async () => {
    const dir = initRepoWithRemote("https://gitlab.com/o/r.git");
    const result = await checkCi(dir, { env: GH_ENV, fetchFn: noFetch });
    const skipped = skippedFor(result, "ci/last-run-not-green");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("not a GitHub repository");
  });

  it("skips when the API rejects the token", async () => {
    const dir = initRepoWithRemote("https://github.com/o/r.git");
    const fetchFn = mockFetch((url) =>
      url.includes("/actions/runs")
        ? jsonResponse({ message: "Bad credentials" }, 401)
        : jsonResponse({ default_branch: "main" }),
    );
    const result = await checkCi(dir, { env: GH_ENV, fetchFn });
    expect(skippedFor(result, "ci/last-run-not-green")).toHaveLength(1);
  });

  it("skips when there are no completed runs yet", async () => {
    const dir = initRepoWithRemote("https://github.com/o/r.git");
    const result = await checkCi(dir, {
      env: GH_ENV,
      fetchFn: githubFetch(null),
    });
    expect(skippedFor(result, "ci/last-run-not-green")).toHaveLength(1);
  });
});
