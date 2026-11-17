import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CiSource } from "./model.js";

/**
 * CI detection (0.2.0, Fase A).
 *
 * Decides which CI systems a repo uses by the files present:
 * `.github/workflows/*.yml|*.yaml` means GitHub Actions,
 * `.gitlab-ci.yml` means GitLab CI. Both can coexist.
 *
 * The `--ci` selection (`github | gitlab | auto`) is validated here;
 * the runner applies it in Fase B, when the rules run on the model.
 * `auto` (the default) means "whatever the repo has".
 */

export type CiSelection = CiSource | "auto";

const WORKFLOW_EXT = [".yml", ".yaml"];

export function detectCiSources(targetDir: string): CiSource[] {
  const found: CiSource[] = [];
  if (existsSync(join(targetDir, ".gitlab-ci.yml"))) {
    found.push("gitlab");
  }
  const workflowsDir = join(targetDir, ".github", "workflows");
  if (existsSync(workflowsDir)) {
    const hasWorkflow = readdirSync(workflowsDir, {
      withFileTypes: true,
    }).some(
      (entry) =>
        entry.isFile() &&
        WORKFLOW_EXT.some((ext) => entry.name.endsWith(ext)),
    );
    if (hasWorkflow) found.push("github");
  }
  return found;
}

export function parseCiSelection(value: string | undefined): CiSelection {
  if (value === undefined || value === "auto") return "auto";
  if (value === "github" || value === "gitlab") return value;
  throw new Error(
    `--ci must be one of github | gitlab | auto, got "${value}"`,
  );
}

export function resolveCiSources(
  selection: CiSelection,
  detected: CiSource[],
): CiSource[] {
  if (selection === "auto") return detected;
  return [selection];
}
