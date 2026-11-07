import path from "node:path";

import { Command } from "commander";

import {
  globalOptions,
  heartbeatAt,
  resolveCommandIdentity,
  startDirectory,
} from "../context.js";
import { findProject } from "../core/discovery.js";
import {
  SKILLS_RELATIVE_DIR,
  SKILL_NAME,
  installSkill,
} from "../core/skill.js";
import { TaskError } from "../errors.js";
import { emitJson, ui, writeOut } from "../output.js";

export function skillCommand(): Command {
  const skill = new Command("skill")
    .description("manage the bundled agent skill")
    // An option on the bare group (`--json`) must not stop it short of its
    // own usage error, whose details the envelope then carries.
    .allowUnknownOption()
    // Without a subcommand there is nothing to do: an error, not help.
    .action(() => {
      throw TaskError.usage("skill needs a subcommand: skill install.", {
        command: "skill",
        subcommands: ["install"],
      });
    });

  skill
    .command("install")
    .description(
      `install the agent skill into ${SKILLS_RELATIVE_DIR}/${SKILL_NAME}/`,
    )
    .option(
      "--force",
      "overwrite an existing install (use after upgrading the CLI)",
    )
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        options: { force?: boolean; json?: boolean },
        command: Command,
      ) => {
        const global = globalOptions(command);
        const start = startDirectory(global);
        // The skill belongs to the repository: at the root of the tree when
        // one is discovered, wherever below it this runs; where the command
        // runs when there is no tree yet (`init` creates it there).
        const project = await findProject(start);
        const root = project?.root ?? start;
        // Like every command: a bad --as or --session is a usage error before
        // anything is written, and a known session leaves its heartbeat in
        // the v2 tree at the target, when there is one, and in the trees it
        // lists.
        const identity = await resolveCommandIdentity(global, root);
        if (project) await heartbeatAt(project, identity.session);

        const result = await installSkill(root, { force: options.force });

        if (options.json) {
          emitJson({
            installed: result.installed,
            dir: result.dir,
            files: result.files,
            ...(result.skippedReason ? { skipped: result.skippedReason } : {}),
          });
          return;
        }

        const relative = path.relative(process.cwd(), result.dir);

        if (!result.installed) {
          writeOut(
            ui.info(
              `Skill already installed at ${ui.bold(relative)}. Use --force to refresh.`,
            ),
          );
          return;
        }

        writeOut(
          ui.success(
            `Installed the ${ui.bold(SKILL_NAME)} skill at ${ui.bold(relative)}`,
          ),
        );
        for (const file of result.files) {
          writeOut(`  ${ui.dim(path.relative(process.cwd(), file))}`);
        }
      },
    );

  return skill;
}
