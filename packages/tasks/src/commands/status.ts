import { Command } from "commander";

import { assertKnownStatus, openTree } from "../context.js";
import { mutateTask } from "../core/mutate.js";
import { TaskError } from "../errors.js";
import { colorStatus, emitJson, taskToJson, ui, writeOut } from "../output.js";

export function statusCommand(): Command {
  return new Command("status")
    .description("update a task's status, validating the transition")
    .argument("<id>", "task id")
    .argument("<status>", "target status")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, target: string, options: { json?: boolean }) => {
      const tree = await openTree();
      assertKnownStatus(tree, target);

      // Routing claims through `tasks claim` is what guarantees claim metadata
      // is always recorded; the generic status command must not bypass it.
      if (target === tree.config.roles.claimed) {
        throw TaskError.usage(
          `Use \`tasks claim ${id}\` to move a task to ${target}, so the claim is recorded.`,
          { id, status: target },
        );
      }

      const previous = { status: "" };

      const task = await mutateTask(tree, id, (fresh) => {
        previous.status = fresh.status;

        if (fresh.status === target) {
          throw TaskError.conflict(`Task "${id}" is already ${target}.`, { id, status: target });
        }
        if (!tree.config.canTransition(fresh.status, target)) {
          const allowed = tree.config.allowedFrom(fresh.status);
          throw TaskError.conflict(
            `Illegal transition ${fresh.status} -> ${target}. Allowed from ${fresh.status}: ${allowed.length ? allowed.join(", ") : "(none)"}.`,
            { id, from: fresh.status, to: target, allowed },
          );
        }

        // Leaving the claimed status releases the claim.
        const leavingClaim = fresh.status === tree.config.roles.claimed;
        return {
          ...fresh,
          status: target,
          claimed_by: leavingClaim ? null : fresh.claimed_by,
          claimed_at: leavingClaim ? null : fresh.claimed_at,
        };
      });

      if (options.json) {
        emitJson(taskToJson(task, { previous_status: previous.status }));
        return;
      }

      writeOut(
        ui.success(
          `${ui.bold(id)}  ${colorStatus(previous.status, tree.config)} → ${colorStatus(task.status, tree.config)}`,
        ),
      );
    });
}
