import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptGitHub } from "../src/ci/github.js";
import { adaptGitLab } from "../src/ci/gitlab.js";
import {
  detectCiSources,
  parseCiSelection,
  resolveCiSources,
} from "../src/ci/detect.js";

const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** Inline copy of the GitLab fixture's structure (the real file lives outside this repo). */
const GITLAB_FIXTURE = `image: node:latest

services:
  - mysql:latest
  - redis:latest
  - postgres:latest

cache:
  paths:
    - node_modules/

test_async:
  script:
    - npm install
    - node ./specs/start.js ./specs/async.spec.js

test_db:
  script:
    - npm install
    - node ./specs/start.js ./specs/db-postgres.spec.js

deploy:
  stage: deploy
  script: echo "Define your deployment script!"
  environment: production
`;

describe("adaptGitHub", () => {
  it("restates a workflow in the common model, 1:1", () => {
    const yaml = `name: ci
on:
  push:
    branches: [main]
  pull_request:
permissions: write-all
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - uses: actions/setup-node@${SHA_B}
        with:
          node-version: "20"
          cache: npm
      - run: npm ci
      - run: npm test
`;
    const pipeline = adaptGitHub(yaml, ".github/workflows/ci.yml");
    expect(pipeline).not.toBeNull();
    expect(pipeline!.source).toBe("github");
    expect(pipeline!.triggers).toEqual(["push", "pull_request"]);
    expect(pipeline!.topPermissions).toEqual({
      value: "write-all",
      line: 6,
    });
    expect(pipeline!.pullRequestTargetLine).toBeNull();
    expect(pipeline!.images).toEqual([]);
    expect(pipeline!.includes).toEqual([]);

    expect(pipeline!.jobs).toHaveLength(1);
    const job = pipeline!.jobs[0];
    expect(job.id).toBe("test");
    expect(job.line).toBe(8);
    expect(job.timeoutLine).toBe(10);
    expect(job.environmentLine).toBeNull();
    expect(job.permissionsValue).toBeNull();

    expect(job.steps).toHaveLength(4);
    expect(job.steps[0].action).toEqual({
      ref: `actions/checkout@${SHA}`,
      line: 12,
    });
    expect(job.steps[0].persistCredentials).toBe(false);
    expect(job.steps[1].action!.ref).toContain("actions/setup-node@");
    expect(job.steps[1].cache).toBe("npm");
    expect(job.steps[2].script).toEqual({ text: "npm ci", line: 19 });
    expect(job.steps[3].script).toEqual({ text: "npm test", line: 20 });
  });

  it("returns null for a document with no top-level mapping", () => {
    expect(adaptGitHub("- just\n- a\n- list\n", "ci.yml")).toBeNull();
  });
});

describe("adaptGitLab", () => {
  it("parses the fixture: images, services, 3 jobs, no timeouts", () => {
    const pipeline = adaptGitLab(GITLAB_FIXTURE, ".gitlab-ci.yml");
    expect(pipeline).not.toBeNull();
    expect(pipeline!.source).toBe("gitlab");
    expect(pipeline!.triggers).toEqual([]);
    expect(pipeline!.includes).toEqual([]);
    expect(pipeline!.pullRequestTargetLine).toBeNull();

    expect(pipeline!.images).toEqual([
      { ref: "node:latest", line: 1, kind: "image" },
      { ref: "mysql:latest", line: 4, kind: "service" },
      { ref: "redis:latest", line: 5, kind: "service" },
      { ref: "postgres:latest", line: 6, kind: "service" },
    ]);

    expect(pipeline!.jobs.map((job) => job.id)).toEqual([
      "test_async",
      "test_db",
      "deploy",
    ]);
    for (const job of pipeline!.jobs) {
      expect(job.timeoutLine).toBeNull();
      expect(job.permissionsValue).toBeNull();
      expect(job.manual).toBe(false);
    }
    const deploy = pipeline!.jobs[2];
    expect(deploy.line).toBe(22);
    expect(deploy.environmentLine).toBe(25);
    expect(deploy.steps).toHaveLength(1);
    expect(deploy.steps[0].script).toEqual({
      text: 'echo "Define your deployment script!"',
      line: 24,
    });
    const testAsync = pipeline!.jobs[0];
    expect(testAsync.steps[0].script).toEqual({
      text: "npm install\nnode ./specs/start.js ./specs/async.spec.js",
      line: 14,
    });
  });

  it("parses include: entries with and without a fixed ref", () => {
    const yaml = `include:
  - remote: 'https://example.com/ci.yml'
  - project: 'group/proj'
    file: '/templates/test.yml'
    ref: 'v1.2.0'
  - local: '/templates/local.yml'
  - template: 'Jobs/Build.gitlab-ci.yml'

test:
  script: echo hi
`;
    const pipeline = adaptGitLab(yaml, ".gitlab-ci.yml");
    expect(pipeline!.includes).toEqual([
      {
        kind: "remote",
        ref: null,
        line: 2,
        raw: "https://example.com/ci.yml",
      },
      {
        kind: "project",
        ref: "v1.2.0",
        line: 3,
        raw: "group/proj",
      },
      { kind: "local", ref: null, line: 6, raw: "/templates/local.yml" },
      {
        kind: "template",
        ref: null,
        line: 7,
        raw: "Jobs/Build.gitlab-ci.yml",
      },
    ]);
  });

  it("reads job image, timeout, resource_group, manual, and skips hidden jobs", () => {
    const yaml = `image: node:20

.hidden-template:
  script: echo hidden

build:
  image: node:20-alpine
  timeout: 10 minutes
  resource_group: production
  when: manual
  script:
    - npm ci
    - npm run build

deploy:
  stage: deploy
  environment:
    name: production
    url: https://example.com
  script: echo deploy
`;
    const pipeline = adaptGitLab(yaml, ".gitlab-ci.yml");
    expect(pipeline!.images).toEqual([
      { ref: "node:20", line: 1, kind: "image" },
    ]);
    expect(pipeline!.jobs.map((job) => job.id)).toEqual([
      "build",
      "deploy",
    ]);
    const build = pipeline!.jobs[0];
    expect(build.image).toEqual({ ref: "node:20-alpine", line: 7 });
    expect(build.timeoutLine).toBe(8);
    expect(build.resourceGroup).toEqual({ value: "production", line: 9 });
    expect(build.manual).toBe(true);
    expect(build.steps[0].script).toEqual({
      text: "npm ci\nnpm run build",
      line: 12,
    });
    const deploy = pipeline!.jobs[1];
    expect(deploy.environmentLine).toBe(18);
    expect(deploy.manual).toBe(false);
  });

  it("returns null for a document with no top-level mapping", () => {
    expect(adaptGitLab("- just\n- a\n- list\n", ".gitlab-ci.yml")).toBeNull();
  });
});

describe("detectCiSources", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pd-detect-"));
    dirs.push(dir);
    return dir;
  }

  it("finds nothing in an empty dir", () => {
    expect(detectCiSources(makeDir())).toEqual([]);
  });

  it("finds gitlab from .gitlab-ci.yml", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".gitlab-ci.yml"), "test:\n  script: echo hi\n");
    expect(detectCiSources(dir)).toEqual(["gitlab"]);
  });

  it("finds github from .github/workflows", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "on: push\n");
    expect(detectCiSources(dir)).toEqual(["github"]);
  });

  it("finds both when both are present", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".gitlab-ci.yml"), "test:\n  script: echo hi\n");
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "on: push\n");
    expect(detectCiSources(dir)).toEqual(["gitlab", "github"]);
  });
});

describe("parseCiSelection / resolveCiSources", () => {
  it("defaults to auto and rejects unknown values", () => {
    expect(parseCiSelection(undefined)).toBe("auto");
    expect(parseCiSelection("auto")).toBe("auto");
    expect(parseCiSelection("gitlab")).toBe("gitlab");
    expect(() => parseCiSelection("jenkins")).toThrow("--ci");
  });

  it("auto resolves to what was detected, explicit wins", () => {
    expect(resolveCiSources("auto", ["gitlab"])).toEqual(["gitlab"]);
    expect(resolveCiSources("auto", [])).toEqual([]);
    expect(resolveCiSources("gitlab", ["github"])).toEqual(["gitlab"]);
  });
});
