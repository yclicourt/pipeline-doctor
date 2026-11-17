import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  type Node,
  type YAMLMap,
} from "yaml";
import {
  asNode,
  keyToString,
  nodeLine,
  pairByKey,
  scalarString,
  type YamlPair,
} from "../checks/workflow-parse.js";
import type {
  CiImageRef,
  CiInclude,
  CiJob,
  CiPipeline,
  CiStep,
} from "./model.js";

/**
 * GitLab adapter (0.2.0, Fase A).
 *
 * Parses `.gitlab-ci.yml` into the common model, reusing the same
 * YAML AST helpers as the GitHub parser (line numbers come from node
 * ranges, not text search).
 *
 * Known gaps, kept deliberately small for Fase A (see the model docs):
 * - `before_script:` / `after_script:` are not modelled — only
 *   `script:` becomes a step. A job without `script:` has no steps.
 * - `default:` (e.g. a default `image:`) is ignored.
 * - `workflow:` rules are not modelled — `triggers` stays empty.
 * - `rules:` with `when: manual` is not modelled — only the plain
 *   `when: manual` job keyword sets `manual`.
 * - A job `environment:` given as a map still only yields its line
 *   (presence is what the rules need); its `url:` is not read.
 */

/** Top-level keys that are not jobs. Keys starting with "." are hidden templates, also not jobs. */
const RESERVED_TOP_LEVEL = new Set([
  "image",
  "services",
  "cache",
  "stages",
  "include",
  "variables",
  "default",
  "workflow",
  "before_script",
  "after_script",
]);

/** `image: node:latest` (scalar) or `image: { name: ..., entrypoint: ... }` (map). */
function imageRef(
  node: Node | null,
  text: string,
  kind: CiImageRef["kind"],
): CiImageRef | null {
  if (!node) return null;
  if (isScalar(node) && typeof node.value === "string") {
    return { ref: node.value, line: nodeLine(text, node), kind };
  }
  if (isMap(node)) {
    const namePair = pairByKey(node, "name");
    const name = namePair ? scalarString(namePair.value) : null;
    if (namePair && name !== null) {
      return { ref: name, line: nodeLine(text, namePair.value), kind };
    }
  }
  return null;
}

function collectServices(node: Node | null, text: string): CiImageRef[] {
  const out: CiImageRef[] = [];
  if (!node || !isSeq(node)) return out;
  for (const item of node.items) {
    const ref = imageRef(asNode(item), text, "service");
    if (ref) out.push(ref);
  }
  return out;
}

/** `script:` as a string or a list of strings (joined with \n). */
function scriptText(node: Node | null, text: string): CiStep["script"] {
  if (!node) return null;
  if (isScalar(node) && typeof node.value === "string") {
    return { text: node.value, line: nodeLine(text, node) };
  }
  if (isSeq(node)) {
    const parts: string[] = [];
    for (const item of node.items) {
      if (isScalar(item) && typeof item.value === "string") {
        parts.push(item.value);
      }
    }
    if (parts.length === 0) return null;
    return { text: parts.join("\n"), line: nodeLine(text, node) };
  }
  return null;
}

function collectIncludeEntry(
  node: Node | null,
  text: string,
): CiInclude | null {
  if (!node) return null;
  // Bare string include is a local file.
  if (isScalar(node) && typeof node.value === "string") {
    return {
      kind: "local",
      ref: null,
      line: nodeLine(text, node),
      raw: node.value,
    };
  }
  if (!isMap(node)) return null;
  for (const kind of ["remote", "project", "local", "template"] as const) {
    const pair = pairByKey(node, kind);
    if (!pair) continue;
    const raw = scalarString(pair.value);
    if (raw === null) continue;
    let ref: string | null = null;
    if (kind === "project") {
      const refPair = pairByKey(node, "ref");
      ref = refPair ? scalarString(refPair.value) : null;
    }
    return { kind, ref, line: nodeLine(text, pair.value), raw };
  }
  return null;
}

/** `include:` as a single entry or a list of entries. */
function collectIncludes(node: Node | null, text: string): CiInclude[] {
  const out: CiInclude[] = [];
  if (!node) return out;
  if (isMap(node) || isScalar(node)) {
    const one = collectIncludeEntry(node, text);
    if (one) out.push(one);
    return out;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      const one = collectIncludeEntry(asNode(item), text);
      if (one) out.push(one);
    }
  }
  return out;
}

function collectJob(pair: YamlPair, text: string): CiJob | null {
  const jobId = keyToString(asNode(pair.key));
  const jobNode = asNode(pair.value);
  if (!jobNode || !isMap(jobNode)) return null;

  const scriptPair = pairByKey(jobNode, "script");
  const script = scriptPair
    ? scriptText(asNode(scriptPair.value), text)
    : null;
  const steps: CiStep[] = [];
  if (script !== null) {
    steps.push({
      line: script.line,
      action: null,
      script,
      persistCredentials: null,
      cache: null,
    });
  }

  const timeoutPair = pairByKey(jobNode, "timeout");
  const environmentPair = pairByKey(jobNode, "environment");
  const whenPair = pairByKey(jobNode, "when");
  const imagePair = pairByKey(jobNode, "image");
  const servicesPair = pairByKey(jobNode, "services");
  const resourceGroupPair = pairByKey(jobNode, "resource_group");
  const namePair = pairByKey(jobNode, "name");
  // A job image is always an image, never a service — strip the kind.
  const jobImage = imagePair
    ? imageRef(asNode(imagePair.value), text, "image")
    : null;

  return {
    id: jobId,
    name: namePair ? scalarString(namePair.value) : null,
    line: nodeLine(text, asNode(pair.key)),
    steps,
    timeoutLine: timeoutPair
      ? nodeLine(text, timeoutPair.value)
      : null,
    environmentLine: environmentPair
      ? nodeLine(text, environmentPair.value)
      : null,
    permissionsValue: null,
    permissionsLine: null,
    image: jobImage ? { ref: jobImage.ref, line: jobImage.line } : null,
    services: servicesPair
      ? collectServices(asNode(servicesPair.value), text)
      : [],
    resourceGroup: resourceGroupPair
      ? (() => {
          const value = scalarString(resourceGroupPair.value);
          return value !== null
            ? { value, line: nodeLine(text, resourceGroupPair.value) }
            : null;
        })()
      : null,
    manual:
      whenPair !== undefined &&
      scalarString(whenPair.value) === "manual",
  };
}

/**
 * Parses a `.gitlab-ci.yml` file into the common model.
 * Returns null when the document has no mapping at the top level.
 * Throws on unparseable YAML (the runner turns that into exit 2).
 */
export function adaptGitLab(content: string, file: string): CiPipeline | null {
  const doc = parseDocument(content);
  const root = doc.contents;
  if (!root || !isMap(root)) return null;

  const images: CiImageRef[] = [];
  const imagePair = pairByKey(root, "image");
  if (imagePair) {
    const ref = imageRef(asNode(imagePair.value), content, "image");
    if (ref) images.push(ref);
  }
  const servicesPair = pairByKey(root, "services");
  if (servicesPair) {
    images.push(...collectServices(asNode(servicesPair.value), content));
  }
  const includePair = pairByKey(root, "include");
  const includes = includePair
    ? collectIncludes(asNode(includePair.value), content)
    : [];

  const jobs: CiJob[] = [];
  for (const pair of (root as YAMLMap).items) {
    const key = keyToString(asNode(pair.key));
    if (RESERVED_TOP_LEVEL.has(key) || key.startsWith(".")) continue;
    const job = collectJob(pair as YamlPair, content);
    if (job) jobs.push(job);
  }

  return {
    source: "gitlab",
    file,
    triggers: [],
    triggerLine: 1,
    pullRequestTargetLine: null,
    topPermissions: null,
    concurrency: null,
    jobs,
    images,
    includes,
  };
}
