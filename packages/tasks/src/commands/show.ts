import { Command } from "commander";

import type { CommandContext } from "../context.js";
import { deriveWithin, openContext, resolveTaskArgument } from "../context.js";
import { addressTree, readArchivedTask } from "../core/archive.js";
import type { DerivedTask, SnapshotTask } from "../core/derive.js";
import { deriveTree } from "../core/derive.js";
import type { LoadedTree } from "../core/projects.js";
import type { Task } from "../core/task.js";
import type { TaskWithDerivedJson, WorkspaceFilename } from "../core/types.js";
import { lastLogEntry, workspaceFiles } from "../core/workspace.js";
import { emitJson, renderShow, writeOut } from "../output.js";

/** What `show --json` prints: the task object with derived conditions. */
export interface ShowJson extends TaskWithDerivedJson {
  body: string;
  /** The workspace vocabulary files present beside `task.md`. */
  workspace: WorkspaceFilename[];
  /** Live tasks, here and in listed trees, whose gates name this task. */
  referenced_by: string[];
  /** Present, and true, when the task was read from `.archive/`. */
  archived?: true;
}

/**
 * An archived task derived among the archive: its subtree's children and its
 * archived ancestors are there, gates are moot for a resolved task, and only
 * the shown task's log is read.
 */
async function deriveArchived(
  context: CommandContext,
  load: LoadedTree,
  task: Task,
): Promise<DerivedTask> {
  const lastEntry = await lastLogEntry(task.dir);
  const tasks: SnapshotTask[] = load.tree.archived.map((entry) => ({
    task: entry,
    project: load.alias,
    start: { satisfied: true, refs: [] },
    finish: { satisfied: true, open_children: [], refs: [] },
    liveness: null,
    lastEntry: entry.id === task.id ? lastEntry : null,
  }));
  const derived = deriveTree(
    { tree: load.tree, project: load.alias, tasks },
    context.identity.actor,
    context.identity.session,
  ).get(task.id);
  if (derived === undefined) {
    throw new Error(`${task.id} was read from the archive but not derived.`);
  }
  return derived;
}

export const TASK_ARGUMENT_HELP =
  "a task path, an unambiguous suffix of one, or alias:path in a listed project";

export function showCommand(): Command {
  return new Command("show")
    .description(
      "a task: its fields, derived conditions, workspace files, the tasks that reference it, and its body",
    )
    .argument("<task>", TASK_ARGUMENT_HELP)
    .option(
      "--archived",
      "read a task under .archive/ by its former path in full, without restoring it",
    )
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        arg: string,
        options: { archived?: boolean },
        command: Command,
      ) => {
        const context = await openContext(command);
        const archived = options.archived === true;
        let load: LoadedTree;
        let task: Task;
        let shown: DerivedTask;
        if (archived) {
          const addressed = await addressTree(context, arg, "path");
          load = addressed.load;
          task = readArchivedTask(context, load, addressed.path);
          shown = await deriveArchived(context, load, task);
        } else {
          ({ load, task } = await resolveTaskArgument(context, arg));
          ({ task: shown } = await deriveWithin(context, load, task.id));
        }
        const extras = {
          body: task.body,
          workspace: workspaceFiles(task),
          referenced_by: await context.gates.referencedBy(load, task.id),
        };

        if (context.json) {
          const result: ShowJson = archived
            ? { ...shown.json, ...extras, archived: true }
            : { ...shown.json, ...extras };
          emitJson(result);
          return;
        }
        writeOut(renderShow(shown, { ...extras, archived }));
      },
    );
}
