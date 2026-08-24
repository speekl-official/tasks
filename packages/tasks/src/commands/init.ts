import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { TASKS_DIRNAME } from "../core/discovery.js";
import { isDirectory, writeFileAtomic } from "../core/fs-utils.js";
import { LOCKS_DIRNAME } from "../core/lock.js";
import { CONFIG_FILENAME } from "../core/config.js";
import { README_FILENAME } from "../core/repo.js";
import { SKILLS_RELATIVE_DIR, SKILL_NAME, installSkill } from "../core/skill.js";
import { configTemplate, gitignoreTemplate, readmeTemplate } from "../core/templates.js";
import { TaskError } from "../errors.js";
import { emitJson, ui, writeOut } from "../output.js";

export function initCommand(): Command {
  return new Command("init")
    .description(`scaffold a ${TASKS_DIRNAME}/ directory in the current project`)
    .option("--force", "reinitialize even if the directory already exists")
    .option("--no-skill", `skip installing the agent skill into ${SKILLS_RELATIVE_DIR}/`)
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { force?: boolean; skill?: boolean; json?: boolean }) => {
      const tasksDir = path.join(process.cwd(), TASKS_DIRNAME);

      if ((await isDirectory(tasksDir)) && !options.force) {
        throw TaskError.conflict(
          `${TASKS_DIRNAME}/ already exists at ${tasksDir}. Use --force to reinitialize.`,
          { path: tasksDir },
        );
      }

      await fs.mkdir(tasksDir, { recursive: true });
      await fs.mkdir(path.join(tasksDir, LOCKS_DIRNAME), { recursive: true });

      const files = [
        [path.join(tasksDir, CONFIG_FILENAME), configTemplate()],
        [path.join(tasksDir, README_FILENAME), readmeTemplate()],
        [path.join(tasksDir, ".gitignore"), gitignoreTemplate()],
      ] as const;

      const written: string[] = [];
      for (const [file, contents] of files) {
        // --force reinitializes the scaffold without clobbering an edited config.
        if (options.force && (await fileExists(file))) continue;
        await writeFileAtomic(file, contents);
        written.push(file);
      }

      // The skill is what makes an agent reach for the CLI unprompted, so it
      // ships with the scaffold rather than as a separate step someone forgets.
      // Like the config above, an existing install is left alone by --force;
      // refreshing it is an explicit `tasks skill install --force`.
      const skill = options.skill === false ? null : await installSkill(process.cwd());

      if (options.json) {
        emitJson({
          tasksDir,
          created: written,
          skill: skill ? { installed: skill.installed, dir: skill.dir, files: skill.files } : null,
        });
        return;
      }

      writeOut(ui.success(`Initialized ${ui.bold(TASKS_DIRNAME + "/")} at ${tasksDir}`));
      for (const file of written) {
        writeOut(`  ${ui.dim(path.relative(process.cwd(), file))}`);
      }
      if (skill?.installed) {
        for (const file of skill.files) {
          writeOut(`  ${ui.dim(path.relative(process.cwd(), file))}`);
        }
      }
      writeOut("");
      if (skill?.installed) {
        writeOut(
          ui.info(`Installed the ${ui.bold(SKILL_NAME)} skill so agents in this repo can find it.`),
        );
      }
      writeOut(ui.info(`Create your first task: ${ui.bold("tasks new <phase> <name>")}`));
    });
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
