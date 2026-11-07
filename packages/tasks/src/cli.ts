import { Command, CommanderError } from "commander";

import {
  archiveCommand,
  deleteCommand,
  purgeCommand,
  restoreCommand,
} from "./commands/archive.js";
import { actorsCommand } from "./commands/actors.js";
import { afterCommand, depCommand } from "./commands/dep.js";
import { heartbeatCommand } from "./commands/heartbeat.js";
import { hooksCommand } from "./commands/hooks.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { logCommand } from "./commands/log.js";
import { migrateCommand } from "./commands/migrate.js";
import { mineCommand } from "./commands/mine.js";
import { moveCommand } from "./commands/move.js";
import { newCommand } from "./commands/new.js";
import { readyCommand } from "./commands/ready.js";
import { reindexCommand } from "./commands/reindex.js";
import { resumeCommand } from "./commands/resume.js";
import { sessionCheckCommand } from "./commands/session-check.js";
import { sessionEndCommand } from "./commands/session-end.js";
import { showCommand } from "./commands/show.js";
import { skillCommand } from "./commands/skill.js";
import { stateCommand } from "./commands/state.js";
import { transitionCommands } from "./commands/transitions.js";
import { treeCommand } from "./commands/tree.js";
import { validateCommand } from "./commands/validate.js";
import { ExitCode, TaskError, isTaskError } from "./errors.js";
import { ui, writeErr } from "./output.js";

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
        "Task state lives in .tasks/ as one directory per task with a markdown\n" +
        "manifest. Every command that produces output supports --json; errors\n" +
        "are JSON on stderr under --json, and exit codes are meaningful\n" +
        "(0 ok, 2 usage, 3 not found, 4 conflict).",
    )
    .version(VERSION, "-v, --version")
    .showHelpAfterError("(run `tasks --help` for usage)")
    // Accepted before or after the command name, so a harness can append
    // them to any invocation.
    .option(
      "-C, --dir <dir>",
      "start the search for .tasks/ in this directory instead of the current one",
    )
    .option(
      "--as <actor>",
      "act as this actor; the identity that would have acted is logged as the operator",
    )
    .option(
      "--session <token>",
      "the session token, else TASKS_SESSION; recorded on claims and in log headings",
    );

  // Commands are registered here, one block per module, as they land.
  // cli
  program.addCommand(initCommand());
  program.addCommand(showCommand());
  program.addCommand(resumeCommand());
  program.addCommand(readyCommand());
  program.addCommand(mineCommand());
  program.addCommand(actorsCommand());
  program.addCommand(listCommand());
  program.addCommand(treeCommand());
  program.addCommand(heartbeatCommand());
  program.addCommand(sessionEndCommand());
  program.addCommand(sessionCheckCommand());

  // transitions
  for (const command of transitionCommands()) program.addCommand(command);

  // validate
  program.addCommand(validateCommand());
  program.addCommand(reindexCommand());

  // structure
  program.addCommand(newCommand());
  program.addCommand(depCommand());
  program.addCommand(afterCommand());
  program.addCommand(logCommand());
  program.addCommand(stateCommand());
  program.addCommand(archiveCommand());
  program.addCommand(restoreCommand());
  program.addCommand(purgeCommand());
  program.addCommand(deleteCommand());

  // move
  program.addCommand(moveCommand());

  // migrate
  program.addCommand(migrateCommand());

  program.addCommand(skillCommand());
  program.addCommand(hooksCommand());

  return program;
}

/** True when the invocation asked for JSON, so errors match that shape too. */
function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

export function reportError(error: unknown, argv: string[]): number {
  const taskError = isTaskError(error)
    ? error
    : TaskError.internal(
        error instanceof Error ? error.message : String(error),
      );

  if (wantsJson(argv)) {
    // Structured errors go to stderr so stdout stays clean for parseable output.
    writeErr(JSON.stringify(taskError.toJSON(), null, 2));
  } else {
    writeErr(ui.error(taskError.message));
  }

  if (
    !isTaskError(error) &&
    error instanceof Error &&
    process.env.TASKS_DEBUG
  ) {
    writeErr(ui.dim(error.stack ?? ""));
  }

  return taskError.exitCode;
}

/** A command and every command beneath it. */
function commandTree(command: Command): Command[] {
  return [command, ...command.commands.flatMap(commandTree)];
}

export async function run(argv: string[]): Promise<number> {
  const program = buildCli();
  const json = wantsJson(argv);
  // `addCommand` copies no settings to the command it adds, so a parse error
  // inside a subcommand (an unknown option, a missing argument) would exit
  // the process with commander's code 1 and print text under --json. Every
  // command throws instead, so the usage code and the envelope below apply.
  for (const command of commandTree(program)) {
    command.exitOverride();
    command.configureOutput({
      writeOut: (str) => process.stdout.write(str),
      // Under --json the envelope written below is all that reaches stderr.
      writeErr: (str) => {
        if (!json) process.stderr.write(str);
      },
    });
    // `-C`, `--as` and `--session` work after any command name, so every
    // command's help lists them.
    command.configureHelp({
      ...command.configureHelp(),
      showGlobalOptions: true,
    });
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return process.exitCode ? Number(process.exitCode) : ExitCode.Success;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are successful exits that commander models as throws.
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.help"
      ) {
        return ExitCode.Success;
      }
      if (error.code === "commander.version") return ExitCode.Success;
      if (wantsJson(argv)) {
        // Usage errors from the parser go to stderr like every other error.
        writeErr(
          JSON.stringify(
            { error: { code: "USAGE", message: error.message.trim() } },
            null,
            2,
          ),
        );
      }
      return ExitCode.Usage;
    }
    return reportError(error, argv);
  }
}
