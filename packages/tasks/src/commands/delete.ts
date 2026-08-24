import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { openTree } from "../context.js";
import { writeFileAtomic } from "../core/fs-utils.js";
import { renderTaskFile } from "../core/frontmatter.js";
import { withTaskLock } from "../core/lock.js";
import { parseRef } from "../core/refs.js";
import { ARCHIVE_DIRNAME, findTask, reloadTask, toFrontmatter } from "../core/repo.js";
import type { Task } from "../core/task.js";
import { TaskError } from "../errors.js";
import { emitJson, ui, writeOut } from "../output.js";

/** Live tasks whose depends_on points at `id`. */
function dependents(tasks: Task[], id: string): Task[] {
  return tasks.filter((task) =>
    task.depends_on.some((raw) => {
      try {
        const ref = parseRef(raw);
        return ref.kind === "local" && ref.id === id;
      } catch {
        return false;
      }
    }),
  );
}

export function deleteCommand(): Command {
  return new Command("delete")
    .description("archive a task (or permanently remove it with --purge)")
    .argument("<id>", "task id")
    .option("--force", "delete even if other tasks depend on it")
    .option("--purge", "permanently remove the file instead of archiving it")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, options: { force?: boolean; purge?: boolean; json?: boolean }) => {
      const tree = await openTree();
      const located = findTask(tree, id);

      const blockers = dependents(tree.tasks, id);
      if (blockers.length > 0 && !options.force) {
        throw TaskError.conflict(
          `Task "${id}" is depended on by: ${blockers.map((t) => t.id).join(", ")}. Use --force to delete anyway.`,
          { id, dependents: blockers.map((t) => t.id) },
        );
      }

      const archivePath = path.join(tree.project.tasksDir, ARCHIVE_DIRNAME, `${id}.md`);

      await withTaskLock(tree.project.tasksDir, id, async () => {
        const fresh = await reloadTask(located.filePath);

        if (options.purge) {
          await fs.rm(fresh.filePath, { force: true });
          return;
        }

        await fs.mkdir(path.dirname(archivePath), { recursive: true });
        // Preserve the originating phase in frontmatter — the archive is flat,
        // so the directory can no longer carry it.
        await writeFileAtomic(archivePath, renderTaskFile(toFrontmatter(fresh), fresh.body));
        await fs.rm(fresh.filePath, { force: true });
      });

      if (options.json) {
        emitJson({
          id,
          purged: Boolean(options.purge),
          ...(options.purge ? {} : { archived_to: archivePath }),
          orphaned_dependents: blockers.map((t) => t.id),
        });
        return;
      }

      if (options.purge) {
        writeOut(ui.success(`Permanently deleted ${ui.bold(id)}`));
      } else {
        writeOut(ui.success(`Archived ${ui.bold(id)}`));
        writeOut(`  ${ui.dim(path.relative(process.cwd(), archivePath))}`);
      }

      if (blockers.length > 0) {
        writeOut(
          ui.warn(
            `${blockers.map((t) => t.id).join(", ")} still reference "${id}" and are now blocked. Run \`tasks validate\`.`,
          ),
        );
      }
    });
}
