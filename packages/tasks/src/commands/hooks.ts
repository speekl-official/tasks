import path from "node:path";

import { Command } from "commander";

import {
  globalOptions,
  heartbeatAt,
  resolveCommandIdentity,
  startDirectory,
} from "../context.js";
import { assertListedActor } from "../core/actors.js";
import { detectTreeVersion } from "../core/config.js";
import { requireProject } from "../core/discovery.js";
import type { HookEvent } from "../core/hooks.js";
import {
  DEFAULT_HOOKS_ACTOR,
  SETTINGS_RELATIVE_PATH,
  installHooks,
} from "../core/hooks.js";
import { assertActor } from "../core/sessions.js";
import { TaskError } from "../errors.js";
import { emitJson, ui, writeOut } from "../output.js";

/** What `hooks install --json` prints. */
export interface HooksInstallJson {
  installed: boolean;
  /** The settings file. */
  file: string;
  /** The actor the hooks this run writes act as. */
  actor: string;
  /** The events whose tasks hook was added or replaced. */
  written: HookEvent[];
  /** The events whose tasks hook was already there and was left as it was. */
  kept: HookEvent[];
  /** Present only when nothing was written. */
  skipped?: "exists";
}

interface InstallOptions {
  actor: string;
  force?: boolean;
  json?: boolean;
}

/** `Stop hook`, `Stop and SessionEnd hooks`, `A, B and C hooks`. */
function hooksText(events: readonly string[]): string {
  if (events.length === 1) return `${events[0]} hook`;
  return `${events.slice(0, -1).join(", ")} and ${events.at(-1)} hooks`;
}

export function hooksCommand(): Command {
  const hooks = new Command("hooks")
    .description(
      "manage the Claude Code hooks that make the agent protocol automatic",
    )
    // An option on the bare group (`--json`) must not stop it short of its
    // own usage error, whose details the envelope then carries.
    .allowUnknownOption()
    // Without a subcommand there is nothing to do: an error, not help.
    .action(() => {
      throw TaskError.usage("hooks needs a subcommand: hooks install.", {
        command: "hooks",
        subcommands: ["install"],
      });
    });

  hooks
    .command("install")
    .description(
      `write the SessionStart, PostToolUse, Stop and SessionEnd hooks into ${SETTINGS_RELATIVE_PATH} at the root of the tree, keeping the rest of the file (the hooks need jq on PATH)`,
    )
    .option(
      "--actor <name>",
      "the actor the hooks act as, set as TASKS_ACTOR in each command",
      DEFAULT_HOOKS_ACTOR,
    )
    .option(
      "--force",
      "replace the tasks hooks already in the file with the current ones (use after upgrading the CLI)",
    )
    .option("--json", "emit machine-readable JSON")
    .action(async (options: InstallOptions, command: Command) => {
      const actor = assertActor(options.actor, "--actor");
      const global = globalOptions(command);
      // The settings belong to the repository the tree is in: they sit at
      // the root of the discovered tree, wherever below it this runs.
      const project = await requireProject(startDirectory(global));

      // The hooks will write under this name: a v2 tree with a roster must
      // list it, like any actor named for someone else.
      const detected = await detectTreeVersion(project.tasksDir);
      if (detected.kind === "v2") {
        assertListedActor(
          detected.config,
          project,
          actor,
          "--actor",
          `pass --actor <name> with one of them, or add "${actor}" there`,
        );
      }

      // Like every command: a bad --as or --session is a usage error before
      // anything is written, and a known session leaves its heartbeat in a
      // v2 tree and in the trees it lists.
      const identity = await resolveCommandIdentity(global, project.root);
      await heartbeatAt(project, identity.session);

      const result = await installHooks(project.root, {
        actor,
        force: options.force,
      });

      if (options.json) {
        const json: HooksInstallJson = {
          installed: result.installed,
          file: result.file,
          actor: result.actor,
          written: result.written,
          kept: result.kept,
          ...(result.skippedReason ? { skipped: result.skippedReason } : {}),
        };
        emitJson(json);
        return;
      }

      const shown = ui.bold(path.relative(process.cwd(), result.file));
      if (!result.installed) {
        writeOut(
          ui.info(
            options.force
              ? `Hooks already installed in ${shown}, as documented for actor ${ui.bold(actor)}.`
              : `Hooks already installed in ${shown}. Use --force to refresh them.`,
          ),
        );
        return;
      }

      const { kept } = result;
      const one = kept.length === 1;
      const keptNote =
        kept.length === 0
          ? ""
          : options.force
            ? `; the ${hooksText(kept)} ${one ? "was" : "were"} up to date`
            : `; kept the existing ${hooksText(kept)} (--force replaces ${one ? "it" : "them"})`;
      writeOut(
        ui.success(
          `Installed the ${hooksText(result.written)} in ${shown} for actor ${ui.bold(actor)}${keptNote}`,
        ),
      );
    });

  return hooks;
}
