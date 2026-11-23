import { Command } from "commander";

import type { DerivedTask, ListFilterName } from "../core/derive.js";
import { hasOpenStatus, situationFilter } from "../core/derive.js";
import { renderOverview } from "../output.js";
import { FIELDS_FLAG, FIELDS_HELP } from "./options.js";
import type {
  DepthOptions,
  PriorityOptions,
  SortOptions,
  SpanOptions,
  TimeFilterOptions,
} from "./overview.js";
import {
  atPriority,
  depthOptions,
  emitOverview,
  openSpan,
  priorityOption,
  scopeOptions,
  sortOptions,
  spanTasks,
  timeFilterOptions,
  timeOrder,
  viewOptions,
  withinTime,
} from "./overview.js";

/**
 * The filters of `list`: one flag per situation word, `--resolved` for done
 * and cancelled together, and `--active` for the label (work in progress
 * beneath the task). The word `open` is the situation of a parent with open
 * children, not "every open task", which is what `list` shows without a
 * filter. `--priority <level>`, `--updated-before` and `--created-since` are
 * not among them: each narrows whatever the flags select.
 */
export const LIST_FILTERS: ReadonlyArray<readonly [ListFilterName, string]> = [
  [
    "ready",
    "only tasks in the ready situation; tasks ready also lists yours and the closable ones",
  ],
  ["blocked", "only tasks blocked by a dependency"],
  ["waiting", "only paused tasks waiting for their assignee"],
  ["assigned", "only tasks assigned to someone and not paused"],
  ["held", "only tasks held by a claimed or assigned ancestor"],
  ["working", "only claimed tasks"],
  ["active", "only tasks with a claimed task beneath them"],
  ["parked", "only backlog tasks with started work"],
  ["backlog", "only backlog tasks without started work"],
  ["closable", "only parents whose children are all resolved"],
  ["open", "only parents with open children"],
  ["done", "only done tasks"],
  ["cancelled", "only cancelled tasks"],
  ["resolved", "only done and cancelled tasks"],
];

type ListOptions = SpanOptions &
  DepthOptions &
  PriorityOptions &
  SortOptions &
  TimeFilterOptions & {
    json?: boolean;
  } & Partial<Record<ListFilterName, boolean>>;

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
  const command = depthOptions(
    scopeOptions(
      new Command("list").description(
        "open tasks by situation, in tree order or by a time (--sort); --<situation> flags filter and combine with OR, --priority and the time bounds narrow them; spans the listed projects",
      ),
    ),
  );
  for (const [name, description] of LIST_FILTERS) {
    command.option(`--${name}`, description);
  }
  return sortOptions(timeFilterOptions(priorityOption(command)))
    .option("--json", "emit machine-readable JSON")
    .option(FIELDS_FLAG, FIELDS_HELP)
    .action(async (options: ListOptions, cmd: Command) => {
      const span = await openSpan(cmd, options, true);
      const rows = atPriority(
        span,
        withinTime(span, spanTasks(span).filter(listSelection(options))),
      );
      const order = timeOrder(span);
      if (order !== null) rows.sort(order);
      emitOverview(span, rows, (shown) =>
        renderOverview(shown, {
          ...viewOptions(span),
          empty: "No tasks match.",
        }),
      );
    });
}
