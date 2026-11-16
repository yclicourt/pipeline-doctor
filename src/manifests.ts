import { readFileSync } from "node:fs";
import { basename, relative, sep } from "node:path";
import { parseAllDocuments, isMap, isSeq, isScalar, type Node } from "yaml";
import { collectSecretFiles } from "./checks/secrets.js";
import { nodeLine } from "./checks/workflow-parse.js";

/**
 * Kubernetes manifests as declared in git (0.2.0, Deploy family).
 *
 * The Deploy checks verify the live cluster against what git says
 * should be there, so they need names: Deployments, Services,
 * ArgoCD Applications, PVC capacities. Two complications of real
 * Helm repos are handled here:
 *
 * - Names are often `{{.Values.backend.name}}` — resolved against
 *   the repo's values.yaml (plain `{{ .Values.a.b }}` references).
 *   A value that cannot be resolved makes that resource
 *   unresolvable, and the checks that need it say so instead of
 *   guessing a name.
 * - Templates are not YAML until rendered (duplicate keys inside
 *   {{if}} blocks are legal there), so documents are parsed with
 *   uniqueKeys disabled.
 *
 * Example files (`*.example.yaml`) are excluded — they are not
 * deployed.
 */

export interface ManifestResource {
  kind: string;
  /** Resolved name, or null when it cannot be resolved from values. */
  name: string | null;
  /** Resolved namespace (values global.namespace, else "default"). */
  namespace: string;
  file: string;
  line: number;
}

export interface ManifestDeployment extends ManifestResource {
  /** Resolved pod selector labels (matchLabels). */
  matchLabels: Record<string, string>;
}

export interface ManifestPvc {
  /** Claim name (PVC name, or volumeClaimTemplate name). */
  name: string;
  namespace: string;
  /** Capacity in bytes. */
  capacityBytes: number;
  file: string;
  line: number;
}

export interface ManifestSet {
  deployments: ManifestDeployment[];
  services: ManifestResource[];
  applications: ManifestResource[];
  pvcs: ManifestPvc[];
}

/** Storage sizes: "2Gi" → bytes (k8s binary + decimal suffixes). */
export function parseStorageSize(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const amount = Number(match[1]);
  const suffix = match[2] ?? "";
  const binary: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const decimal: Record<string, number> = {
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  };
  if (suffix === "") return amount;
  if (suffix in binary) return Math.round(amount * binary[suffix]);
  if (suffix in decimal) return Math.round(amount * decimal[suffix]);
  return null;
}

type ValuesMap = Record<string, unknown>;

function isValuesMap(value: unknown): value is ValuesMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target: ValuesMap, source: ValuesMap): ValuesMap {
  for (const [key, value] of Object.entries(source)) {
    if (isValuesMap(value) && isValuesMap(target[key])) {
      target[key] = deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function yamlToPlain(node: Node | null | undefined): unknown {
  if (!node) return undefined;
  if (isScalar(node)) return node.value;
  if (isSeq(node)) {
    return node.items.map((item) => yamlToPlain(item as Node | null));
  }
  if (isMap(node)) {
    const out: ValuesMap = {};
    for (const pair of node.items) {
      if (!isScalar(pair.key)) continue;
      out[String(pair.key.value)] = yamlToPlain(pair.value as Node | null);
    }
    return out;
  }
  return undefined;
}

/**
 * Loads every values.yaml in the repo (excluding examples) and merges
 * them, later files overriding earlier ones.
 */
export function loadValues(targetDir: string): ValuesMap {
  const merged: ValuesMap = {};
  const files = collectSecretFiles(targetDir)
    .filter((file) => {
      const name = basename(file);
      return (
        (name === "values.yaml" || name === "values.yml") &&
        !name.includes(".example.")
      );
    })
    .sort();
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    const docs = parseAllDocuments(content, { uniqueKeys: false });
    for (const doc of docs) {
      if (doc.errors.length > 0) continue;
      const plain = yamlToPlain(doc.contents);
      if (isValuesMap(plain)) deepMerge(merged, plain);
    }
  }
  return merged;
}

const VALUES_REF_RE = /\{\{\s*\.Values\.([A-Za-z0-9_.]+)\s*\}\}/g;

function lookupValue(values: ValuesMap, path: string): unknown {
  let current: unknown = values;
  for (const part of path.split(".")) {
    if (!isValuesMap(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Resolves `{{.Values.a.b}}` references in a string against the
 * values map. Returns null when any reference cannot be resolved
 * (the value is not knowable statically), or when the string holds a
 * template expression that is not a plain .Values reference.
 */
export function resolveTemplate(
  value: string,
  values: ValuesMap,
): string | null {
  if (!value.includes("{{")) return value;
  let unresolved = false;
  const resolved = value.replace(VALUES_REF_RE, (_match, path: string) => {
    const found = lookupValue(values, path);
    if (found === undefined || found === null) {
      unresolved = true;
      return "";
    }
    if (typeof found === "string" || typeof found === "number") {
      return String(found);
    }
    unresolved = true;
    return "";
  });
  if (unresolved) return null;
  // A remaining {{ }} means a non-.Values expression (if, range...).
  if (resolved.includes("{{")) return null;
  return resolved;
}

function toPosixRelative(targetDir: string, absolutePath: string): string {
  return relative(targetDir, absolutePath).split(sep).join("/");
}

/**
 * An unquoted Helm template is not a YAML scalar: `name:
 * {{.Values.backend.name}}` parses as a flow mapping
 * `{ { .Values.backend.name: null }: null }`. Rebuild the template
 * string from that shape so resolveTemplate can decide what it is.
 * Returns null for any other non-scalar value.
 */
export function reconstructTemplate(node: Node | null | undefined): string | null {
  if (!node || !isMap(node) || node.items.length !== 1) return null;
  const pair = node.items[0];
  if (!isMap(pair.key) || pair.key.items.length !== 1) return null;
  const inner = pair.key.items[0];
  if (!isScalar(inner.key) || typeof inner.key.value !== "string") {
    return null;
  }
  const outerNull =
    !pair.value || (isScalar(pair.value) && pair.value.value === null);
  const innerNull =
    !inner.value || (isScalar(inner.value) && inner.value.value === null);
  if (!outerNull || !innerNull) return null;
  return `{{${String(inner.key.value)}}}`;
}

function scalarString(node: Node | null | undefined): string | null {
  if (node && isScalar(node)) return String(node.value);
  return reconstructTemplate(node);
}

function getString(map: Node | null | undefined, key: string): string | null {
  if (!map || !isMap(map)) return null;
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === key) {
      return scalarString(pair.value as Node | null);
    }
  }
  return null;
}

function getMap(map: Node | null | undefined, key: string): Node | null {
  if (!map || !isMap(map)) return null;
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === key) {
      return pair.value as Node | null;
    }
  }
  return null;
}

const DISCOVERED_KINDS = new Set([
  "Deployment",
  "StatefulSet",
  "Service",
  "PersistentVolumeClaim",
  "Application",
]);

export function collectManifests(targetDir: string): ManifestSet {
  const values = loadValues(targetDir);
  const defaultNamespace =
    lookupValue(values, "global.namespace") ?? "default";
  const defaultNs =
    typeof defaultNamespace === "string" ? defaultNamespace : "default";

  const set: ManifestSet = {
    deployments: [],
    services: [],
    applications: [],
    pvcs: [],
  };

  const files = collectSecretFiles(targetDir).filter((file) => {
    const name = basename(file);
    return (
      (name.endsWith(".yml") || name.endsWith(".yaml")) &&
      !name.includes(".example.") &&
      !toPosixRelative(targetDir, file).startsWith(".github/workflows/") &&
      !name.startsWith("docker-compose") &&
      !name.startsWith("compose")
    );
  });

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    const rel = toPosixRelative(targetDir, file);
    const docs = parseAllDocuments(content, { uniqueKeys: false });
    for (const doc of docs) {
      if (doc.errors.length > 0) continue;
      const root = doc.contents;
      if (!root || !isMap(root)) continue;
      const kind = getString(root, "kind");
      if (kind === null || !DISCOVERED_KINDS.has(kind)) continue;
      const metadata = getMap(root, "metadata");
      const rawName = getString(metadata, "name");
      const rawNamespace = getString(metadata, "namespace");
      const name =
        rawName === null ? null : resolveTemplate(rawName, values);
      const namespace =
        rawNamespace === null
          ? defaultNs
          : (resolveTemplate(rawNamespace, values) ?? defaultNs);
      const line = nodeLine(content, root);

      if (kind === "Deployment") {
        const spec = getMap(root, "spec");
        const selector = getMap(spec, "selector");
        const matchLabels = getMap(selector, "matchLabels");
        const labels: Record<string, string> = {};
        if (matchLabels && isMap(matchLabels)) {
          for (const pair of matchLabels.items) {
            if (!isScalar(pair.key)) continue;
            const raw = scalarString(pair.value as Node | null);
            if (raw === null) continue;
            const resolved = resolveTemplate(raw, values);
            if (resolved !== null) labels[String(pair.key.value)] = resolved;
          }
        }
        set.deployments.push({ kind, name, namespace, file: rel, line, matchLabels: labels });
      } else if (kind === "Service") {
        set.services.push({ kind, name, namespace, file: rel, line });
      } else if (kind === "Application") {
        set.applications.push({ kind, name, namespace, file: rel, line });
      } else if (kind === "PersistentVolumeClaim") {
        const spec = getMap(root, "spec");
        const resources = getMap(spec, "resources");
        const requests = getMap(resources, "requests");
        const storage = getString(requests, "storage");
        const bytes = storage === null ? null : parseStorageSize(storage);
        if (name !== null && bytes !== null) {
          set.pvcs.push({ name, namespace, capacityBytes: bytes, file: rel, line });
        }
      } else if (kind === "StatefulSet") {
        const spec = getMap(root, "spec");
        const templates = getMap(spec, "volumeClaimTemplates");
        if (templates && isSeq(templates)) {
          for (const item of templates.items) {
            const template = item as Node | null;
            const tMetadata = getMap(template, "metadata");
            const tName = getString(tMetadata, "name");
            const tSpec = getMap(template, "spec");
            const tResources = getMap(tSpec, "resources");
            const tRequests = getMap(tResources, "requests");
            const storage = getString(tRequests, "storage");
            const resolvedName =
              tName === null ? null : resolveTemplate(tName, values);
            const bytes = storage === null ? null : parseStorageSize(storage);
            if (resolvedName !== null && bytes !== null) {
              set.pvcs.push({
                name: resolvedName,
                namespace,
                capacityBytes: bytes,
                file: rel,
                line,
              });
            }
          }
        }
      }
    }
  }

  return set;
}

export interface DjangoMigration {
  /** Django app label (the directory above migrations/). */
  app: string;
  /** Migration name without .py (0001_initial). */
  name: string;
  file: string;
}

/** Django migration files in git: <app>/migrations/NNNN_name.py. */
export function collectDjangoMigrations(targetDir: string): DjangoMigration[] {
  const out: DjangoMigration[] = [];
  for (const file of collectSecretFiles(targetDir)) {
    const rel = toPosixRelative(targetDir, file);
    const parts = rel.split("/");
    if (parts.length < 3) continue;
    if (parts[parts.length - 2] !== "migrations") continue;
    if (!file.endsWith(".py")) continue;
    const name = basename(file);
    if (name === "__init__.py") continue;
    out.push({
      app: parts[parts.length - 3],
      name: name.slice(0, -3),
      file: rel,
    });
  }
  return out;
}
