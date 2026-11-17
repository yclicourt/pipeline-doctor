/**
 * Common CI model (0.2.0, Fase A — GitLab support).
 *
 * One normalized shape for every CI system the tool audits, so the
 * rules run on the model instead of on GitHub-only YAML:
 *
 *   GitHub Actions  --adapter-->  CiPipeline  <--adapter--  GitLab CI
 *
 * Each field says which CI fills it. A field the CI cannot express
 * stays null / empty — the rules (Fase B) treat "not applicable"
 * differently from "missing and bad". In particular:
 * - `persistCredentials` is GitHub-only (checkout keeps the token).
 *   GitLab has no equivalent, so it is always null there.
 * - `pullRequestTargetLine` / `topPermissions` / `concurrency` are
 *   GitHub-only. GitLab's `resource_group` is the concurrency
 *   equivalent and lives on the job, not the pipeline.
 * - `images` / `includes` are GitLab-only. GitHub images reach the
 *   tool through the `images` family (build-push tags), not here.
 * - GitLab `triggers` stay empty for now: GitLab has no `on:`
 *   equivalent in the YAML (pipeline sources live in `workflow:`
 *   rules and project settings). The untrusted-input rule (Fase B)
 *   uses the job-level `manual` flag instead.
 *
 * Fase A only defines the model and the two adapters. No rule reads
 * it yet — Fase B rewires the workflow + hygiene rules onto it.
 */

export type CiSource = "github" | "gitlab";

/** One image reference (GitLab `image:` / `services:`). */
export interface CiImageRef {
  ref: string;
  line: number;
  kind: "image" | "service";
}

/** A remote include (GitLab `include:`). GitHub has none — `uses:` covers it. */
export interface CiInclude {
  kind: "remote" | "project" | "local" | "template";
  /** The fixed ref (branch/tag/SHA) when the include pins one, else null. */
  ref: string | null;
  line: number;
  raw: string;
}

export interface CiStep {
  line: number;
  /** GitHub `uses:` action ref, e.g. actions/checkout@v4. Null on GitLab. */
  action: { ref: string; line: number } | null;
  /** GitHub `run:` / GitLab `script:` text (lines joined with \n). */
  script: { text: string; line: number } | null;
  /** GitHub only: checkout keeps the token. Null on GitLab (no equivalent). */
  persistCredentials: boolean | null;
  /** GitHub `with.cache` (setup-node etc.). GitLab cache lives on the job. */
  cache: string | null;
}

export interface CiJob {
  id: string;
  name: string | null;
  line: number;
  steps: CiStep[];
  /** Line of the timeout (`timeout-minutes` / `timeout:`), null when absent. */
  timeoutLine: number | null;
  /** Line of the environment (`environment:`), null when absent. */
  environmentLine: number | null;
  /** GitHub only: job-level permissions value + line. Null on GitLab. */
  permissionsValue: string | null;
  permissionsLine: number | null;
  /** GitLab only: job-level `image:` override. Null on GitHub. */
  image: { ref: string; line: number } | null;
  /** GitLab only: job-level services. Empty on GitHub. */
  services: CiImageRef[];
  /** GitLab only: job-level `resource_group:`. Null on GitHub. */
  resourceGroup: { value: string; line: number } | null;
  /** True when the job only runs manually (`when: manual`). */
  manual: boolean;
}

export interface CiPipeline {
  source: CiSource;
  file: string;
  triggers: string[];
  /** Line of the triggers block (GitHub `on:`). 1 on GitLab (no triggers modelled). */
  triggerLine: number;
  /** GitHub only: line of pull_request_target. Null on GitLab. */
  pullRequestTargetLine: number | null;
  /** GitHub only: top-level permissions. Null on GitLab. */
  topPermissions: { value: string | null; line: number } | null;
  /** GitHub only: top-level concurrency block. Null on GitLab. */
  concurrency: { cancelInProgress: boolean | null; line: number } | null;
  jobs: CiJob[];
  /** GitLab only: global image + services (job-level ones live on the job). */
  images: CiImageRef[];
  /** GitLab only: `include:` entries. Empty on GitHub. */
  includes: CiInclude[];
}
