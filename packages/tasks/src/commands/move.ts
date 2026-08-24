import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { openTree } from "../context.js";
import { writeFileAtomic } from "../core/fs-utils.js";
import { renderTaskFile } from "../core/frontmatter.js";
import { withTaskLock } from "../core/lock.js";
import { findTask, reloadTask, taskFilePath, toFrontmatter } from "../core/repo.js";
import { assertValidPhase } from "../core/slug.js";
import { nowIso } from "../core/task.js";
import { TaskError } from "../errors.js";
import { emitJson, taskToJson, ui, writeOut } from "../output.js";

export function moveCommand(): Command {
  return new Command("move")
    .description("reassign a task's phase, relocating the file")
    .argument("<id>", "task id")
    .argument("<phase>", "destination phase (created if it does not exist)")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, phase: string, options: { json?: boolean }) => {
      const tree = await openTree();
      assertValidPhase(phase);

      const located = findTask(tree, id);
      if (located.phase === phase) {
        throw TaskError.conflict(`Task "${id}" is already in phase "${phase}".`, { id, phase });
      }

      const destination = taskFilePath(tree.project, phase, id);

      const moved = await withTaskLock(tree.project.tasksDir, id, async () => {
        const fresh = await reloadTask(located.filePath);
        const next = { ...fresh, phase, updated: nowIso(), filePath: destination };

        await fs.mkdir(path.dirname(destination), { recursive: true });
        // Write the destination first, then unlink the source: a crash between
        // the two leaves a duplicate (which `validate` reports) rather than
        // losing the task entirely.
        await writeFileAtomic(destination, renderTaskFile(toFrontmatter(next), next.body));
        await fs.rm(fresh.filePath, { force: true });

        await removeEmptyPhaseDir(path.dirname(fresh.filePath));
        return next;
      });

      if (options.json) {
        emitJson(taskToJson(moved, { previous_phase: located.phase }));
        return;
      }

      writeOut(ui.success(`Moved ${ui.bold(id)}: ${located.phase} → ${ui.bold(phase)}`));
      writeOut(`  ${ui.dim(path.relative(process.cwd(), destination))}`);
    });
}

async function removeEmptyPhaseDir(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) await fs.rmdir(dir);
  } catch {
    // Leaving an empty directory behind is harmless.
  }
}
