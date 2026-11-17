import type { Finding } from "../types.js";
import { adaptGitHub } from "../ci/github.js";
import type { CiJob, CiPipeline } from "../ci/model.js";

/**
 * Pipeline-hygiene rules (spec §3D), running on the common CI model
 * (0.2.0, Fase B). Each rule is a pure function of the pipeline, so
 * it can be unit-tested with minimal inline YAML per CI.
 *
 * GitHub behavior is unchanged from v1 — the old text-based entry
 * point survives below as a thin wrapper over the GitHub adapter,
 * and the existing tests exercise it. The GitLab mappings:
 * - no-timeout: a job without `timeout:` — same rule, same severity.
 *   The fix text names the GitLab keyword.
 * - unprotected-deploy: a deploy job without `environment:` — same
 *   rule. A present `environment:` only proves the key exists, not
 *   that the environment is protected (that is a project setting in
 *   GitLab, same as approvals are a repo setting on GitHub).
 * - no-concurrency: GitHub-only. GitLab has no pipeline-level
 *   concurrency group to check — cancellation is per-job
 *   `interruptible:`, a different model, and flagging every job
 *   without it would flood real pipelines.
 * - no-cache: GitHub-only (actions/setup-node). GitLab cache is
 *   job-level and unrelated to setup-node.
 *
 * All four rules are warnings: hygiene makes a pipeline fragile, it
 * does not by itself hand an attacker the repo.
 *
 * Choices kept from v1 (simplest reading):
 * - hygiene/no-concurrency only applies to workflows triggered by PR
 *   events (`pull_request` / `pull_request_target`), as the spec says.
 * - hygiene/unprotected-deploy: a "deploy job" is a job whose id or
 *   `name:` contains "deploy", any step of which uses a known deploy
 *   action, or any step of which runs a deploy command. The action
 *   list is curated and small on purpose: a deploy step the list
 *   misses is a false negative, not a false positive.
 */

const DEPLOY_ACTION_RE =
  /^(actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action|appleboy\/(ssh|scp)-action|docker\/build-push-action|aws-actions\/amazon-ecs-deploy-task-definition|azure\/webapps-deploy|google-github-actions\/deploy-cloudrun)/i;

const DEPLOY_RUN_RE =
  /\b(vercel|netlify|fly|firebase|wrangler|serverless)\s+deploy\b|\bkubectl\s+apply\b|\bhelm\s+(upgrade|install)\b|\bnpm\s+run\s+deploy\b|\bgh-pages\b/i;

function isDeployJob(job: CiJob): boolean {
  if (/deploy/i.test(job.id)) return true;
  if (job.name !== null && /deploy/i.test(job.name)) return true;
  return job.steps.some(
    (step) =>
      (step.action !== null && DEPLOY_ACTION_RE.test(step.action.ref)) ||
      (step.script !== null && DEPLOY_RUN_RE.test(step.script.text)),
  );
}

function checkNoTimeout(
  findings: Finding[],
  pipeline: CiPipeline,
): void {
  for (const job of pipeline.jobs) {
    if (job.timeoutLine !== null) continue;
    const isGitLab = pipeline.source === "gitlab";
    findings.push({
      rule: "hygiene/no-timeout",
      severity: "warning",
      file: pipeline.file,
      line: job.line,
      detail: isGitLab
        ? `job "${job.id}" has no timeout: — a hung job runs until the project timeout`
        : `job "${job.id}" has no timeout-minutes — a hung job runs for up to 6 hours`,
      fix: isGitLab
        ? `add timeout: 10 minutes to job "${job.id}"`
        : `add timeout-minutes: 10 to job "${job.id}"`,
    });
  }
}

function checkNoConcurrency(
  findings: Finding[],
  pipeline: CiPipeline,
): void {
  // GitHub-only: GitLab cancellation is per-job `interruptible:`,
  // not a pipeline-level concurrency group.
  if (pipeline.source !== "github") return;
  const isPrWorkflow = pipeline.triggers.some(
    (t) => t === "pull_request" || t === "pull_request_target",
  );
  if (!isPrWorkflow) return;
  if (
    pipeline.concurrency !== null &&
    pipeline.concurrency.cancelInProgress === true
  ) {
    return;
  }
  findings.push({
    rule: "hygiene/no-concurrency",
    severity: "warning",
    file: pipeline.file,
    line:
      pipeline.concurrency !== null
        ? pipeline.concurrency.line
        : pipeline.triggerLine,
    detail:
      "no concurrency with cancel-in-progress on a PR workflow — stale runs keep burning minutes",
    fix: "add a top-level concurrency block with cancel-in-progress: true, e.g. concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }",
  });
}

function checkUnprotectedDeploy(
  findings: Finding[],
  pipeline: CiPipeline,
): void {
  for (const job of pipeline.jobs) {
    if (!isDeployJob(job)) continue;
    if (job.environmentLine !== null) continue;
    findings.push({
      rule: "hygiene/unprotected-deploy",
      severity: "warning",
      file: pipeline.file,
      line: job.line,
      detail: `deploy job "${job.id}" has no environment: — no approvals, no environment secrets`,
      fix: `add environment: production to job "${job.id}" (enables approvals and environment secrets)`,
    });
  }
}

function checkNoCache(
  findings: Finding[],
  pipeline: CiPipeline,
): void {
  // GitHub-only: actions/setup-node. GitLab cache is job-level.
  if (pipeline.source !== "github") return;
  for (const job of pipeline.jobs) {
    for (const step of job.steps) {
      if (step.action === null) continue;
      if (!step.action.ref.startsWith("actions/setup-node@")) continue;
      if (step.cache !== null && step.cache.length > 0) continue;
      findings.push({
        rule: "hygiene/no-cache",
        severity: "warning",
        file: pipeline.file,
        line: step.action.line,
        detail: "actions/setup-node without cache — every run re-downloads the dependencies",
        fix: "add with: { cache: npm } to the setup-node step (or yarn / pnpm)",
      });
    }
  }
}

/**
 * Runs all four hygiene rules against one pipeline, in either CI.
 * Throws on unparseable YAML (the runner turns that into exit 2) —
 * the adapters throw before this is reached.
 */
export function checkHygieneModel(pipeline: CiPipeline): Finding[] {
  const findings: Finding[] = [];

  checkNoTimeout(findings, pipeline);
  checkNoConcurrency(findings, pipeline);
  checkUnprotectedDeploy(findings, pipeline);
  checkNoCache(findings, pipeline);

  return findings;
}

/**
 * Text-based entry point (GitHub only, kept for the v1 tests and
 * callers): parse the workflow, then run the model rules on it.
 * Returns [] when the document has no mapping at the top level.
 * Throws on unparseable YAML (the runner turns that into exit 2).
 */
export function checkHygiene(content: string, filename: string): Finding[] {
  const pipeline = adaptGitHub(content, filename);
  if (pipeline === null) return [];
  return checkHygieneModel(pipeline);
}
