import type { Finding } from "../types.js";
import {
  collectWorkflow,
  type JobInfo,
  type StepInfo,
  type WorkflowInfo,
} from "./workflow-parse.js";

/**
 * Workflow-security rules (spec §3A). Each rule is a pure function of the
 * workflow text, so it can be unit-tested with minimal inline YAML.
 *
 * The YAML parsing lives in ./workflow-parse.ts, shared with the hygiene
 * family — this file holds only the six rules.
 *
 * Choices made where the spec leaves room (simplest reading):
 * - workflow/excessive-permissions flags `permissions: write-all` only.
 *   A permissions map with individual `write` scopes (e.g. contents: write
 *   for a release job) is legitimate and common, so flagging every write
 *   scope would flood real workflows with false positives.
 * - workflow/persist-credentials flags a checkout step that keeps
 *   credentials (explicit `persist-credentials: true`, or the default,
 *   which IS true) in a job where no step pushes or publishes anything
 *   (no `git push`/`git commit`, `gh release`, `npm publish`,
 *   `docker push`, or known publish actions). A step that explicitly
 *   sets `persist-credentials: false` never fires.
 * - Line numbers come from the YAML AST node ranges, not from a
 *   text search, so they stay right even with odd formatting.
 */

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const TEMPLATE_INJECTION_RE = /\$\{\{\s*github\.event\.[^}]*\}\}/;

const WORKFLOW_DISPATCH_INPUT_RE =
  /\$\{\{\s*(inputs\.|github\.event\.inputs\.)[^}]*\}\}/;

const ISSUE_COMMENT_INPUT_RE =
  /\$\{\{\s*github\.event\.(comment|issue)\.[^}]*\}\}/;

/** Steps that plausibly need the persisted GitHub token. */
const NEEDS_CREDENTIALS_RUN_RE =
  /\bgit\s+(push|commit)\b|\bgh\s+(release|pr\s+create)\b|\bnpm\s+publish\b|\bdocker\s+push\b|\btwine\s+upload\b/i;

const PUBLISH_ACTION_RE =
  /(softprops\/action-gh-release|ncipollo\/release-action|pypa\/gh-action-pypi-publish|docker\/build-push-action)/;

function checkUnpinnedAction(
  findings: Finding[],
  filename: string,
  steps: StepInfo[],
): void {
  for (const step of steps) {
    if (!step.uses) continue;
    const uses = step.uses.value;
    // Local actions and Docker actions have no SHA to pin.
    if (uses.startsWith("./") || uses.startsWith("docker://")) continue;
    const at = uses.lastIndexOf("@");
    const ref = at === -1 ? null : uses.slice(at + 1);
    if (ref !== null && SHA_RE.test(ref)) continue;
    const action = at === -1 ? uses : uses.slice(0, at);
    findings.push({
      rule: "workflow/unpinned-action",
      severity: "error",
      file: filename,
      line: step.uses.line,
      detail:
        at === -1
          ? `${uses} has no version pinned at all`
          : `${uses} pins a tag or branch (@${ref}), not a commit SHA`,
      fix:
        at === -1
          ? `pin ${uses} to a full commit SHA, e.g. ${uses}@<40-char SHA>`
          : `pin ${action} by SHA: replace @${ref} with the full commit SHA of that ref`,
    });
  }
}

function checkPullRequestTarget(
  findings: Finding[],
  filename: string,
  info: WorkflowInfo,
): void {
  if (info.pullRequestTargetLine === null) return;
  const hasCheckout = info.jobs.some((job) =>
    job.steps.some(
      (step) =>
        step.uses !== null && step.uses.value.startsWith("actions/checkout@"),
    ),
  );
  if (!hasCheckout) return;
  findings.push({
    rule: "workflow/pull-request-target",
    severity: "error",
    file: filename,
    line: info.pullRequestTargetLine,
    detail:
      "pull_request_target with checkout of the PR — runs untrusted code with secrets",
    fix: "use pull_request instead, or check out the base commit (not the PR head) and never run PR code with secrets",
  });
}

function checkTemplateInjection(
  findings: Finding[],
  filename: string,
  steps: StepInfo[],
): void {
  for (const step of steps) {
    if (!step.run) continue;
    const match = TEMPLATE_INJECTION_RE.exec(step.run.value);
    if (!match) continue;
    findings.push({
      rule: "workflow/template-injection",
      severity: "error",
      file: filename,
      line: step.run.line,
      detail: `${match[0]} interpolated directly into run: — an attacker can inject shell commands through the event payload`,
      fix: "pass the value through an env var instead, e.g. env: TITLE: ${{ github.event.issue.title }} and use $TITLE in run:",
    });
  }
}

function checkExcessivePermissions(
  findings: Finding[],
  filename: string,
  info: WorkflowInfo,
): void {
  const check = (value: string | null, line: number | null): void => {
    if (value === "write-all" && line !== null) {
      findings.push({
        rule: "workflow/excessive-permissions",
        severity: "warning",
        file: filename,
        line,
        detail: "permissions: write-all grants every scope to the workflow token",
        fix: "grant only the scopes the workflow needs, e.g. permissions: { contents: read }",
      });
    }
  };
  if (info.topPermissions) {
    check(info.topPermissions.value, info.topPermissions.line);
  }
  for (const job of info.jobs) {
    check(job.permissionsValue, job.permissionsLine);
  }
}

function checkPersistCredentials(
  findings: Finding[],
  filename: string,
  jobs: JobInfo[],
): void {
  for (const job of jobs) {
    const jobNeedsCredentials = job.steps.some(
      (step) =>
        (step.run !== null && NEEDS_CREDENTIALS_RUN_RE.test(step.run.value)) ||
        (step.uses !== null && PUBLISH_ACTION_RE.test(step.uses.value)),
    );
    if (jobNeedsCredentials) continue;
    for (const step of job.steps) {
      if (!step.uses) continue;
      if (!step.uses.value.startsWith("actions/checkout@")) continue;
      if (step.persistCredentials === false) continue;
      findings.push({
        rule: "workflow/persist-credentials",
        severity: "warning",
        file: filename,
        line: step.uses.line,
        detail:
          step.persistCredentials === true
            ? `actions/checkout persists the GitHub token in this job, but no step pushes or publishes anything`
            : `actions/checkout persists the GitHub token by default in this job, but no step pushes or publishes anything`,
        fix: "add with: { persist-credentials: false } to the checkout step",
      });
    }
  }
}

function checkUntrustedInputInRun(
  findings: Finding[],
  filename: string,
  info: WorkflowInfo,
  steps: StepInfo[],
): void {
  const hasDispatch = info.triggers.includes("workflow_dispatch");
  const hasIssueComment = info.triggers.includes("issue_comment");
  if (!hasDispatch && !hasIssueComment) return;
  for (const step of steps) {
    if (!step.run) continue;
    let match: RegExpExecArray | null = null;
    if (hasDispatch) {
      match = WORKFLOW_DISPATCH_INPUT_RE.exec(step.run.value);
    }
    if (!match && hasIssueComment) {
      match = ISSUE_COMMENT_INPUT_RE.exec(step.run.value);
    }
    if (!match) continue;
    findings.push({
      rule: "workflow/untrusted-input-in-run",
      severity: "warning",
      file: filename,
      line: step.run.line,
      detail: `${match[0]} used unsanitized in run: — input from an untrusted user reaches the shell`,
      fix: "pass the input through an env var and validate or quote it before use; never interpolate it directly in run:",
    });
  }
}

/**
 * Runs all six workflow-security rules against one workflow file.
 * Throws on unparseable YAML (the runner turns that into exit 2).
 */
export function checkWorkflow(content: string, filename: string): Finding[] {
  const info = collectWorkflow(content);
  if (info === null) return [];
  const findings: Finding[] = [];
  const allSteps = info.jobs.flatMap((job) => job.steps);

  checkUnpinnedAction(findings, filename, allSteps);
  checkPullRequestTarget(findings, filename, info);
  checkTemplateInjection(findings, filename, allSteps);
  checkExcessivePermissions(findings, filename, info);
  checkPersistCredentials(findings, filename, info.jobs);
  checkUntrustedInputInRun(findings, filename, info, allSteps);

  return findings;
}
