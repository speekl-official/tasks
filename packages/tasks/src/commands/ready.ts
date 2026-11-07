import { Command } from "commander";

import { readySet } from "../core/derive.js";
import { renderOverview } from "../output.js";
import type { SpanOptions } from "./overview.js";
import { allTasks, emitOverview, openSpan, scopeOptions } from "./overview.js";

interface ReadyOptions extends SpanOptions {
  json?: boolean;
}

export function readyCommand(): Command {
  return scopeOptions(
    new Command("ready").description(
      "the tasks free for you to take, best first: effective priority, then paused before todo, then oldest; spans the listed projects",
    ),
  )
    .option("--json", "emit machine-readable JSON")
    .action(async (options: ReadyOptions, command: Command) => {
      const span = await openSpan(command, options, true);
      const rows = readySet(allTasks(span), {
        scope: span.scope,
        aliasOrder: span.context.projects.aliases(),
      });
      emitOverview(span, rows, (shown) =>
        renderOverview(shown, {
          project: true,
          empty: "Nothing is ready for you to take.",
        }),
      );
    });
}
