import type { Command } from "commander";

import type { CommandContext } from "../context.js";
import { openContext, resolveScope } from "../context.js";
import type { DerivedTask, TimeKey } from "../core/derive.js";
import {
  TIME_KEYS,
  createdSince,
  inScope,
  isTimeKey,
  priorityAtLeast,
  timeComparator,
  updatedBefore,
} from "../core/derive.js";
import { unavailableReason } from "../core/gates.js";
import { compareIds } from "../core/ids.js";
import type { UnavailableTree } from "../core/projects.js";
import type { TreeDerivation } from "../core/snapshot.js";
import { snapshotAll, snapshotFromContext } from "../core/snapshot.js";
import type { Tree } from "../core/tree.js";
import { taskDepth, toMalformedJson } from "../core/tree.js";
import type {
  CollectionJson,
  Priority,
  UnavailableProjectJson,
} from "../core/types.js";
import { CONVENTION_VERSION, PRIORITIES, isPriority } from "../core/types.js";
import { parseSince } from "../core/time.js";
import { TaskError } from "../errors.js";
import type { OverviewOptions } from "../output.js";
import {
  emitJson,
  renderCollectionFooter,
  terminalWidth,
  writeOut,
} from "../output.js";

/**
 * What the overview commands (`ready`, `mine`, `list`, `tree`) share, so
 * their selection cannot drift apart: which trees they span, the local
 * scope, the order of the rows and the collection object they emit.
 */

/** The options of a command that spans trees: `--scope`, `--all`, `--local`. */
export interface SpanOptions {
  scope?: string;
  all?: boolean;
  local?: boolean;
}

/** The options of `list` and `tree` that limit the depth: `--depth`, `--top`. */
export interface DepthOptions {
  depth?: string;
  top?: boolean;
}

/** The option of `ready` and `list` that limits by priority: `--priority`. */
export interface PriorityOptions {
  priority?: string;
}

/** The options of `list` and `tree` that order by a time: `--sort`, `--reverse`. */
export interface SortOptions {
  sort?: string;
  reverse?: boolean;
}

/** The options of `list` that filter by a time: `--updated-before`, `--created-since`. */
export interface TimeFilterOptions {
  updatedBefore?: string;
  createdSince?: string;
}

/** What the time options resolve to, once, when the span opens. */
export interface TimeSelection {
  /** The key `--sort` names, or `null` for the tree order. */
  sort: TimeKey | null;
  /** Oldest first instead of newest first. */
  reverse: boolean;
  /** The bound of `--updated-before`, canonical, or `null`. */
  updatedBefore: string | null;
  /** The bound of `--created-since`, canonical, or `null`. */
  createdSince: string | null;
}

/** The trees one overview spans, derived for the calling actor. */
export interface Span {
  context: CommandContext;
  /** The resolved local scope, or `null`. */
  scope: string | null;
  /** The deepest level of containment shown, or `null` for every level. */
  depth: number | null;
  /** The lowest effective priority shown, or `null` for every level. */
  priority: Priority | null;
  /** The order and the time filters asked for. */
  time: TimeSelection;
  /** The instant the command started: ages and durations count from it. */
  now: Date;
  /** The local tree first, then every listed tree that loaded. */
  trees: TreeDerivation[];
  /** Listed projects left out because they could not be read. */
  unavailable: UnavailableTree[];
}

/** Declare `--scope`, `--all` and `--local` on a scoped overview. */
export function scopeOptions(command: Command): Command {
  return command
    .option(
      "--scope <path>",
      "restrict the local tree to this group or task path and keep to that tree (default: scope in config.yml)",
    )
    .option("--all", "ignore the configured scope")
    .option(
      "--local",
      "the local tree only, not the projects it lists (implied by a scope)",
    );
}

/** Declare `--depth <n>` and `--top` on an overview that shows containment. */
export function depthOptions(command: Command): Command {
  return command
    .option(
      "--depth <n>",
      "tasks at most n levels of containment deep, counted from the scope",
    )
    .option("--top", "the top level only: --depth 1");
}

/** Declare `--priority <level>` on an overview that filters by it. */
export function priorityOption(command: Command): Command {
  return command.option(
    "--priority <level>",
    `only tasks whose effective priority is at least this level: ${PRIORITIES.join(", ")}`,
  );
}

/** Declare `--sort <key>` and `--reverse` on an overview that orders by a time. */
export function sortOptions(command: Command): Command {
  return command
    .option(
      "--sort <key>",
      `order by a time, newest first: ${TIME_KEYS.join(" or ")} (default: tree order)`,
    )
    .option("--reverse", "with --sort: oldest first");
}

/** Declare `--updated-before <when>` and `--created-since <when>` on `list`. */
export function timeFilterOptions(command: Command): Command {
  return command
    .option(
      "--updated-before <when>",
      "only tasks last written before a timestamp, a date, or a duration back from now (30m, 12h, 7d, 2w)",
    )
    .option(
      "--created-since <when>",
      "only tasks created at or after a timestamp, a date, or a duration back from now",
    );
}

/**
 * The time options, checked: `--sort` names `created` or `updated`,
 * `--reverse` needs it, and each bound follows the grammar of `--since`.
 */
export function resolveTime(
  options: SortOptions & TimeFilterOptions,
  now: Date,
): TimeSelection {
  let sort: TimeKey | null = null;
  if (options.sort !== undefined) {
    if (!isTimeKey(options.sort)) {
      throw TaskError.usage(
        `Invalid --sort "${options.sort}": expected ${TIME_KEYS.join(" or ")}.`,
        { sort: options.sort, allowed: [...TIME_KEYS] },
      );
    }
    sort = options.sort;
  }
  if (options.reverse === true && sort === null) {
    throw TaskError.usage(
      "--reverse without --sort: the tree order has no direction to reverse; give --sort created or --sort updated.",
      { reverse: true },
    );
  }
  return {
    sort,
    reverse: options.reverse === true,
    updatedBefore:
      options.updatedBefore === undefined
        ? null
        : parseSince(options.updatedBefore, now, "--updated-before"),
    createdSince:
      options.createdSince === undefined
        ? null
        : parseSince(options.createdSince, now, "--created-since"),
  };
}

/** The level `--priority` names, or `null`; a level outside the four is refused. */
export function resolvePriority(options: PriorityOptions): Priority | null {
  if (options.priority === undefined) return null;
  if (!isPriority(options.priority)) {
    throw TaskError.usage(
      `Invalid --priority "${options.priority}": expected one of ${PRIORITIES.join(", ")}.`,
      { priority: options.priority, allowed: [...PRIORITIES] },
    );
  }
  return options.priority;
}

/**
 * The depth limit, or `null` for every level. `--top` is `--depth 1`; given
 * together they are refused, like `--scope` with `--all`.
 */
export function resolveDepth(options: DepthOptions): number | null {
  if (options.top === true) {
    if (options.depth !== undefined) {
      throw TaskError.usage(
        "--top and --depth together: --top is --depth 1, so give one of them.",
        { depth: options.depth },
      );
    }
    return 1;
  }
  if (options.depth === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(options.depth)) {
    throw TaskError.usage(
      `Invalid --depth "${options.depth}": expected a positive integer; 1 is the top level.`,
      { depth: options.depth },
    );
  }
  return Number(options.depth);
}

/**
 * Open the context and derive every tree the overview spans: the local tree
 * and, unless `--local` or a scope is in force, each tree listed under
 * `projects:` that is checked out and readable. A scope is a path of the
 * local tree, so while one applies, given or configured, the overview keeps
 * to that tree. `scoped` is false for `mine`, which the configuration's
 * scope does not restrict.
 */
export async function openSpan(
  command: Command,
  options: SpanOptions &
    DepthOptions &
    PriorityOptions &
    SortOptions &
    TimeFilterOptions,
  scoped: boolean,
): Promise<Span> {
  const now = new Date();
  const context = await openContext(command);
  const scope = scoped ? resolveScope(context, options) : null;
  const depth = resolveDepth(options);
  const priority = resolvePriority(options);
  const time = resolveTime(options, now);
  const local = options.local === true || scope !== null;
  const trees = await snapshotAll(
    snapshotFromContext(context),
    context.identity.actor,
    { local },
  );
  const unavailable = local
    ? []
    : (await context.projects.listed()).filter(
        (load): load is UnavailableTree => load.kind !== "ok",
      );
  return { context, scope, depth, priority, time, now, trees, unavailable };
}

/**
 * A scope is a path of the local tree; a listed tree, present only when no
 * scope is in force, passes whole.
 */
export function inSpan(span: Span, d: DerivedTask): boolean {
  return d.snapshot.project !== null || inScope(d.snapshot.task.id, span.scope);
}

/**
 * The depth limit counts from the scope in the local tree and from the root
 * of a listed tree, which the scope does not reach.
 */
function withinDepth(span: Span, tree: Tree, d: DerivedTask): boolean {
  if (span.depth === null) return true;
  const scope = d.snapshot.project === null ? span.scope : null;
  return taskDepth(tree, d.snapshot.task.id, scope) <= span.depth;
}

/** Every task in the span: the local tree first, each tree in id order. */
export function spanTasks(span: Span): DerivedTask[] {
  return span.trees.flatMap(({ load, derived }) =>
    [...derived.values()]
      .filter((d) => inSpan(span, d) && withinDepth(span, load.tree, d))
      .sort((a, b) => compareIds(a.snapshot.task.id, b.snapshot.task.id)),
  );
}

/**
 * The rows at the span's priority floor or above, by effective priority, so
 * an urgent epic's parts pass with it; every row when no floor is set. The
 * floor narrows what the other filters select instead of joining them.
 */
export function atPriority(span: Span, rows: DerivedTask[]): DerivedTask[] {
  if (span.priority === null) return rows;
  return rows.filter(priorityAtLeast(span.priority));
}

/** The rows within the time bounds asked for; every row without any. */
export function withinTime(span: Span, rows: DerivedTask[]): DerivedTask[] {
  const { updatedBefore: before, createdSince: since } = span.time;
  let out = rows;
  if (before !== null) out = out.filter(updatedBefore(before));
  if (since !== null) out = out.filter(createdSince(since));
  return out;
}

/**
 * The order `--sort` asks for, or `null` for the tree order the rows already
 * have. `list` sorts its rows with it; `tree` sorts siblings with it.
 */
export function timeOrder(
  span: Span,
): ((a: DerivedTask, b: DerivedTask) => number) | null {
  if (span.time.sort === null) return null;
  return timeComparator(
    span.time.sort,
    span.time.reverse,
    span.context.projects.aliases(),
  );
}

/**
 * The overview's rendering options for this span: ids carry their alias,
 * ages count from the command's start, a CREATED column joins UPDATED when
 * `created` is the key or the filter in play, and in a terminal the rows
 * are fitted to its width (piped output is never cut).
 */
export function viewOptions(span: Span): OverviewOptions {
  return {
    project: true,
    now: span.now,
    created: span.time.sort === "created" || span.time.createdSince !== null,
    width: terminalWidth(),
  };
}

/** Every task of every spanned tree, unscoped, for `readySet` to filter. */
export function allTasks(span: Span): DerivedTask[] {
  return span.trees.flatMap(({ derived }) => [...derived.values()]);
}

/** The aliases of the listed trees the span read. */
export function spannedAliases(span: Span): string[] {
  return span.trees.flatMap(({ load }) =>
    load.local || load.alias === null ? [] : [load.alias],
  );
}

/** The listed projects the span could not read, as the JSON reports them. */
export function unavailableOf(span: Span): UnavailableProjectJson[] {
  return span.unavailable.map((load) => ({
    alias: load.alias ?? load.relPath,
    reason: unavailableReason(load),
  }));
}

/**
 * The collection object. `projects` names the listed trees spanned;
 * `malformed` lists the unreadable manifests the query spans, so a scoped
 * query leaves out the local ones outside its scope, as it does their tasks.
 */
export function collectionOf(
  span: Span,
  rows: readonly DerivedTask[],
): CollectionJson {
  return {
    scope: span.scope,
    projects: spannedAliases(span),
    count: rows.length,
    tasks: rows.map((d) => d.json),
    malformed: span.trees.flatMap(({ load }) =>
      load.tree.malformed
        .filter((entry) => !load.local || inScope(entry.id, span.scope))
        .map(toMalformedJson),
    ),
    unavailable: unavailableOf(span),
  };
}

/** Why a listed project is missing from the overview, in a few words. */
/** The full sentence `actors` prints for a listed project it cannot read. */
export function unavailableText(load: UnavailableTree): string {
  const name = load.alias ?? load.relPath;
  switch (load.kind) {
    case "not-checked-out":
      return `${name} not shown: not checked out at ${load.dir}`;
    case "unsupported-version":
      return load.version === 1
        ? `${name} not shown: a .tasks v1 tree; upgrade it with \`tasks migrate ${name}\``
        : `${name} not shown: .tasks version ${load.version} is not supported (this tasks reads v${CONVENTION_VERSION})`;
    case "unresolved":
      return `${name} not shown: ${load.cause?.message ?? `no .tasks/ tree at ${load.dir}`}`;
  }
}

/**
 * Print the rows: the collection object under `--json`; otherwise the
 * rendering, then the footer (count, scope, depth, projects, the listed
 * projects that could not be shown, malformed manifests).
 */
export function emitOverview(
  span: Span,
  rows: readonly DerivedTask[],
  render: (rows: DerivedTask[]) => string,
): void {
  const collection = collectionOf(span, rows);
  if (span.context.json) {
    emitJson(collection);
    return;
  }
  writeOut(render([...rows]));
  writeOut("");
  writeOut(renderCollectionFooter(collection, span.depth, span.unavailable));
}
