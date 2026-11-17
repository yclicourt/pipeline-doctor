import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptGitLab } from "../src/ci/gitlab.js";
import { checkWorkflowModel } from "../src/checks/workflow.js";
import { checkHygieneModel } from "../src/checks/hygiene.js";
import { runCheck } from "../src/runner.js";

/** Same structure as the real GitLab fixture (which lives outside this repo). */
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

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-doctor-test-"));
}

function gitlabPipeline(yaml: string) {
  const pipeline = adaptGitLab(yaml, ".gitlab-ci.yml");
  expect(pipeline).not.toBeNull();
  return pipeline!;
}

function findingsFor(
  yaml: string,
  rule: string,
  check: (p: ReturnType<typeof gitlabPipeline>) => ReturnType<
    typeof checkWorkflowModel
  >,
) {
  return check(gitlabPipeline(yaml)).filter((f) => f.rule === rule);
}

describe("workflow/unpinned-action on GitLab", () => {
  it("flags the fixture's 4 unpinned images (1 image + 3 services)", () => {
    const found = findingsFor(
      GITLAB_FIXTURE,
      "workflow/unpinned-action",
      checkWorkflowModel,
    );
    expect(found).toHaveLength(4);
    expect(found.map((f) => f.line)).toEqual([1, 4, 5, 6]);
    expect(found.every((f) => f.severity === "error")).toBe(true);
    expect(found[0].detail).toContain("node:latest");
    expect(found[0].fix).toContain("@sha256:");
  });

  it("passes an image pinned by digest", () => {
    const yaml = `image: node@sha256:${"a".repeat(64)}

test:
  script: echo hi
  timeout: 10 minutes
`;
    expect(
      findingsFor(yaml, "workflow/unpinned-action", checkWorkflowModel),
    ).toHaveLength(0);
  });

  it("flags a remote include, passes a project include with ref", () => {
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
    const found = findingsFor(yaml, "workflow/unpinned-action", checkWorkflowModel);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
    expect(found[0].detail).toContain("remote include");
  });

  it("flags a project include without ref:", () => {
    const yaml = `include:
  - project: 'group/proj'
    file: '/templates/test.yml'

test:
  script: echo hi
`;
    const found = findingsFor(yaml, "workflow/unpinned-action", checkWorkflowModel);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("no ref:");
  });
});

describe("workflow/template-injection on GitLab", () => {
  it("flags an untrusted variable expanded in script:", () => {
    const yaml = `test:
  script:
    - echo "$CI_COMMIT_MESSAGE"
`;
    const found = findingsFor(
      yaml,
      "workflow/template-injection",
      checkWorkflowModel,
    );
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("$CI_COMMIT_MESSAGE");
  });

  it("flags the braced form too", () => {
    const yaml = `test:
  script: echo \${CI_MERGE_REQUEST_TITLE}
`;
    expect(
      findingsFor(yaml, "workflow/template-injection", checkWorkflowModel),
    ).toHaveLength(1);
  });

  it("passes ordinary variables ($CI_JOB_ID, $MY_VAR)", () => {
    const yaml = `test:
  script:
    - echo $CI_JOB_ID
    - echo $MY_VAR
`;
    expect(
      findingsFor(yaml, "workflow/template-injection", checkWorkflowModel),
    ).toHaveLength(0);
  });
});

describe("GitHub-only workflow rules stay silent on GitLab", () => {
  it("no pull-request-target / persist-credentials / untrusted-input / excessive-permissions on the fixture", () => {
    const found = checkWorkflowModel(gitlabPipeline(GITLAB_FIXTURE));
    expect(found.map((f) => f.rule)).toEqual(
      expect.arrayContaining(["workflow/unpinned-action"]),
    );
    expect(found.map((f) => f.rule)).not.toContain(
      "workflow/pull-request-target",
    );
    expect(found.map((f) => f.rule)).not.toContain(
      "workflow/persist-credentials",
    );
    expect(found.map((f) => f.rule)).not.toContain(
      "workflow/untrusted-input-in-run",
    );
    expect(found.map((f) => f.rule)).not.toContain(
      "workflow/excessive-permissions",
    );
  });
});

describe("hygiene on GitLab", () => {
  it("flags the fixture's 3 jobs without timeout:", () => {
    const found = findingsFor(
      GITLAB_FIXTURE,
      "hygiene/no-timeout",
      checkHygieneModel,
    );
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.line)).toEqual([12, 17, 22]);
    expect(found.every((f) => f.severity === "warning")).toBe(true);
    expect(found[0].fix).toContain("timeout: 10 minutes");
  });

  it("passes a job with timeout:", () => {
    const yaml = `test:
  timeout: 10 minutes
  script: echo hi
`;
    expect(
      findingsFor(yaml, "hygiene/no-timeout", checkHygieneModel),
    ).toHaveLength(0);
  });

  it("flags a deploy job without environment:, passes one with it", () => {
    const without = `deploy:
  stage: deploy
  script: echo deploy
`;
    const found = findingsFor(
      without,
      "hygiene/unprotected-deploy",
      checkHygieneModel,
    );
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain('deploy job "deploy"');
    expect(
      findingsFor(
        GITLAB_FIXTURE,
        "hygiene/unprotected-deploy",
        checkHygieneModel,
      ),
    ).toHaveLength(0);
  });

  it("no-concurrency and no-cache stay silent on GitLab", () => {
    const found = checkHygieneModel(gitlabPipeline(GITLAB_FIXTURE));
    expect(found.map((f) => f.rule)).not.toContain("hygiene/no-concurrency");
    expect(found.map((f) => f.rule)).not.toContain("hygiene/no-cache");
  });
});

describe("runner --ci selection", () => {
  it("audits a .gitlab-ci.yml with --only workflow (auto)", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitlab-ci.yml"), GITLAB_FIXTURE);
    const result = await runCheck({ only: "workflow", targetDir: dir });
    expect(result.exitCode).toBe(1);
    expect(
      result.report.findings.filter(
        (f) => f.rule === "workflow/unpinned-action",
      ),
    ).toHaveLength(4);
    expect(result.report.stats.workflows).toBe(1);
  });

  it("audits a .gitlab-ci.yml with --only hygiene (auto)", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitlab-ci.yml"), GITLAB_FIXTURE);
    const result = await runCheck({ only: "hygiene", targetDir: dir });
    expect(result.exitCode).toBe(0);
    expect(
      result.report.findings.filter((f) => f.rule === "hygiene/no-timeout"),
    ).toHaveLength(3);
  });

  it("--ci github skips a GitLab-only repo", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitlab-ci.yml"), GITLAB_FIXTURE);
    const result = await runCheck({
      only: "workflow",
      ci: "github",
      targetDir: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.findings).toEqual([]);
    expect(result.report.stats.workflows).toBe(0);
  });

  it("--ci gitlab skips a GitHub-only repo, auto finds it", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`,
    );
    const gitlabOnly = await runCheck({
      only: "workflow",
      ci: "gitlab",
      targetDir: dir,
    });
    expect(gitlabOnly.report.findings).toEqual([]);
    const auto = await runCheck({ only: "workflow", targetDir: dir });
    expect(
      auto.report.findings.filter(
        (f) => f.rule === "workflow/unpinned-action",
      ),
    ).toHaveLength(1);
  });
});

/** Second fixture: remote include, untrusted variable, passing timeouts. */
const GITLAB_FIXTURE_2 = `include:
  - remote: 'https://example.com/shared-ci.yml'
  - project: 'acme/templates'
    file: '/jobs/test.yml'
    ref: 'v2.1.0'

image: node:20@sha256:${"a".repeat(64)}

stages:
  - test
  - deploy

test:
  stage: test
  timeout: 30 minutes
  script:
    - npm ci
    - npm test
  needs:
    - job: build
      optional: true

build:
  stage: test
  script:
    - echo "$CI_COMMIT_MESSAGE"
    - npm run build

deploy:
  stage: deploy
  timeout: 10 minutes
  environment: production
  script: echo "Deploying to production"
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
`;

describe("second GitLab fixture: one realistic file, full finding set", () => {
  it("finds exactly 2 errors + 1 warning, nothing else", () => {
    const pipeline = gitlabPipeline(GITLAB_FIXTURE_2);
    const workflow = checkWorkflowModel(pipeline);
    expect(workflow.map((f) => [f.rule, f.line])).toEqual([
      ["workflow/unpinned-action", 2],
      ["workflow/template-injection", 26],
    ]);
    const hygiene = checkHygieneModel(pipeline);
    expect(hygiene).toHaveLength(1);
    expect(hygiene[0].rule).toBe("hygiene/no-timeout");
    expect(hygiene[0].line).toBe(23);
  });

  it("the project include with ref and the digested image pass", () => {
    const pipeline = gitlabPipeline(GITLAB_FIXTURE_2);
    expect(pipeline.includes).toHaveLength(2);
    expect(pipeline.images).toEqual([
      { ref: `node:20@sha256:${"a".repeat(64)}`, line: 7, kind: "image" },
    ]);
  });

  it("needs: and rules: parse without breaking the jobs around them", () => {
    const pipeline = gitlabPipeline(GITLAB_FIXTURE_2);
    expect(pipeline.jobs.map((job) => job.id)).toEqual([
      "test",
      "build",
      "deploy",
    ]);
    expect(pipeline.jobs[0].timeoutLine).toBe(15);
    expect(pipeline.jobs[2].environmentLine).toBe(32);
  });

  it("audits the second fixture end to end (2 errors + 1 warning)", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitlab-ci.yml"), GITLAB_FIXTURE_2);
    const workflow = await runCheck({ only: "workflow", targetDir: dir });
    expect(workflow.exitCode).toBe(1);
    expect(workflow.report.findings.map((f) => f.rule).sort()).toEqual([
      "workflow/template-injection",
      "workflow/unpinned-action",
    ]);
    const hygiene = await runCheck({ only: "hygiene", targetDir: dir });
    expect(hygiene.exitCode).toBe(0);
    expect(hygiene.report.findings).toHaveLength(1);
    expect(hygiene.report.findings[0].rule).toBe("hygiene/no-timeout");
  });
});
