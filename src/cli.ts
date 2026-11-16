#!/usr/bin/env node
import process from "node:process";
import { ConfigError } from "./config.js";
import { runCheck, runInit, type RunResult } from "./runner.js";
import { renderTerminal, renderJson, renderJunit } from "./report.js";
import { CHECK_FAMILIES, type CheckFamily } from "./types.js";
import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

const USAGE = `pipeline-doctor ${VERSION} — one command that tells you if your pipeline is safe before it costs you the repo.

Usage:
  pipeline-doctor [path]                  audit the repo at [path] (default: current directory)
  pipeline-doctor check [path]            same as above
  pipeline-doctor init [path]             write an example pipeline-doctor.yml (refuses to overwrite)

Options:
  --only <family>     run one check family: workflow | secrets | deps | hygiene | ci | deploy
  --repo-only         deploy checks without cluster access: DEP-01, DEP-04,
                      DEP-09 and DEP-10 are reported as skipped, not failed
  --json              print the report as JSON instead of the terminal report
  --junit             print the report as JUnit XML instead of the terminal report
  --no-color          disable colors even when stdout is a TTY
  --help, -h          show this help
  --version, -v       show the version

Exit codes:
  0  no error findings (warnings only fail with failOn: warning)
  1  at least one error finding (or warning with failOn: warning)
  2  usage error, invalid config, or unreadable directory`;

interface CliOptions {
  command: "check" | "init";
  targetDir: string;
  only?: CheckFamily;
  repoOnly: boolean;
  json: boolean;
  junit: boolean;
  noColor: boolean;
}

function failUsage(message: string): never {
  console.error(`pipeline-doctor: error: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "check",
    targetDir: ".",
    repoOnly: false,
    json: false,
    junit: false,
    noColor: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--version" || arg === "-v") {
      console.log(VERSION);
      process.exit(0);
    }
    if (arg === "--repo-only") {
      options.repoOnly = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--junit") {
      options.junit = true;
      continue;
    }
    if (arg === "--no-color") {
      options.noColor = true;
      continue;
    }
    if (arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined) {
        failUsage(
          "--only requires a family: workflow | secrets | deps | hygiene | ci | deploy",
        );
      }
      if (!(CHECK_FAMILIES as string[]).includes(value)) {
        failUsage(
          `--only must be one of workflow | secrets | deps | hygiene | ci | deploy, got "${value}"`,
        );
      }
      options.only = value as CheckFamily;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      failUsage(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }

  if (options.json && options.junit) {
    failUsage("--json and --junit cannot be used together");
  }

  if (positionals.length > 2) {
    failUsage(`too many positional arguments: ${positionals.join(" ")}`);
  }

  const [first, second] = positionals;
  if (first === "init" || first === "check") {
    options.command = first;
    options.targetDir = second ?? ".";
  } else if (first !== undefined) {
    options.targetDir = first;
  }

  return options;
}

async function runOrExit(options: CliOptions): Promise<RunResult> {
  try {
    return await runCheck({
      only: options.only,
      targetDir: options.targetDir,
      // --repo-only forces repo-only on; without the flag the runner
      // falls back to the deploy.repoOnly value from the config file.
      repoOnly: options.repoOnly ? true : undefined,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`pipeline-doctor: error: ${error.message}`);
      process.exit(2);
    }
    console.error(
      `pipeline-doctor: error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "init") {
    try {
      const path = runInit(options.targetDir);
      console.log(`wrote ${path}`);
    } catch (error) {
      console.error(
        `pipeline-doctor: error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
    return;
  }

  const result = await runOrExit(options);

  for (const note of result.notes) {
    console.error(note);
  }

  const useColor =
    !options.noColor &&
    process.stdout.isTTY === true &&
    !options.json &&
    !options.junit;
  if (options.json) {
    process.stdout.write(renderJson(result.report, VERSION));
  } else if (options.junit) {
    process.stdout.write(renderJunit(result.report));
  } else {
    process.stdout.write(renderTerminal(result.report, useColor));
  }
  process.exitCode = result.exitCode;
}

// Yoan's fix (main 8ace21c): a rejected promise must not surface as an
// unhandled rejection — report it and exit 1.
main().catch((error) => {
  console.error("pipeline-doctor: unexpected error:", error);
  process.exit(1);
});
