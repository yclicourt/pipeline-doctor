import { readFileSync } from "node:fs";
import { join, relative, sep, basename } from "node:path";
import { parseAllDocuments, isMap, isSeq, isScalar, type Node } from "yaml";
import { reconstructTemplate } from "../manifests.js";
import { collectSecretFiles } from "./secrets.js";
import { collectWorkflow, nodeLine } from "./workflow-parse.js";

/**
 * Container image references (0.2.0, shared by CI-01/CI-02/CI-03).
 *
 * Where images live in a repo:
 * - workflows: `tags:` of docker/build-push-action steps (what CI
 *   builds) and `image:` lines (service containers)
 * - manifests: any other *.yml/*.yaml with an `image:` key — Helm
 *   values (`image: {repository, tag}`), k8s manifests, ArgoCD apps
 * - compose files: `image:` lines
 * - Dockerfiles: `FROM` lines (base images)
 *
 * Example files (`*.example.yaml`) are NOT deployed, so they are
 * excluded — auditing them would duplicate every finding.
 */

export type ImageSource =
  | "workflow-tags"
  | "workflow-image"
  | "manifest"
  | "compose"
  | "dockerfile";

export interface ImageRef {
  /** As written, e.g. "harbor.example.com/proj/app:${{ github.sha }}". */
  raw: string;
  /** Repo-relative file. */
  file: string;
  line: number;
  source: ImageSource;
  /** Host part, when present ("quay.io", or a ${{ }} expression). */
  registry?: string;
  /** Repository without registry, tag or digest ("proj/app"). */
  repository: string;
  /** Tag without digest ("latest", "839a92fa...", undefined = untagged). */
  tag?: string;
  /** "sha256:..." when pinned by digest. */
  digest?: string;
  /** True when the raw value contains a ${{ }} expression. */
  isExpression: boolean;
}

const SHA_TAG_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** A full 40- or 64-hex SHA tag — the only tag CI-01 accepts. */
export function isShaTag(tag: string | undefined): boolean {
  return tag !== undefined && SHA_TAG_RE.test(tag);
}

/** The tag CI-01 accepts: a SHA, or an expression that yields one. */
export function isShaOrShaExpression(ref: ImageRef): boolean {
  if (isShaTag(ref.tag)) return true;
  if (ref.tag !== undefined && ref.tag.includes("github.sha")) return true;
  return false;
}

/** `latest`, or no tag at all (Docker reads untagged as latest). */
export function isLatestTag(ref: ImageRef): boolean {
  if (ref.digest !== undefined) return false;
  return ref.tag === undefined || ref.tag === "latest";
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parses "registry/repo:tag@digest" into its parts. Unparseable
 * values (empty, or a lone expression) still yield a ref with the raw
 * value so the caller can decide what to do with it.
 */
export function parseImageRef(
  rawValue: string,
  file: string,
  line: number,
  source: ImageSource,
): ImageRef {
  const raw = stripQuotes(rawValue);
  const isExpression = raw.includes("${{");
  let rest = raw;
  let digest: string | undefined;
  const atIndex = rest.lastIndexOf("@");
  if (atIndex !== -1) {
    digest = rest.slice(atIndex + 1);
    rest = rest.slice(0, atIndex);
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf("/");
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }
  const parts = rest.split("/").filter((p) => p.length > 0);
  let registry: string | undefined;
  let repository: string;
  if (parts.length > 1) {
    const first = parts[0];
    // A host has a dot, a port, is localhost — or is an expression
    // like ${{ vars.HARBOR_REGISTRY }} standing in for the host.
    if (
      first.includes(".") ||
      first.includes(":") ||
      first === "localhost" ||
      first.includes("${{")
    ) {
      registry = first;
      repository = parts.slice(1).join("/");
    } else {
      repository = parts.join("/");
    }
  } else {
    repository = parts.join("/");
  }
  return { raw, file, line, source, registry, repository, tag, digest, isExpression };
}

function toPosixRelative(targetDir: string, absolutePath: string): string {
  return relative(targetDir, absolutePath).split(sep).join("/");
}

function isWorkflowFile(rel: string): boolean {
  return rel.startsWith(".github/workflows/");
}

function isComposeFile(name: string): boolean {
  return (
    name.startsWith("docker-compose") ||
    name.startsWith("compose") ||
    name === "docker-compose.yml" ||
    name === "docker-compose.yaml"
  );
}

function isYamlFile(path: string): boolean {
  return path.endsWith(".yml") || path.endsWith(".yaml");
}

export function isDockerfileName(name: string): boolean {
  return name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".dockerfile");
}

/** `image: <value>` lines in a text file (workflows, compose). */
function scanImageLines(
  content: string,
  file: string,
  source: ImageSource,
): ImageRef[] {
  const refs: ImageRef[] = [];
  const lines = content.split("\n");
  const re = /^\s*image:\s*["']?([^"'\s#]+)/;
  lines.forEach((lineText, index) => {
    const match = re.exec(lineText);
    if (match) {
      refs.push(parseImageRef(match[1], file, index + 1, source));
    }
  });
  return refs;
}

/** `FROM <ref> [AS ...]` lines in a Dockerfile. */
function scanDockerfile(
  content: string,
  file: string,
): ImageRef[] {
  const refs: ImageRef[] = [];
  const lines = content.split("\n");
  const re = /^\s*FROM\s+(\S+)/i;
  lines.forEach((lineText, index) => {
    const match = re.exec(lineText);
    if (match && match[1].toLowerCase() !== "scratch") {
      refs.push(parseImageRef(match[1], file, index + 1, "dockerfile"));
    }
  });
  return refs;
}

/**
 * Walks a YAML document looking for `image:` mappings:
 * - `image: "registry/repo:tag"` (string form)
 * - `image: {repository: "...", tag: "..."}` (Helm form)
 * Returns refs with AST line numbers. Throws on unparseable YAML —
 * a manifest that cannot be parsed cannot be audited.
 *
 * Multi-document files (k8s manifests separated by `---`) are all
 * read. Policy patterns are NOT images: a value like `"!*:latest"`
 * (Kyverno "any image except latest") or `"*:latest"` is a match
 * pattern, not a deployed image, so it is skipped.
 */
function scanManifestYaml(
  content: string,
  file: string,
): ImageRef[] {
  const refs: ImageRef[] = [];
  // Helm templates are not YAML until rendered (duplicate keys inside
  // {{if}} blocks are legal there), so duplicate keys are allowed
  // here — the walk below still reads every `image:` pair.
  const docs = parseAllDocuments(content, { uniqueKeys: false });
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new Error(
        `failed to parse ${file}: ${doc.errors[0].message}`,
      );
    }
    const root = doc.contents;
    if (!root) continue;
    visit(root);
  }

  function isPattern(value: string): boolean {
    const v = value.trim();
    return v.includes("*") || v.startsWith("!");
  }

  /**
   * A Go template expression ({{ .Values... }}) is not a concrete
   * image — the values file next to the template is where the real
   * ref lives, so templates contribute nothing here.
   */
  function isTemplate(value: string): boolean {
    return value.includes("{{");
  }

  function scalarValue(node: Node | null | undefined): string | null {
    if (node && isScalar(node) && typeof node.value === "string") {
      return node.value;
    }
    // Unquoted `image: {{.Values.x}}` parses as a flow mapping —
    // rebuild the template so the isTemplate check below can skip it
    // explicitly instead of silently dropping the ref.
    return reconstructTemplate(node);
  }

  function visit(node: Node | null | undefined): void {
    if (!node) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key;
        if (isScalar(key) && key.value === "image") {
          const value = pair.value as Node | null;
          const line = nodeLine(content, value);
          const asString = scalarValue(value);
          if (asString !== null) {
            if (!isPattern(asString) && !isTemplate(asString)) {
              refs.push(parseImageRef(asString, file, line, "manifest"));
            }
          } else if (value && isMap(value)) {
            let repository: string | null = null;
            let tag: string | null = null;
            for (const inner of value.items) {
              if (!isScalar(inner.key)) continue;
              if (inner.key.value === "repository") {
                repository = scalarValue(inner.value as Node | null);
              }
              if (inner.key.value === "tag") {
                const tagNode = inner.value as Node | null;
                const tagValue = scalarValue(tagNode);
                if (tagValue !== null) tag = tagValue;
              }
            }
            // A templated tag ({{ .Values.x.image.tag }}) resolves to
            // something unknown — flagging it as "untagged = latest"
            // would be guessing, so the whole ref is skipped.
            if (
              repository !== null &&
              !isPattern(repository) &&
              !isTemplate(repository) &&
              (tag === null || !isTemplate(tag))
            ) {
              const combined =
                tag !== null ? `${repository}:${tag}` : repository;
              refs.push(parseImageRef(combined, file, line, "manifest"));
            }
          }
        }
        visit(pair.value as Node | null);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item as Node | null);
    }
  }

  return refs;
}

/**
 * Collects every image reference in the repo. Files are walked with
 * the secrets family's tree walk (respects .gitignore, skips
 * node_modules/dist/.git/...).
 */
export function collectImageReferences(targetDir: string): ImageRef[] {
  const refs: ImageRef[] = [];
  const files = collectSecretFiles(targetDir);

  for (const file of files) {
    const rel = toPosixRelative(targetDir, file);
    const name = basename(file);
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;

    if (isWorkflowFile(rel) && isYamlFile(file)) {
      // build-push-action tags come from the AST (exact values and
      // lines); service-container `image:` lines come from a scan.
      try {
        const workflow = collectWorkflow(content);
        if (workflow) {
          for (const job of workflow.jobs) {
            for (const step of job.steps) {
              if (
                step.uses &&
                step.uses.value.includes("build-push-action") &&
                step.tags
              ) {
                const lines = step.tags.value
                  .split("\n")
                  .map((t) => t.trim())
                  .filter((t) => t.length > 0);
                lines.forEach((tagValue, index) => {
                  // Skip metadata-action style values ("type=sha").
                  if (/^[a-z]+=/.test(tagValue) && !tagValue.includes("/")) {
                    return;
                  }
                  refs.push(
                    parseImageRef(
                      tagValue,
                      rel,
                      step.tags ? step.tags.line + index : 1,
                      "workflow-tags",
                    ),
                  );
                });
              }
            }
          }
        }
      } catch (error) {
        throw new Error(
          `failed to parse ${rel}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      refs.push(...scanImageLines(content, rel, "workflow-image"));
      continue;
    }

    if (isComposeFile(name) && isYamlFile(file)) {
      refs.push(...scanImageLines(content, rel, "compose"));
      continue;
    }

    if (isDockerfileName(name)) {
      refs.push(...scanDockerfile(content, rel));
      continue;
    }

    if (isYamlFile(file)) {
      // Example files are not deployed — auditing them would
      // duplicate every finding from the real manifest.
      if (name.includes(".example.")) continue;
      try {
        refs.push(...scanManifestYaml(content, rel));
      } catch (error) {
        throw new Error(
          `failed to parse ${rel}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return refs;
}

/** The distinct repositories CI builds (from workflow `tags:`). */
export function ciBuiltRepositories(refs: ImageRef[]): Set<string> {
  const repos = new Set<string>();
  for (const ref of refs) {
    if (ref.source === "workflow-tags" && ref.repository.length > 0) {
      repos.add(ref.repository);
    }
  }
  return repos;
}
