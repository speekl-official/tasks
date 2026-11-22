import { Command } from "commander";

import { hasOpenStatus } from "../core/derive.js";
import { renderTree, treeSequence } from "../output.js";
import { FIELDS_FLAG, FIELDS_HELP } from "./options.js";
import type { DepthOptions, SortOptions, SpanOptions } from "./overview.js";
import {
  depthOptions,
  emitOverview,
  openSpan,
  scopeOptions,
  sortOptions,
  spanTasks,
  timeOrder,
  viewOptions,
} from "./overview.js";

interface TreeOptions extends SpanOptions, DepthOptions, SortOptions {
  resolved?: boolean;
  json?: boolean;
}

export function treeCommand(): Command {
  return sortOptions(
    depthOptions(
      scopeOptions(
        new Command("tree").description(
          "open tasks nested by containment, siblings sharing a group or a project under one line naming it, in id order or by a time (--sort), with finishes_after joins under their task; JSON is the flat list; spans the listed projects",
        ),
      ),
    ),
  )
    .option("--resolved", "include done and cancelled tasks")
    .option("--json", "emit machine-readable JSON")
    .option(FIELDS_FLAG, FIELDS_HELP)
    .action(async (options: TreeOptions, command: Command) => {
      const span = await openSpan(command, options, true);
      // Resolved tasks are added, not filtered for, so the nesting stays
      // complete: an open parent keeps its finished children beneath it.
      const rows = spanTasks(span).filter(
        options.resolved ? () => true : hasOpenStatus,
      );
      const order = timeOrder(span);
      const view = {
        ...viewOptions(span),
        ...(order === null ? {} : { order }),
      };
      // The JSON is the nesting flattened, so a sort reaches both outputs.
      emitOverview(span, treeSequence(rows, view), (shown) =>
        renderTree(shown, { ...view, empty: "No open tasks." }),
      );
    });
}
