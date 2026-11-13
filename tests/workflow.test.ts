import { describe, it, expect } from "vitest";
import { checkWorkflow } from "../src/checks/workflow.js";

const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);

function findingsFor(yaml: string, rule: string) {
  return checkWorkflow(yaml, ".github/workflows/test.yml").filter(
    (f) => f.rule === rule,
  );
}

/** A workflow that must produce zero findings from every rule. */
const CLEAN = `name: ci
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
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

describe("workflow/unpinned-action", () => {
  it("flags an action pinned by tag", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const found = findingsFor(yaml, "workflow/unpinned-action");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].line).toBe(7);
    expect(found[0].detail).toContain("@v4");
    expect(found[0].fix).toContain("SHA");
  });

  it("flags an action with no version at all", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout
`;
    expect(findingsFor(yaml, "workflow/unpinned-action")).toHaveLength(1);
  });

  it("passes an action pinned by full SHA", () => {
    expect(findingsFor(CLEAN, "workflow/unpinned-action")).toHaveLength(0);
  });

  it("ignores local and docker actions", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./my-action
      - uses: docker://alpine:3.8
`;
    expect(findingsFor(yaml, "workflow/unpinned-action")).toHaveLength(0);
  });
});

describe("workflow/pull-request-target", () => {
  it("flags pull_request_target with a checkout step", () => {
    const yaml = `name: ci
on:
  pull_request_target:
    types: [opened]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - run: npm test
`;
    const found = findingsFor(yaml, "workflow/pull-request-target");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].line).toBe(3);
  });

  it("does not flag pull_request_target without checkout", () => {
    const yaml = `name: ci
on: pull_request_target
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    expect(findingsFor(yaml, "workflow/pull-request-target")).toHaveLength(0);
  });

  it("passes pull_request with checkout", () => {
    expect(findingsFor(CLEAN, "workflow/pull-request-target")).toHaveLength(0);
  });
});

describe("workflow/template-injection", () => {
  it("flags github.event interpolated directly in run:", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"
`;
    const found = findingsFor(yaml, "workflow/template-injection");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].fix).toContain("env");
  });

  it("passes run: that only uses env vars", () => {
    expect(findingsFor(CLEAN, "workflow/template-injection")).toHaveLength(0);
  });
});

describe("workflow/excessive-permissions", () => {
  it("flags permissions: write-all", () => {
    const yaml = `name: ci
on: push
permissions: write-all
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const found = findingsFor(yaml, "workflow/excessive-permissions");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].line).toBe(3);
  });

  it("flags write-all at job level", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - run: echo hi
`;
    expect(findingsFor(yaml, "workflow/excessive-permissions")).toHaveLength(1);
  });

  it("passes a scoped read-only permissions block", () => {
    expect(
      findingsFor(CLEAN, "workflow/excessive-permissions"),
    ).toHaveLength(0);
  });
});

describe("workflow/persist-credentials", () => {
  it("flags checkout with default credentials in a job that never pushes", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - run: npm test
`;
    const found = findingsFor(yaml, "workflow/persist-credentials");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].fix).toContain("persist-credentials: false");
  });

  it("flags explicit persist-credentials: true in a job that never pushes", () => {
    const yaml = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: true
      - run: npm test
`;
    expect(findingsFor(yaml, "workflow/persist-credentials")).toHaveLength(1);
  });

  it("passes checkout with persist-credentials: false", () => {
    expect(findingsFor(CLEAN, "workflow/persist-credentials")).toHaveLength(0);
  });

  it("passes checkout in a job that pushes", () => {
    const yaml = `name: ci
on: push
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - run: git push origin main
`;
    expect(findingsFor(yaml, "workflow/persist-credentials")).toHaveLength(0);
  });
});

describe("workflow/untrusted-input-in-run", () => {
  it("flags workflow_dispatch inputs interpolated in run:", () => {
    const yaml = `name: ci
on:
  workflow_dispatch:
    inputs:
      name:
        description: "name"
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ inputs.name }}"
`;
    const found = findingsFor(yaml, "workflow/untrusted-input-in-run");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
  });

  it("flags issue_comment body interpolated in run:", () => {
    const yaml = `name: ci
on: issue_comment
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.comment.body }}"
`;
    expect(
      findingsFor(yaml, "workflow/untrusted-input-in-run"),
    ).toHaveLength(1);
  });

  it("passes a workflow_dispatch job that reads inputs via env", () => {
    const yaml = `name: ci
on:
  workflow_dispatch:
    inputs:
      name:
        description: "name"
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$NAME"
        env:
          NAME: \${{ inputs.name }}
`;
    expect(
      findingsFor(yaml, "workflow/untrusted-input-in-run"),
    ).toHaveLength(0);
  });

  it("does not flag inputs on a push-only workflow", () => {
    expect(
      findingsFor(CLEAN, "workflow/untrusted-input-in-run"),
    ).toHaveLength(0);
  });
});

describe("clean workflow", () => {
  it("produces zero findings from every rule", () => {
    expect(checkWorkflow(CLEAN, ".github/workflows/ci.yml")).toHaveLength(0);
  });

  it("returns no findings for an empty file", () => {
    expect(checkWorkflow("", ".github/workflows/empty.yml")).toHaveLength(0);
  });
});
