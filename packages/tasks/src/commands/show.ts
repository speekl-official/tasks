import { Command } from "commander";

import { openTree } from "../context.js";
import { DependencyResolver } from "../core/deps.js";
import { findTask } from "../core/repo.js";
import { taskTitle } from "../core/task.js";
import {
  colorStatus,
  emitJson,
  renderDependencyList,
  taskToJson,
  ui,
  writeOut,
} from "../output.js";

export function showCommand(): Command {
  return new Command("show")
    .description("print one task's frontmatter and body")
    .argument("<id>", "task id")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const tree = await openTree();
      const task = findTask(tree, id);

      const resolver = new DependencyResolver(tree);
      const deps = await resolver.resolveAll(task.depends_on);
      const ready = task.status === tree.config.roles.ready && deps.every((d) => d.satisfied);

      if (options.json) {
        emitJson({
          ...taskToJson(task, { title: taskTitle(task), ready }),
          dependencies: deps.map((d) => ({
            ref: d.raw,
            satisfied: d.satisfied,
            status: d.status ?? null,
            reason: d.reason ?? null,
          })),
          body: task.body,
        });
        return;
      }

      writeOut(ui.bold(taskTitle(task)));
      writeOut("");
      writeOut(`  ${ui.dim("id")}       ${task.id}`);
      writeOut(`  ${ui.dim("phase")}    ${task.phase}`);
      writeOut(`  ${ui.dim("status")}   ${colorStatus(task.status, tree.config)}`);
      writeOut(`  ${ui.dim("created")}  ${task.created}`);
      writeOut(`  ${ui.dim("updated")}  ${task.updated}`);
      if (task.claimed_by) {
        writeOut(`  ${ui.dim("claimed")}  ${task.claimed_by} at ${task.claimed_at}`);
      }
      writeOut(`  ${ui.dim("path")}     ${task.filePath}`);

      if (deps.length > 0) {
        writeOut("");
        writeOut(renderDependencyList(deps));
      }

      writeOut("");
      writeOut(task.body.trim());
    });
}
