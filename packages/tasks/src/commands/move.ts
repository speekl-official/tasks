import { Command } from "commander";

import { openContext } from "../context.js";
import { qualifyId } from "../core/ids.js";
import type { MoveResult } from "../core/relocate.js";
import { moveJson, moveSubtree } from "../core/relocate.js";
import type { RewrittenRefJson } from "../core/types.js";
import { forcedSuffix } from "../core/workspace.js";
import { emitJson, ui, writeOut } from "../output.js";

interface MoveCommandOptions {
  force?: boolean;
  json?: boolean;
}

export function moveCommand(): Command {
  return new Command("move")
    .summary(
      "relocate a task or group and rewrite references to it in every listed tree",
    )
    .description(
      "relocate a task or a group to a new path in the same tree; references\n" +
        "to everything it moves are rewritten in this tree and in every listed\n" +
        "tree, and the ones it cannot write are listed",
    )
    .argument(
      "<source>",
      "a task (path or unambiguous suffix; alias:path in a listed project) or a group (its full path)",
    )
    .argument(
      "<destination>",
      "the new path, in the source's tree; never resolved as a suffix",
    )
    .option(
      "--force",
      "move work in progress claimed by someone else, or a task assigned to someone else",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(
      async (
        source: string,
        destination: string,
        options: MoveCommandOptions,
        command: Command,
      ) => {
        const context = await openContext(command);
        const result = await moveSubtree(context, source, destination, {
          force: options.force,
        });
        if (context.json) {
          emitJson(moveJson(result));
          return;
        }
        writeOut(renderMove(result));
      },
    );
}

/** The rewrites, grouped by the tree holding them, in result order. */
function byProject(
  refs: RewrittenRefJson[],
): Map<string | null, RewrittenRefJson[]> {
  const out = new Map<string | null, RewrittenRefJson[]>();
  for (const ref of refs) {
    const list = out.get(ref.project);
    if (list === undefined) out.set(ref.project, [ref]);
    else list.push(ref);
  }
  return out;
}

/**
 * One `✓` line for the move, then what moved with it, what it deferred, the
 * references it rewrote per tree, the claims it went past, and a `!` line
 * for every reference it could not write.
 */
function renderMove(result: MoveResult): string {
  const lines = [
    ui.success(
      `move ${result.from} → ${result.to}${forcedSuffix(result.forced)}`,
    ),
  ];
  if (result.tasks.length === 0)
    lines.push(`  ${ui.dim("no task beneath it")}`);
  for (const task of result.tasks) {
    // The source task itself is the line above.
    if (task.from !== result.from) lines.push(`  ${task.from} → ${task.to}`);
  }
  if (result.deferred.length > 0) {
    lines.push(
      `  deferred under a BACKLOG parent: ${result.deferred.join(", ")}`,
    );
  }
  for (const [project, refs] of byProject(result.rewritten)) {
    lines.push(`  rewritten in ${project ?? "this tree"}:`);
    for (const ref of refs) {
      lines.push(`    ${ref.task} ${ref.field}: ${ref.from} → ${ref.to}`);
    }
  }
  for (const claim of result.superseded) {
    const session = claim.session === null ? "" : ` s:${claim.session}`;
    lines.push(
      `  ${ui.dim(`superseded ${claim.claimant}${session} on ${claim.id} (${claim.liveness}, last seen ${claim.last_seen ?? "unknown"})`)}`,
    );
  }
  for (const tree of result.skipped) {
    lines.push(
      `  ${ui.warn(`${tree.project ?? "this tree"} could not be written: ${tree.reason}`)}`,
    );
  }
  for (const ref of result.unrewritten) {
    lines.push(
      `  ${ui.warn(`not rewritten: ${qualifyId(ref.project, ref.task)} ${ref.field} ${ref.ref}`)}`,
    );
  }
  return lines.join("\n");
}
