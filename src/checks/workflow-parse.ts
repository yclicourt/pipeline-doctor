import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";

/**
 * Shared YAML workflow parsing (used by the workflow-security and
 * hygiene families). Each rule is a pure function of the workflow text,
 * so it can be unit-tested with minimal inline YAML.
 *
 * Line numbers come from the YAML AST node ranges, not from a text
 * search, so they stay right even with odd formatting.
 *
 * The `yaml` package types its Pair/YAMLMap with generics defaulting to
 * `unknown`, so every AST value crossing into our code is cast once,
 * here, to `Node | null` — and always re-checked with isMap/isSeq/
 * isScalar before use.
 */

export type YamlPair = Pair<Node, Node | null>;

export function asNode(value: unknown): Node | null {
  return (value ?? null) as Node | null;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function nodeLine(text: string, node: Node | null | undefined): number {
  if (!node || !node.range) return 1;
  return lineAt(text, node.range[0]);
}

export function pairByKey(map: YAMLMap, name: string): YamlPair | undefined {
  const found = map.items.find((pair) => {
    const key = pair.key;
    if (!isScalar(key)) return false;
    // The `yaml` package parses `on:` as the string "on" (YAML 1.2 core
    // schema), but some parsers read it as boolean true — accept both.
    return key.value === name || (name === "on" && key.value === true);
  });
  return found as YamlPair | undefined;
}

export function keyToString(key: Node | null | undefined): string {
  if (key && isScalar(key) && typeof key.value === "string") {
    return key.value;
  }
  if (key && isScalar(key) && typeof key.value === "number") {
    return String(key.value);
  }
  return "unknown";
}

export function scalarString(node: Node | null | undefined): string | null {
  if (node && isScalar(node) && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

export function scalarBoolean(node: Node | null | undefined): boolean | null {
  if (node && isScalar(node) && typeof node.value === "boolean") {
    return node.value;
  }
  if (node && isScalar(node) && typeof node.value === "string") {
    if (node.value === "true") return true;
    if (node.value === "false") return false;
  }
  return null;
}

export interface StepInfo {
  uses: { value: string; line: number } | null;
  run: { value: string; line: number } | null;
  persistCredentials: boolean | null;
  persistCredentialsLine: number;
  /** Value of `with.cache`, when the step sets one (setup-node etc.). */
  cache: string | null;
  /**
   * Value of `with.tags` (docker/build-push-action), when the step
   * sets one. May be a multi-line block scalar — one image ref per
   * line. Line = first line of the value.
   */
  tags: { value: string; line: number } | null;
}

export interface JobInfo {
  id: string;
  /** Value of the job's `name:` field, when it sets one. */
  name: string | null;
  /** Line of the job id key. */
  line: number;
  steps: StepInfo[];
  permissionsLine: number | null;
  permissionsValue: string | null;
  timeoutMinutesLine: number | null;
  environmentLine: number | null;
}

export interface WorkflowInfo {
  triggers: string[];
  triggerLine: number;
  pullRequestTargetLine: number | null;
  topPermissions: { value: string | null; line: number } | null;
  /**
   * Top-level `concurrency:` block, when present. It can be a plain
   * string (`concurrency: ci`) or a map with `cancel-in-progress`.
   */
  concurrency: {
    cancelInProgress: boolean | null;
    line: number;
  } | null;
  jobs: JobInfo[];
}

function collectStep(stepNode: Node | null, text: string): StepInfo | null {
  if (!stepNode || !isMap(stepNode)) return null;
  const usesPair = pairByKey(stepNode, "uses");
  const runPair = pairByKey(stepNode, "run");
  const withPair = pairByKey(stepNode, "with");

  let persistCredentials: boolean | null = null;
  let persistCredentialsLine = 1;
  let cache: string | null = null;
  let tags: StepInfo["tags"] = null;
  if (withPair && withPair.value && isMap(withPair.value)) {
    const persistPair = pairByKey(withPair.value, "persist-credentials");
    if (persistPair) {
      persistCredentials = scalarBoolean(persistPair.value);
      persistCredentialsLine = nodeLine(text, persistPair.value);
    }
    const cachePair = pairByKey(withPair.value, "cache");
    if (cachePair) {
      cache = scalarString(cachePair.value);
    }
    const tagsPair = pairByKey(withPair.value, "tags");
    if (tagsPair && scalarString(tagsPair.value) !== null) {
      tags = {
        value: scalarString(tagsPair.value) as string,
        line: nodeLine(text, tagsPair.value),
      };
    }
  }

  return {
    uses:
      usesPair && scalarString(usesPair.value) !== null
        ? {
            value: scalarString(usesPair.value) as string,
            line: nodeLine(text, usesPair.value),
          }
        : null,
    run:
      runPair && scalarString(runPair.value) !== null
        ? {
            value: scalarString(runPair.value) as string,
            line: nodeLine(text, runPair.value),
          }
        : null,
    persistCredentials,
    persistCredentialsLine,
    cache,
    tags,
  };
}

/**
 * Parses a workflow file into the structure the rules need.
 * Returns null when the document has no mapping at the top level.
 * Throws on unparseable YAML (the runner turns that into exit 2).
 */
export function collectWorkflow(text: string): WorkflowInfo | null {
  const doc = parseDocument(text);
  const root = doc.contents;
  if (!root || !isMap(root)) return null;

  // --- `on:` triggers -------------------------------------------------
  const onPair = pairByKey(root, "on");
  const triggers: string[] = [];
  let triggerLine = 1;
  let pullRequestTargetLine: number | null = null;
  if (onPair) {
    triggerLine = nodeLine(text, onPair.value);
    const value = asNode(onPair.value);
    if (isScalar(value) && typeof value.value === "string") {
      triggers.push(value.value);
    } else if (isSeq(value)) {
      for (const item of value.items) {
        if (isScalar(item) && typeof item.value === "string") {
          triggers.push(item.value);
          if (item.value === "pull_request_target") {
            pullRequestTargetLine = nodeLine(text, item);
          }
        }
      }
    } else if (isMap(value)) {
      for (const item of value.items) {
        const key = item.key;
        if (isScalar(key) && typeof key.value === "string") {
          triggers.push(key.value);
          if (key.value === "pull_request_target") {
            pullRequestTargetLine = nodeLine(text, key);
          }
        }
      }
    }
    if (triggers.includes("pull_request_target") && pullRequestTargetLine === null) {
      pullRequestTargetLine = triggerLine;
    }
  }

  // --- top-level `permissions:` ---------------------------------------
  let topPermissions: WorkflowInfo["topPermissions"] = null;
  const permissionsPair = pairByKey(root, "permissions");
  if (permissionsPair) {
    topPermissions = {
      value: scalarString(permissionsPair.value),
      line: nodeLine(text, permissionsPair.value),
    };
  }

  // --- top-level `concurrency:` ---------------------------------------
  let concurrency: WorkflowInfo["concurrency"] = null;
  const concurrencyPair = pairByKey(root, "concurrency");
  if (concurrencyPair) {
    const value = asNode(concurrencyPair.value);
    let cancelInProgress: boolean | null = null;
    if (isMap(value)) {
      const cancelPair = pairByKey(value, "cancel-in-progress");
      if (cancelPair) {
        cancelInProgress = scalarBoolean(cancelPair.value);
      }
    }
    concurrency = {
      cancelInProgress,
      line: nodeLine(text, concurrencyPair.value),
    };
  }

  // --- jobs ------------------------------------------------------------
  const jobs: JobInfo[] = [];
  const jobsPair = pairByKey(root, "jobs");
  if (jobsPair && jobsPair.value && isMap(jobsPair.value)) {
    for (const jobPair of jobsPair.value.items) {
      const jobKey = asNode(jobPair.key);
      const jobId = keyToString(jobKey);
      const jobNode = asNode(jobPair.value);
      if (!jobNode || !isMap(jobNode)) continue;

      const jobPermissionsPair = pairByKey(jobNode, "permissions");
      const namePair = pairByKey(jobNode, "name");
      const timeoutPair = pairByKey(jobNode, "timeout-minutes");
      const environmentPair = pairByKey(jobNode, "environment");
      const steps: StepInfo[] = [];
      const stepsPair = pairByKey(jobNode, "steps");
      if (stepsPair && stepsPair.value && isSeq(stepsPair.value)) {
        for (const stepNode of stepsPair.value.items) {
          const step = collectStep(asNode(stepNode), text);
          if (step) steps.push(step);
        }
      }

      jobs.push({
        id: jobId,
        name: namePair ? scalarString(namePair.value) : null,
        line: nodeLine(text, jobKey),
        steps,
        permissionsLine: jobPermissionsPair
          ? nodeLine(text, jobPermissionsPair.value)
          : null,
        permissionsValue: jobPermissionsPair
          ? scalarString(jobPermissionsPair.value)
          : null,
        timeoutMinutesLine: timeoutPair
          ? nodeLine(text, timeoutPair.value)
          : null,
        environmentLine: environmentPair
          ? nodeLine(text, environmentPair.value)
          : null,
      });
    }
  }

  return {
    triggers,
    triggerLine,
    pullRequestTargetLine,
    topPermissions,
    concurrency,
    jobs,
  };
}
