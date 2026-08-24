import { Command, CommanderError } from "commander";

import { claimCommand } from "./commands/claim.js";
import { deleteCommand } from "./commands/delete.js";
import { depCommand } from "./commands/dep.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { moveCommand } from "./commands/move.js";
import { newCommand } from "./commands/new.js";
import { readyCommand } from "./commands/ready.js";
import { reindexCommand } from "./commands/reindex.js";
import { releaseCommand } from "./commands/release.js";
import { showCommand } from "./commands/show.js";
import { skillCommand } from "./commands/skill.js";
import { statusCommand } from "./commands/status.js";
import { validateCommand } from "./commands/validate.js";
import { ExitCode, TaskError, isTaskError } from "./errors.js";
import { emitJson, ui, writeErr } from "./output.js";

// Replaced at build time (tsup/vitest `define`) with the package.json version,
// so `tasks -v` and the published version can never disagree.
declare const __PKG_VERSION__: string;

export const VERSION = __PKG_VERSION__;

export function buildCli(): Command {
  const program = new Command();

  program
    .name("tasks")
    .description(
      "Local, git-versioned task manager for AI coding agents.\n\n" +
        "Task state lives in .tasks/ as markdown with YAML frontmatter. Every read\n" +
        "command supports --json; errors are JSON on stderr under --json, and exit\n" +
        "codes are meaningful (0 ok, 2 usage, 3 not found, 4 conflict).",
    )
    .version(VERSION, "-v, --version")
    .showHelpAfterError("(run `tasks --help` for usage)")
    .enablePositionalOptions();

  program.addCommand(initCommand());
  program.addCommand(newCommand());
  program.addCommand(listCommand());
  program.addCommand(showCommand());
  program.addCommand(readyCommand());
  program.addCommand(claimCommand());
  program.addCommand(releaseCommand());
  program.addCommand(statusCommand());
  program.addCommand(depCommand());
  program.addCommand(moveCommand());
  program.addCommand(deleteCommand());
  program.addCommand(reindexCommand());
  program.addCommand(validateCommand());
  program.addCommand(skillCommand());

  return program;
}

/** True when the invocation asked for JSON, so errors match that shape too. */
function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

export function reportError(error: unknown, argv: string[]): number {
  const taskError = isTaskError(error)
    ? error
    : TaskError.internal(error instanceof Error ? error.message : String(error));

  if (wantsJson(argv)) {
    // Structured errors go to stderr so stdout stays clean for parseable output.
    writeErr(JSON.stringify(taskError.toJSON(), null, 2));
  } else {
    writeErr(ui.error(taskError.message));
  }

  if (!isTaskError(error) && error instanceof Error && process.env.TASKS_DEBUG) {
    writeErr(ui.dim(error.stack ?? ""));
  }

  return taskError.exitCode;
}

export async function run(argv: string[]): Promise<number> {
  const program = buildCli();
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => process.stderr.write(str),
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return process.exitCode ? Number(process.exitCode) : ExitCode.Success;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are successful exits that commander models as throws.
      if (error.code === "commander.helpDisplayed" || error.code === "commander.help") {
        return ExitCode.Success;
      }
      if (error.code === "commander.version") return ExitCode.Success;
      if (wantsJson(argv)) {
        emitJson({ error: { code: "USAGE", message: error.message } });
      }
      return ExitCode.Usage;
    }
    return reportError(error, argv);
  }
}
