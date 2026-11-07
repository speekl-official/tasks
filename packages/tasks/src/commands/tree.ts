import { Command } from "commander";

import { hasOpenStatus } from "../core/derive.js";
import { renderTree } from "../output.js";
import type { SpanOptions } from "./overview.js";
import { emitOverview, openSpan, scopeOptions, spanTasks } from "./overview.js";

interface TreeOptions extends SpanOptions {
  resolved?: boolean;
  json?: boolean;
}

export function treeCommand(): Command {
  return scopeOptions(
    new Command("tree").description(
      "open tasks nested by containment, with finishes_after joins under their task; JSON is the flat list; spans the listed projects",
    ),
  )
    .option("--resolved", "include done and cancelled tasks")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: TreeOptions, command: Command) => {
      const span = await openSpan(command, options, true);
      // Resolved tasks are added, not filtered for, so the nesting stays
      // complete: an open parent keeps its finished children beneath it.
      const rows = spanTasks(span).filter(
        options.resolved ? () => true : hasOpenStatus,
      );
      emitOverview(span, rows, (shown) =>
        renderTree(shown, { project: true, empty: "No open tasks." }),
      );
    });
}
