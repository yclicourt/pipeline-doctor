import { describe, it, expect } from "vitest";
import { checkHygiene } from "../src/checks/hygiene.js";

const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);

function findingsFor(yaml: string, rule: string) {
  return checkHygiene(yaml, ".github/workflows/test.yml").filter(
    (f) => f.rule === rule,
  );
}

/** A workflow that must produce zero findings from every hygiene rule. */
const CLEAN = `name: ci
on:
  pull_request:
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
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

describe("hygiene/no-timeout", () => {
  it("flags a job without timeout-minutes", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    const found = findingsFor(yaml, "hygiene/no-timeout");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].line).toBe(4);
    expect(found[0].detail).toContain('job "test"');
    expect(found[0].fix).toContain("timeout-minutes: 10");
  });

  it("passes a job with timeout-minutes", () => {
    expect(findingsFor(CLEAN, "hygiene/no-timeout")).toHaveLength(0);
  });
});

describe("hygiene/no-concurrency", () => {
  it("flags a PR workflow without any concurrency block", () => {
    const yaml = `name: ci
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm test
`;
    const found = findingsFor(yaml, "hygiene/no-concurrency");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].line).toBe(3);
    expect(found[0].fix).toContain("cancel-in-progress: true");
  });

  it("flags a PR workflow whose concurrency lacks cancel-in-progress", () => {
    const yaml = `name: ci
on:
  pull_request:
concurrency:
  group: ci
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm test
`;
    const found = findingsFor(yaml, "hygiene/no-concurrency");
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(5);
  });

  it("passes a PR workflow with cancel-in-progress: true", () => {
    expect(findingsFor(CLEAN, "hygiene/no-concurrency")).toHaveLength(0);
  });

  it("passes a push-only workflow without concurrency", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm test
`;
    expect(findingsFor(yaml, "hygiene/no-concurrency")).toHaveLength(0);
  });
});

describe("hygiene/unprotected-deploy", () => {
  it("flags a deploy job without environment:", () => {
    const yaml = `name: ci
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: echo deploying
`;
    const found = findingsFor(yaml, "hygiene/unprotected-deploy");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].line).toBe(4);
    expect(found[0].detail).toContain('deploy job "deploy"');
    expect(found[0].fix).toContain("environment: production");
  });

  it("flags a job that deploys via a known deploy action", () => {
    const yaml = `name: ci
on: push
jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: example.com
`;
    expect(findingsFor(yaml, "hygiene/unprotected-deploy")).toHaveLength(1);
  });

  it("passes a deploy job with environment: set", () => {
    const yaml = `name: ci
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: production
    steps:
      - run: echo deploying
`;
    expect(findingsFor(yaml, "hygiene/unprotected-deploy")).toHaveLength(0);
  });

  it("passes a non-deploy job without environment:", () => {
    expect(findingsFor(CLEAN, "hygiene/unprotected-deploy")).toHaveLength(0);
  });
});

describe("hygiene/no-cache", () => {
  it("flags setup-node without cache", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
`;
    const found = findingsFor(yaml, "hygiene/no-cache");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].line).toBe(8);
    expect(found[0].fix).toContain("cache: npm");
  });

  it("passes setup-node with cache: pnpm", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/setup-node@${SHA}
        with:
          node-version: "20"
          cache: pnpm
`;
    expect(findingsFor(yaml, "hygiene/no-cache")).toHaveLength(0);
  });

  it("passes a workflow without setup-node", () => {
    expect(findingsFor(CLEAN, "hygiene/no-cache")).toHaveLength(0);
  });
});

describe("clean workflow", () => {
  it("produces zero findings from every hygiene rule", () => {
    expect(checkHygiene(CLEAN, ".github/workflows/ci.yml")).toHaveLength(0);
  });

  it("returns no findings for an empty file", () => {
    expect(checkHygiene("", ".github/workflows/empty.yml")).toHaveLength(0);
  });
});
