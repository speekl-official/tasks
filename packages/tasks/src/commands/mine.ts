import { Command } from "commander";

import type { DerivedTask } from "../core/derive.js";
import { readyComparator } from "../core/derive.js";
import { renderMine } from "../output.js";
import { emitOverview, openSpan, spanTasks, viewOptions } from "./overview.js";

interface MineOptions {
  local?: boolean;
  json?: boolean;
}

/**
 * The entry protocol's order: claims of this very session first (continue
 * them), then the actor's other claims (orphaned ones are taken over before
 * new work), then the inbox of tasks merely assigned. `yours` already holds
 * the case, computed with the same session rule as `session-check`.
 */
function claimRank(d: DerivedTask): number {
  switch (d.derived.yours) {
    case "this-session":
      return 0;
    case "inbox":
      return 2;
    default:
      return 1;
  }
}

export function mineCommand(): Command {
  return new Command("mine")
    .description(
      "open tasks you have claimed or are assigned, each with its situation and last log entry; spans the listed projects",
    )
    .option("--local", "the local tree only, not the projects it lists")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: MineOptions, command: Command) => {
      // The configured scope narrows what to take next, not what is yours.
      const span = await openSpan(command, options, false);
      const aliasOrder = span.context.projects.aliases();
      const rows = spanTasks(span)
        .filter((d) => d.derived.yours !== null)
        .sort(
          (a, b) =>
            claimRank(a) - claimRank(b) || readyComparator(a, b, aliasOrder),
        );
      emitOverview(span, rows, (shown) => renderMine(shown, viewOptions(span)));
    });
}
