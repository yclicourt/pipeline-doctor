import {
  collectWorkflow,
  type JobInfo,
  type StepInfo,
} from "../checks/workflow-parse.js";
import type { CiJob, CiPipeline, CiStep } from "./model.js";

/**
 * GitHub adapter (0.2.0, Fase A).
 *
 * Thin mapping over the existing `collectWorkflow` parser — no
 * re-parsing, no behavior change. The GitHub rules keep working
 * exactly as before; this only restates their input in the common
 * model so Fase B can run the same rules on GitLab pipelines too.
 */
function adaptStep(step: StepInfo): CiStep {
  return {
    line: step.uses?.line ?? step.run?.line ?? 1,
    action: step.uses
      ? { ref: step.uses.value, line: step.uses.line }
      : null,
    script: step.run
      ? { text: step.run.value, line: step.run.line }
      : null,
    persistCredentials: step.persistCredentials,
    cache: step.cache,
  };
}

function adaptJob(job: JobInfo): CiJob {
  return {
    id: job.id,
    name: job.name,
    line: job.line,
    steps: job.steps.map(adaptStep),
    timeoutLine: job.timeoutMinutesLine,
    environmentLine: job.environmentLine,
    permissionsValue: job.permissionsValue,
    permissionsLine: job.permissionsLine,
    image: null,
    services: [],
    resourceGroup: null,
    manual: false,
  };
}

/**
 * Parses a GitHub workflow file into the common model.
 * Returns null when the document has no mapping at the top level.
 * Throws on unparseable YAML (the runner turns that into exit 2).
 */
export function adaptGitHub(content: string, file: string): CiPipeline | null {
  const info = collectWorkflow(content);
  if (info === null) return null;
  return {
    source: "github",
    file,
    triggers: info.triggers,
    triggerLine: info.triggerLine,
    pullRequestTargetLine: info.pullRequestTargetLine,
    topPermissions: info.topPermissions,
    concurrency: info.concurrency,
    jobs: info.jobs.map(adaptJob),
    images: [],
    includes: [],
  };
}
