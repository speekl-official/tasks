import { Command } from "commander";

import { deriveWithin, openContext, resolveTaskArgument } from "../context.js";
import type { TaskWithDerivedJson, WorkspaceFilename } from "../core/types.js";
import { workspaceFiles } from "../core/workspace.js";
import { emitJson, renderShow, writeOut } from "../output.js";

/** What `show --json` prints: the task object with derived conditions. */
export interface ShowJson extends TaskWithDerivedJson {
  body: string;
  /** The workspace vocabulary files present beside `task.md`. */
  workspace: WorkspaceFilename[];
  /** Live tasks, here and in listed trees, whose gates name this task. */
  referenced_by: string[];
}

export const TASK_ARGUMENT_HELP =
  "a task path, an unambiguous suffix of one, or alias:path in a listed project";

export function showCommand(): Command {
  return new Command("show")
    .description(
      "a task: its fields, derived conditions, workspace files, the tasks that reference it, and its body",
    )
    .argument("<task>", TASK_ARGUMENT_HELP)
    .option("--json", "emit machine-readable JSON")
    .action(async (arg: string, _options: unknown, command: Command) => {
      const context = await openContext(command);
      const { load, task } = await resolveTaskArgument(context, arg);
      const { task: shown } = await deriveWithin(context, load, task.id);
      const extras = {
        body: task.body,
        workspace: workspaceFiles(task),
        referenced_by: await context.gates.referencedBy(load, task.id),
      };

      if (context.json) {
        const result: ShowJson = { ...shown.json, ...extras };
        emitJson(result);
        return;
      }
      writeOut(renderShow(shown, extras));
    });
}
