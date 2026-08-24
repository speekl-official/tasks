import path from "node:path";

import { Command } from "commander";

import { SKILLS_RELATIVE_DIR, SKILL_NAME, installSkill } from "../core/skill.js";
import { emitJson, ui, writeOut } from "../output.js";

export function skillCommand(): Command {
  const skill = new Command("skill").description("manage the bundled agent skill");

  skill
    .command("install")
    .description(`install the agent skill into ${SKILLS_RELATIVE_DIR}/${SKILL_NAME}/`)
    .option("--force", "overwrite an existing install (use after upgrading the CLI)")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { force?: boolean; json?: boolean }) => {
      const result = await installSkill(process.cwd(), { force: options.force });

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
        writeOut(ui.info(`Skill already installed at ${ui.bold(relative)}. Use --force to refresh.`));
        return;
      }

      writeOut(ui.success(`Installed the ${ui.bold(SKILL_NAME)} skill at ${ui.bold(relative)}`));
      for (const file of result.files) {
        writeOut(`  ${ui.dim(path.relative(process.cwd(), file))}`);
      }
    });

  return skill;
}
