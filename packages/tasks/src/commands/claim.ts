import { Command } from "commander";

import { defaultActor, openTree } from "../context.js";
import { DependencyResolver, describeUnsatisfied } from "../core/deps.js";
import { mutateTask } from "../core/mutate.js";
import { nowIso } from "../core/task.js";
import { TaskError } from "../errors.js";
import { colorStatus, emitJson, taskToJson, ui, writeOut } from "../output.js";

export function claimCommand(): Command {
  return new Command("claim")
    .description("take ownership of a task and mark it in progress")
    .argument("<id>", "task id")
    .option("--as <who>", "identity to record (defaults to $TASKS_ACTOR or $USER)")
    .option("--force", "claim even if dependencies are unsatisfied")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, options: { as?: string; force?: boolean; json?: boolean }) => {
      const tree = await openTree();
      const actor = options.as ?? defaultActor();
      const { claimed } = tree.config.roles;

      const task = await mutateTask(tree, id, async (fresh) => {
        if (fresh.status === claimed) {
          throw TaskError.conflict(
            `Task "${id}" is already claimed${fresh.claimed_by ? ` by ${fresh.claimed_by}` : ""}${fresh.claimed_at ? ` at ${fresh.claimed_at}` : ""}.`,
            { id, claimed_by: fresh.claimed_by, claimed_at: fresh.claimed_at },
          );
        }
        // Claim is legal from any status that can reach the claimed role, not
        // just the ready one — that is what makes reopening a completed task
        // (done -> claimed) work while still recording who took it on.
        if (!tree.config.canTransition(fresh.status, claimed)) {
          throw TaskError.conflict(
            `Task "${id}" is ${fresh.status}, and ${fresh.status} -> ${claimed} is not a legal transition, so it cannot be claimed.`,
            { id, status: fresh.status, target: claimed },
          );
        }

        if (!options.force) {
          const resolver = new DependencyResolver(tree);
          const deps = await resolver.resolveAll(fresh.depends_on);
          const blocking = deps.filter((d) => !d.satisfied);
          if (blocking.length > 0) {
            throw TaskError.conflict(
              `Task "${id}" is blocked by: ${blocking.map(describeUnsatisfied).join(", ")}. Use --force to claim anyway.`,
              { id, blocked_by: blocking.map((d) => d.raw) },
            );
          }
        }

        return { ...fresh, status: claimed, claimed_by: actor, claimed_at: nowIso() };
      });

      if (options.json) {
        emitJson(taskToJson(task));
        return;
      }

      writeOut(
        ui.success(
          `Claimed ${ui.bold(id)} as ${ui.bold(actor)} → ${colorStatus(task.status, tree.config)}`,
        ),
      );
    });
}
