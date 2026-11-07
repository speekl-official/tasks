import { Command } from "commander";

import type { DerivedTask, SituationFilterName } from "../core/derive.js";
import { hasOpenStatus, situationFilter } from "../core/derive.js";
import { renderOverview } from "../output.js";
import type { SpanOptions } from "./overview.js";
import { emitOverview, openSpan, scopeOptions, spanTasks } from "./overview.js";

/**
 * The situation filters of `list`, one flag per situation word plus
 * `--resolved` for done and cancelled together. The word `open` is the
 * situation of a parent with open children, not "every open task", which is
 * what `list` shows without a filter.
 */
export const LIST_FILTERS: ReadonlyArray<
  readonly [SituationFilterName, string]
> = [
  ["ready", "only tasks free to take"],
  ["blocked", "only tasks blocked by a dependency"],
  ["waiting", "only paused tasks waiting for their assignee"],
  ["assigned", "only tasks assigned to someone and not paused"],
  ["held", "only tasks held by a claimed or assigned ancestor"],
  ["working", "only claimed tasks"],
  ["parked", "only backlog tasks with started work"],
  ["backlog", "only backlog tasks without started work"],
  ["closable", "only parents whose children are all resolved"],
  ["open", "only parents with open children"],
  ["done", "only done tasks"],
  ["cancelled", "only cancelled tasks"],
  ["resolved", "only done and cancelled tasks"],
];

type ListOptions = SpanOptions & {
  json?: boolean;
} & Partial<Record<SituationFilterName, boolean>>;

/**
 * Without a flag, every task whose status is open; with flags, the tasks in
 * any of the situations named. Resolved tasks appear only when a flag that
 * selects them is given.
 */
function listSelection(options: ListOptions): (d: DerivedTask) => boolean {
  const filters = LIST_FILTERS.filter(([name]) => options[name] === true).map(
    ([name]) => situationFilter(name),
  );
  if (filters.length === 0) return hasOpenStatus;
  return (d) => filters.some((filter) => filter(d));
}

export function listCommand(): Command {
  const command = scopeOptions(
    new Command("list").description(
      "open tasks by situation, in tree order; --<situation> flags filter and combine with OR; spans the listed projects",
    ),
  );
  for (const [name, description] of LIST_FILTERS) {
    command.option(`--${name}`, description);
  }
  return command
    .option("--json", "emit machine-readable JSON")
    .action(async (options: ListOptions, cmd: Command) => {
      const span = await openSpan(cmd, options, true);
      const rows = spanTasks(span).filter(listSelection(options));
      emitOverview(span, rows, (shown) =>
        renderOverview(shown, { project: true, empty: "No tasks match." }),
      );
    });
}
