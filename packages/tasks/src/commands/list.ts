import { Command } from "commander";

import { assertKnownStatus, openTree, resolveScope, scopeTasks } from "../context.js";
import { emitJson, renderTaskTable, taskToJson, ui, writeOut } from "../output.js";

export function listCommand(): Command {
  return new Command("list")
    .description("list tasks, filterable by phase and status")
    .option("-p, --phase <phase>", "restrict to one phase")
    .option("-a, --all", "search every phase, ignoring active_phase")
    .option("-s, --status <status>", "restrict to one status")
    .option("--json", "emit machine-readable JSON")
    .action(
      async (options: { phase?: string; all?: boolean; status?: string; json?: boolean }) => {
        const tree = await openTree();

        if (options.status) assertKnownStatus(tree, options.status);

        let tasks = scopeTasks(tree, options);
        if (options.status) tasks = tasks.filter((t) => t.status === options.status);

        if (options.json) {
          emitJson({
            phase: resolveScope(tree, options),
            count: tasks.length,
            tasks: tasks.map((t) => taskToJson(t)),
          });
          return;
        }

        if (tasks.length === 0) {
          writeOut(ui.dim("No tasks match."));
          return;
        }

        const scope = resolveScope(tree, options);
        writeOut(renderTaskTable(tasks, tree.config, scope === null));
        writeOut("");
        writeOut(ui.dim(`${tasks.length} task(s)${scope ? ` in phase "${scope}"` : ""}`));
      },
    );
}
