import type { Finding } from "../types.js";
import {
  collectWorkflow,
  type JobInfo,
  type WorkflowInfo,
} from "./workflow-parse.js";

/**
 * Pipeline-hygiene rules (spec §3D). Each rule is a pure function of
 * the workflow text, so it can be unit-tested with minimal inline YAML.
 *
 * The YAML parsing lives in ./workflow-parse.ts, shared with the
 * workflow-security family — this file holds only the four rules.
 * All four rules are warnings: hygiene makes a pipeline fragile, it
 * does not by itself hand an attacker the repo.
 *
 * Choices made where the spec leaves room (simplest reading):
 * - hygiene/no-concurrency only applies to workflows triggered by PR
 *   events (`pull_request` / `pull_request_target`), as the spec says.
 *   A workflow with `concurrency:` but without `cancel-in-progress:
 *   true` still fires — the group alone does not cancel the stale run.
 * - hygiene/unprotected-deploy: a "deploy job" is a job whose id or
 *   `name:` contains "deploy", any step of which uses a known deploy
 *   action, or any step of which runs a deploy command. The action
 *   list is curated and small on purpose: a deploy step the list
 *   misses is a false negative, not a false positive.
 * - hygiene/no-cache: any `with.cache` value counts (`npm`, `yarn`,
 *   `pnpm` — the spec's "o equivalente"). Only `actions/setup-node`
 *   is checked in v1, exactly as the spec's table says.
 */

const DEPLOY_ACTION_RE =
  /^(actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action|appleboy\/(ssh|scp)-action|docker\/build-push-action|aws-actions\/amazon-ecs-deploy-task-definition|azure\/webapps-deploy|google-github-actions\/deploy-cloudrun)/i;

const DEPLOY_RUN_RE =
  /\b(vercel|netlify|fly|firebase|wrangler|serverless)\s+deploy\b|\bkubectl\s+apply\b|\bhelm\s+(upgrade|install)\b|\bnpm\s+run\s+deploy\b|\bgh-pages\b/i;

function isDeployJob(job: JobInfo): boolean {
  if (/deploy/i.test(job.id)) return true;
  if (job.name !== null && /deploy/i.test(job.name)) return true;
  return job.steps.some(
    (step) =>
      (step.uses !== null && DEPLOY_ACTION_RE.test(step.uses.value)) ||
      (step.run !== null && DEPLOY_RUN_RE.test(step.run.value)),
  );
}

function checkNoTimeout(
  findings: Finding[],
  filename: string,
  jobs: JobInfo[],
): void {
  for (const job of jobs) {
    if (job.timeoutMinutesLine !== null) continue;
    findings.push({
      rule: "hygiene/no-timeout",
      severity: "warning",
      file: filename,
      line: job.line,
      detail: `job "${job.id}" has no timeout-minutes — a hung job runs for up to 6 hours`,
      fix: `add timeout-minutes: 10 to job "${job.id}"`,
    });
  }
}

function checkNoConcurrency(
  findings: Finding[],
  filename: string,
  info: WorkflowInfo,
): void {
  const isPrWorkflow = info.triggers.some(
    (t) => t === "pull_request" || t === "pull_request_target",
  );
  if (!isPrWorkflow) return;
  if (
    info.concurrency !== null &&
    info.concurrency.cancelInProgress === true
  ) {
    return;
  }
  findings.push({
    rule: "hygiene/no-concurrency",
    severity: "warning",
    file: filename,
    line:
      info.concurrency !== null ? info.concurrency.line : info.triggerLine,
    detail:
      "no concurrency with cancel-in-progress on a PR workflow — stale runs keep burning minutes",
    fix: "add a top-level concurrency block with cancel-in-progress: true, e.g. concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }",
  });
}

function checkUnprotectedDeploy(
  findings: Finding[],
  filename: string,
  jobs: JobInfo[],
): void {
  for (const job of jobs) {
    if (!isDeployJob(job)) continue;
    if (job.environmentLine !== null) continue;
    findings.push({
      rule: "hygiene/unprotected-deploy",
      severity: "warning",
      file: filename,
      line: job.line,
      detail: `deploy job "${job.id}" has no environment: — no approvals, no environment secrets`,
      fix: `add environment: production to job "${job.id}" (enables approvals and environment secrets)`,
    });
  }
}

function checkNoCache(
  findings: Finding[],
  filename: string,
  jobs: JobInfo[],
): void {
  for (const job of jobs) {
    for (const step of job.steps) {
      if (step.uses === null) continue;
      if (!step.uses.value.startsWith("actions/setup-node@")) continue;
      if (step.cache !== null && step.cache.length > 0) continue;
      findings.push({
        rule: "hygiene/no-cache",
        severity: "warning",
        file: filename,
        line: step.uses.line,
        detail: "actions/setup-node without cache — every run re-downloads the dependencies",
        fix: "add with: { cache: npm } to the setup-node step (or yarn / pnpm)",
      });
    }
  }
}

/**
 * Runs all four hygiene rules against one workflow file.
 * Throws on unparseable YAML (the runner turns that into exit 2).
 */
export function checkHygiene(content: string, filename: string): Finding[] {
  const info = collectWorkflow(content);
  if (info === null) return [];
  const findings: Finding[] = [];

  checkNoTimeout(findings, filename, info.jobs);
  checkNoConcurrency(findings, filename, info);
  checkUnprotectedDeploy(findings, filename, info.jobs);
  checkNoCache(findings, filename, info.jobs);

  return findings;
}
