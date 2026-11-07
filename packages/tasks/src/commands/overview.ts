import type { Command } from "commander";

import type { CommandContext } from "../context.js";
import { openContext, resolveScope } from "../context.js";
import type { DerivedTask } from "../core/derive.js";
import { inScope } from "../core/derive.js";
import { unavailableReason } from "../core/gates.js";
import { compareIds } from "../core/ids.js";
import type { UnavailableTree } from "../core/projects.js";
import type { TreeDerivation } from "../core/snapshot.js";
import { snapshotAll, snapshotFromContext } from "../core/snapshot.js";
import { toMalformedJson } from "../core/tree.js";
import type { CollectionJson, UnavailableProjectJson } from "../core/types.js";
import { CONVENTION_VERSION } from "../core/types.js";
import { emitJson, renderCollectionFooter, ui, writeOut } from "../output.js";

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

/** The trees one overview spans, derived for the calling actor. */
export interface Span {
  context: CommandContext;
  /** The resolved local scope, or `null`. */
  scope: string | null;
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
      "restrict the local tree to this group or task path (default: scope in config.yml)",
    )
    .option("--all", "ignore the configured scope")
    .option("--local", "the local tree only, not the projects it lists");
}

/**
 * Open the context and derive every tree the overview spans: the local tree
 * and, unless `--local`, each tree listed under `projects:` that is checked
 * out and readable. `scoped` is false for `mine`, which the configuration's
 * scope does not restrict.
 */
export async function openSpan(
  command: Command,
  options: SpanOptions,
  scoped: boolean,
): Promise<Span> {
  const context = await openContext(command);
  const scope = scoped ? resolveScope(context, options) : null;
  const local = options.local === true;
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
  return { context, scope, trees, unavailable };
}

/** A scope applies to the local tree only; listed trees pass it whole. */
export function inSpan(span: Span, d: DerivedTask): boolean {
  return d.snapshot.project !== null || inScope(d.snapshot.task.id, span.scope);
}

/** Every task in the span: the local tree first, each tree in id order. */
export function spanTasks(span: Span): DerivedTask[] {
  return span.trees.flatMap(({ derived }) =>
    [...derived.values()]
      .filter((d) => inSpan(span, d))
      .sort((a, b) => compareIds(a.snapshot.task.id, b.snapshot.task.id)),
  );
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
 * rendering, then the footer (count, scope, projects, malformed manifests)
 * and a line for each listed project that could not be shown.
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
  writeOut(renderCollectionFooter(collection));
  for (const load of span.unavailable) {
    writeOut(ui.warn(unavailableText(load)));
  }
}
