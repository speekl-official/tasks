import { Command } from "commander";

import { openTree, resolveScope, scopeTasks } from "../context.js";
import { DependencyResolver } from "../core/deps.js";
import { emitJson, renderTaskTable, taskToJson, ui, writeOut } from "../output.js";

export function readyCommand(): Command {
  return new Command("ready")
    .description("list unblocked tasks — what can be worked on right now")
    .option("-p, --phase <phase>", "restrict to one phase")
    .option("-a, --all", "search every phase, ignoring active_phase")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { phase?: string; all?: boolean; json?: boolean }) => {
      const tree = await openTree();
      const resolver = new DependencyResolver(tree);

      const candidates = scopeTasks(tree, options).filter(
        (t) => t.status === tree.config.roles.ready,
      );

      const readiness = await Promise.all(
        candidates.map(async (task) => ({ task, ready: await resolver.isReady(task) })),
      );
      const tasks = readiness.filter((r) => r.ready).map((r) => r.task);

      if (options.json) {
        // An empty result is a successful query, not an error — exit code stays 0.
        emitJson({
          phase: resolveScope(tree, options),
          count: tasks.length,
          tasks: tasks.map((t) => taskToJson(t)),
        });
        return;
      }

      if (tasks.length === 0) {
        writeOut(ui.dim("Nothing is ready to work on."));
        return;
      }

      const scope = resolveScope(tree, options);
      writeOut(renderTaskTable(tasks, tree.config, scope === null));
      writeOut("");
      writeOut(ui.dim(`${tasks.length} ready${scope ? ` in phase "${scope}"` : ""}`));
    });
}
