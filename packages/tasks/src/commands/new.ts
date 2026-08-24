import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { openTree } from "../context.js";
import { writeFileAtomic } from "../core/fs-utils.js";
import type { Frontmatter } from "../core/frontmatter.js";
import { renderTaskFile } from "../core/frontmatter.js";
import { taskFilePath } from "../core/repo.js";
import { assertValidPhase, slugify } from "../core/slug.js";
import { nowIso } from "../core/task.js";
import { taskBodyTemplate } from "../core/templates.js";
import { isValidId } from "../core/refs.js";
import { TaskError } from "../errors.js";
import { emitJson, ui, writeOut } from "../output.js";

export function newCommand(): Command {
  return new Command("new")
    .description("create a task from the template, in a given phase")
    .argument("<phase>", "phase directory (created if it does not exist)")
    .argument("<name...>", "human-readable task name")
    .option("--id <id>", "explicit task id (defaults to a slug of <name>)")
    .option("--json", "emit machine-readable JSON")
    .action(async (phase: string, nameParts: string[], options: { id?: string; json?: boolean }) => {
      const tree = await openTree();
      const title = nameParts.join(" ").trim();

      assertValidPhase(phase);

      const id = options.id ?? slugify(title);
      if (!isValidId(id)) {
        throw TaskError.usage(
          `Invalid task id "${id}". Ids are lowercase kebab-case (letters, digits, hyphens).`,
          { id },
        );
      }

      // Ids are globally unique, and archived ids stay reserved so a new task
      // can never silently inherit an archived one's inbound dependencies.
      const existing = tree.tasks.find((t) => t.id === id);
      if (existing) {
        throw TaskError.conflict(
          `Task id "${id}" already exists in phase "${existing.phase}". Pass --id to choose another.`,
          { id, phase: existing.phase },
        );
      }
      const archived = tree.archived.find((t) => t.id === id);
      if (archived) {
        throw TaskError.conflict(
          `Task id "${id}" is reserved by an archived task. Pass --id to choose another.`,
          { id, archived: true },
        );
      }

      const timestamp = nowIso();
      const frontmatter: Frontmatter = {
        id,
        phase,
        status: tree.config.roles.ready,
        depends_on: [],
        created: timestamp,
        updated: timestamp,
        claimed_by: null,
        claimed_at: null,
      };

      const filePath = taskFilePath(tree.project, phase, id);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await writeFileAtomic(filePath, renderTaskFile(frontmatter, taskBodyTemplate(title)));

      if (options.json) {
        emitJson({ ...frontmatter, path: filePath });
        return;
      }

      writeOut(ui.success(`Created ${ui.bold(id)} in phase ${ui.bold(phase)}`));
      writeOut(`  ${ui.dim(path.relative(process.cwd(), filePath))}`);
    });
}
