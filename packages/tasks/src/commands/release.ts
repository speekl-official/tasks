import { Command } from "commander";

import { openTree } from "../context.js";
import { mutateTask } from "../core/mutate.js";
import { TaskError } from "../errors.js";
import { colorStatus, emitJson, taskToJson, ui, writeOut } from "../output.js";

export function releaseCommand(): Command {
  return new Command("release")
    .description("give up a claimed task and return it to the ready pool")
    .argument("<id>", "task id")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const tree = await openTree();
      const { ready, claimed } = tree.config.roles;

      const task = await mutateTask(tree, id, (fresh) => {
        if (fresh.status !== claimed) {
          throw TaskError.conflict(
            `Task "${id}" is ${fresh.status}, not ${claimed}, so there is nothing to release.`,
            { id, status: fresh.status, expected: claimed },
          );
        }
        if (!tree.config.canTransition(fresh.status, ready)) {
          throw TaskError.conflict(
            `Illegal transition ${fresh.status} -> ${ready}; release is not available under this project's transition rules.`,
            { id, from: fresh.status, to: ready },
          );
        }
        return { ...fresh, status: ready, claimed_by: null, claimed_at: null };
      });

      if (options.json) {
        emitJson(taskToJson(task));
        return;
      }

      writeOut(
        ui.success(`Released ${ui.bold(id)} → ${colorStatus(task.status, tree.config)}`),
      );
    });
}
