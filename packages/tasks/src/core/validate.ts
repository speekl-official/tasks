import fs from "node:fs/promises";
import path from "node:path";

import type { CommandContext } from "../context.js";
import { hasRoster, isListed, listedActors } from "./actors.js";
import { resolvedRoots } from "./archive.js";
import type { DerivedTask } from "./derive.js";
import { errnoCode, isDirectory } from "./fs-utils.js";
import { GATE_FIELDS, UNSATISFIABLE_REASONS } from "./gates.js";
import {
  ancestorPaths,
  compareIds,
  isBelow,
  isTaskPath,
  safeParseReference,
} from "./ids.js";
import {
  indexExists,
  indexPath,
  isIndexStale,
  refreshIndex,
  writeIndex,
} from "./index-md.js";
import { withMutation } from "./mutate.js";
import type { LoadedTree, UnavailableTree } from "./projects.js";
import { livenessForTree, readSession } from "./sessions.js";
import { snapshotFromContext, snapshotTree } from "./snapshot.js";
import type { Task } from "./task.js";
import { hasState, isOpenTask, isResolvedTask } from "./task.js";
import { daysBefore } from "./time.js";
import type { Malformed, Tree } from "./tree.js";
import {
  ancestorsOf,
  archivedTaskDir,
  descendantsOf,
  isReservedPath,
  taskDir,
} from "./tree.js";
import type {
  FindingJson,
  FindingKind,
  FindingSeverity,
  GateField,
  ResolvedRef,
  ValidationJson,
} from "./types.js";
import {
  ARCHIVE_DIRNAME,
  FINDING_KINDS,
  INDEX_FILENAME,
  LOG_FILENAME,
  MOVING_MARKER_FILENAME,
} from "./types.js";
import { hasConflictMarkers } from "./workspace.js";

/**
 * Validation: every finding of the convention's validation table, at its
 * severity, over the local tree. Findings are reported, never repaired, with
 * one exception the caller opts into: `--fix` regenerates `index.md`, which
 * is derived. Every other finding needs a person's intent to resolve.
 *
 * Rules about the files of one task — the manifest parses, its claim fields
 * agree with its status, its references parse, its keys are defined, its log
 * has no conflict markers — cover every task directory under `.tasks/`,
 * archived ones included: a restore brings an archived task back exactly as
 * it is. Rules about the tree — gates, containment, workspace consistency,
 * liveness, interrupted moves — cover live tasks only, since archived ones
 * take part in no query and no gate. Listed projects are validated by their
 * own tree; here they are checked only for being available.
 */

export interface ValidationOptions {
  /** Regenerate `index.md` when it exists: the only repair there is. */
  fix?: boolean;
}

const SEVERITY: Record<FindingKind, FindingSeverity> = {
  malformed: "error",
  "unknown-status": "error",
  "unknown-priority": "error",
  "claim-fields": "error",
  "malformed-ref": "error",
  cycle: "error",
  "ancestor-dependency": "error",
  "resolved-with-open-descendant": "error",
  "backlog-invariant": "error",
  "archived-path-conflict": "error",
  "duplicate-id": "error",
  "log-conflict-markers": "error",
  "paused-without-state": "warning",
  "todo-with-state": "warning",
  "unsatisfiable-ref": "warning",
  "claim-liveness": "warning",
  "unknown-key": "warning",
  "unknown-actor": "warning",
  "project-unavailable": "warning",
  "duplicate-project": "warning",
  "resolved-unarchived": "warning",
  "index-stale": "warning",
};

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1 };

const KIND_RANK = new Map<FindingKind, number>(
  FINDING_KINDS.map((kind, index) => [kind, index]),
);

const VERBS: Record<GateField, string> = {
  depends_on: "depends on",
  finishes_after: "finishes after",
};

/** Ids listed in one message before the rest is counted instead. */
const LIST_LIMIT = 10;

/** Files read at once, so a wide tree cannot exhaust the descriptor limit. */
const IO_BATCH = 32;

/** Hints for the keys a v1 manifest carried, the likeliest unknown ones. */
const V1_KEY_HINTS = new Map<string, string>([
  ["id", "; v1 named a task by it, v2 names it by its path"],
  ["phase", "; v1 grouped tasks by it, v2 groups them by directory"],
]);

/* ------------------------------------------------------------------------ */
/* Entry points                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Every finding over the local tree, errors first and then warnings, each
 * kind in the order of `FINDING_KINDS` and by task within a kind. Nothing is
 * written unless `fix` is set, and then only `index.md`, only when it exists:
 * the findings are those of the tree as read before the fix, minus the stale
 * index the fix just regenerated.
 *
 * `checked` counts the manifests examined: live and archived, parsed or not.
 */
export async function validateTree(
  context: CommandContext,
  options: ValidationOptions = {},
): Promise<ValidationJson> {
  const load = context.projects.local;
  const tree = load.tree;

  let findings: FindingJson[] = [
    ...manifestFindings(tree),
    ...(await gateGraphFindings(context, load)),
    ...containmentFindings(tree),
    ...archivedPathFindings(tree),
    ...(await movingFindings(tree)),
    ...(await logFindings(tree)),
    ...workspaceFindings(tree),
    ...(await referenceFindings(context, load)),
    ...(await livenessFindings(tree)),
    ...actorFindings(tree),
    ...archiveFindings(tree),
    ...(await projectFindings(context)),
    ...(await indexFindings(context, load)),
  ];

  const fixed: string[] = [];
  if (options.fix === true && (await indexExists(tree))) {
    if (await regenerateIndex(context)) fixed.push(INDEX_FILENAME);
    // Current now, whether this run rewrote it or found it already rewritten
    // by the time it held the lock.
    findings = findings.filter((finding) => finding.kind !== "index-stale");
  }

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    checked:
      tree.tasks.length +
      tree.malformed.length +
      tree.archived.length +
      tree.archivedMalformed.length,
    fixed,
    findings: sortFindings(findings),
  };
}

/**
 * Write `index.md` from the tree as it is inside the lock, creating it when
 * it does not exist, and return its path. The generic refresh after a
 * mutation is off: it only ever rewrites an existing file, and creating the
 * file is the point of this command.
 */
export async function reindexTree(context: CommandContext): Promise<string> {
  return withMutation(
    context,
    context.projects.local,
    async (fresh) =>
      writeIndex(fresh.tree, await deriveForIndex(context, fresh.load)),
    { refreshIndex: false },
  );
}

/** `--fix`: rewrite an existing `index.md` when it differs; never create. */
async function regenerateIndex(context: CommandContext): Promise<boolean> {
  return withMutation(
    context,
    context.projects.local,
    async (fresh) =>
      refreshIndex(fresh.tree, await deriveForIndex(context, fresh.load)),
    { refreshIndex: false },
  );
}

/** The actor-independent derivation `index.md` is rendered from. */
async function deriveForIndex(
  context: CommandContext,
  load: LoadedTree,
): Promise<Map<string, DerivedTask>> {
  return (await snapshotTree(snapshotFromContext(context), load, null)).derived;
}

/* ------------------------------------------------------------------------ */
/* Manifests                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The rules about each manifest file, live and archived: it parses, its
 * claim fields agree with its status, its references parse, and every key in
 * it is one this revision defines.
 */
function manifestFindings(tree: Tree): FindingJson[] {
  const out: FindingJson[] = [];
  for (const entry of [...tree.malformed, ...tree.archivedMalformed]) {
    out.push(malformedFinding(tree, entry));
  }
  for (const task of [...tree.tasks, ...tree.archived]) {
    const where = archivedPrefix(tree, task);

    const claim = claimFieldsProblem(task);
    if (claim !== null) {
      out.push(finding("claim-fields", task.id, where + claim));
    }

    for (const field of GATE_FIELDS) {
      for (const ref of task.frontmatter[field]) {
        const parsed = safeParseReference(ref);
        if (parsed.ok) continue;
        out.push(
          finding(
            "malformed-ref",
            task.id,
            `${where}${field} entry ${JSON.stringify(ref)} is not a reference: ${parsed.message}`,
          ),
        );
      }
    }

    for (const [key] of task.extra) {
      out.push(
        finding(
          "unknown-key",
          task.id,
          `${where}frontmatter key ${JSON.stringify(key)} is not defined by .tasks v2; it is kept as it is on every write${V1_KEY_HINTS.get(key) ?? ""}`,
        ),
      );
    }
  }
  return out;
}

/**
 * The status and priority vocabularies are fixed, so a value outside them
 * is a finding of its own; any other defect leaves the manifest unreadable.
 */
function malformedKind(entry: Malformed): FindingKind {
  if (entry.issues.some((issue) => issue.field === "status")) {
    return "unknown-status";
  }
  if (entry.issues.some((issue) => issue.field === "priority")) {
    return "unknown-priority";
  }
  return "malformed";
}

/** A `task.md` placed directly in `.tasks/` has no id: a tree-level finding. */
function malformedFinding(tree: Tree, entry: Malformed): FindingJson {
  return finding(
    malformedKind(entry),
    entry.id === "" ? null : entry.id,
    `${shown(tree, entry.path)}: ${entry.message}`,
  );
}

const CLAIMANT_FIELDS = ["claimed_by", "claimed_at"] as const;
const CLAIM_FIELDS = [...CLAIMANT_FIELDS, "claimed_session"] as const;

/**
 * `IN_PROGRESS` records who claimed the task and when; every other status
 * records no claim at all. The session may be null while claimed.
 */
function claimFieldsProblem(task: Task): string | null {
  const fm = task.frontmatter;
  if (fm.status === "IN_PROGRESS") {
    const unset = CLAIMANT_FIELDS.filter((field) => fm[field] === null);
    if (unset.length === 0) return null;
    const verb = unset.length === 1 ? "is" : "are";
    return `IN_PROGRESS, but ${unset.join(" and ")} ${verb} null: a claimed task records who claimed it and when`;
  }
  const set = CLAIM_FIELDS.filter((field) => fm[field] !== null);
  if (set.length === 0) return null;
  const values = set.map((field) => `${field} is ${fm[field]}`).join(", ");
  return `${fm.status}, but ${values}: claim fields are set only while a task is IN_PROGRESS`;
}

/* ------------------------------------------------------------------------ */
/* The gate graph                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Cycles of the combined gate graph, and dependencies on an ancestor. Such a
 * dependency closes a cycle with the finish edges down the containment
 * chain; that cycle is reported once, under the ancestor dependency's name,
 * and every cycle it does not explain is reported as a cycle.
 */
async function gateGraphFindings(
  context: CommandContext,
  load: LoadedTree,
): Promise<FindingJson[]> {
  const ancestry = context.gates.ancestorDependencies(load);
  const explained = new Set<string>();
  for (const { id, ref } of ancestry) {
    const parsed = safeParseReference(ref);
    if (parsed.ok && parsed.ref.kind === "local") {
      explained.add(edgeKey(id, parsed.ref.path));
    }
  }

  const out: FindingJson[] = [];
  for (const cycle of await context.gates.findCycles(load)) {
    if (explainedByAncestry(cycle, explained)) continue;
    // Cycles are rooted in the local tree, so the first id is a local one.
    out.push(finding("cycle", cycle[0] ?? null, cycleText(cycle)));
  }
  for (const { id, field, ref } of ancestry) {
    out.push(
      finding(
        "ancestor-dependency",
        id,
        `${VERBS[field]} its own ancestor ${ref}, which is done only after it, so neither can ever finish`,
      ),
    );
  }
  return out;
}

function edgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

/**
 * True when the cycle runs along one containment chain of the local tree
 * and every step up that chain is a reported ancestor dependency. A step
 * down is a finish edge to a child or a reference to a descendant, which
 * alone can never close a cycle, so removing the reported dependencies
 * removes the cycle: it says nothing they do not.
 */
function explainedByAncestry(
  cycle: readonly string[],
  explained: ReadonlySet<string>,
): boolean {
  // A qualified id belongs to another tree, which shares no chain with this one.
  if (cycle.length < 2 || cycle.some((id) => id.includes(":"))) return false;
  let upward = 0;
  for (let index = 0; index < cycle.length; index += 1) {
    const from = cycle[index]!;
    const to = cycle[(index + 1) % cycle.length]!;
    if (isBelow(from, to)) {
      if (!explained.has(edgeKey(from, to))) return false;
      upward += 1;
    } else if (!isBelow(to, from)) {
      return false;
    }
  }
  return upward > 0;
}

function cycleText(cycle: readonly string[]): string {
  if (cycle.length === 1) {
    return "waits for itself, so it can never be done";
  }
  const chain = [...cycle, cycle[0]].join(" → ");
  return `is in a gate cycle, ${chain}: each task waits for the next, so none of them can ever be done`;
}

/* ------------------------------------------------------------------------ */
/* Containment                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The two invariants of containment: a resolved task has no live open
 * descendant, and every open descendant of a `BACKLOG` task is `BACKLOG`. A
 * malformed descendant of a resolved task counts as open, since its status
 * cannot be known; under a `BACKLOG` task it is left to its own finding.
 */
function containmentFindings(tree: Tree): FindingJson[] {
  const openBelow = openDescendantsOfResolved(tree);
  const out: FindingJson[] = [];
  for (const task of tree.tasks) {
    const status = task.frontmatter.status;
    const open = openBelow.get(task.id);
    if (open !== undefined) {
      const labels = open
        .sort((a, b) => compareIds(a.id, b.id))
        .map((entry) => entry.label);
      out.push(
        finding(
          "resolved-with-open-descendant",
          task.id,
          `is ${status}, but live open descendants remain: ${listed(labels)}; the subtree of a resolved task must be resolved too`,
        ),
      );
    }
    if (!isOpenTask(task) || status === "BACKLOG") continue;
    const backlog = ancestorsOf(tree, task.id).filter(
      (ancestor) => ancestor.frontmatter.status === "BACKLOG",
    );
    if (backlog.length === 0) continue;
    const nearest = backlog[0]!.id;
    const outermost = backlog[backlog.length - 1]!.id;
    out.push(
      finding(
        "backlog-invariant",
        task.id,
        `is ${status} under the BACKLOG task ${nearest}: every open descendant of a BACKLOG task must be BACKLOG; schedule ${outermost}, or defer this task`,
      ),
    );
  }
  return out;
}

/**
 * Resolved task id → the live open (or malformed) tasks beneath it. One walk
 * up from each open task costs the depth of the tree; a walk down from each
 * resolved task would cost the whole tree, and most of a mature tree is
 * resolved.
 */
function openDescendantsOfResolved(
  tree: Tree,
): Map<string, Array<{ id: string; label: string }>> {
  const below = new Map<string, Array<{ id: string; label: string }>>();
  const note = (id: string, label: string): void => {
    for (const above of ancestorPaths(id)) {
      const ancestor = tree.byId.get(above);
      if (ancestor === undefined || !isResolvedTask(ancestor)) continue;
      const list = below.get(above);
      if (list === undefined) below.set(above, [{ id, label }]);
      else list.push({ id, label });
    }
  };
  for (const task of tree.tasks) {
    if (isOpenTask(task)) {
      note(task.id, `${task.id} (${task.frontmatter.status})`);
    }
  }
  for (const entry of tree.malformed) {
    if (entry.id === "") continue;
    note(
      entry.id,
      `${entry.id} (malformed task.md: its status is unknown, so it counts as open)`,
    );
  }
  return below;
}

/** An archived task's path stays reserved until the entry is purged. */
function archivedPathFindings(tree: Tree): FindingJson[] {
  return liveDirectories(tree)
    .filter((entry) => entry.task && isReservedPath(tree, entry.id))
    .map((entry) =>
      finding(
        "archived-path-conflict",
        entry.id,
        `${shown(tree, entry.dir)} is a live task, but ${shown(tree, archivedTaskDir(tree, entry.id))} holds an archived task at the same path, which stays reserved until it is purged`,
      ),
    );
}

/* ------------------------------------------------------------------------ */
/* Interrupted moves                                                        */
/* ------------------------------------------------------------------------ */

interface LiveDirectory {
  id: string;
  dir: string;
  /** A task, parsed or not; otherwise a group. */
  task: boolean;
}

/** Every live directory the scan entered: tasks first, then groups. */
function liveDirectories(tree: Tree): LiveDirectory[] {
  return [
    ...tree.tasks.map((task) => ({ id: task.id, dir: task.dir, task: true })),
    ...tree.malformed
      .filter((entry) => entry.id !== "")
      .map((entry) => ({ id: entry.id, dir: entry.dir, task: true })),
    ...[...tree.groups].map((group) => ({
      id: group,
      dir: taskDir(tree, group),
      task: false,
    })),
  ];
}

interface MarkerSource {
  archived: boolean;
  id: string;
}

/** The source a marker's first line names, or `null` when it names none. */
function markerSource(line: string): MarkerSource | null {
  const prefix = `${ARCHIVE_DIRNAME}/`;
  const archived = line.startsWith(prefix);
  const id = archived ? line.slice(prefix.length) : line;
  return isTaskPath(id) ? { archived, id } : null;
}

/**
 * The same task twice: a copy across filesystems that was interrupted before
 * it removed its source. The filesystem keeps every path unique, so the
 * marker the copy leaves in its destination is the only evidence there is,
 * and validation reports it rather than choosing a copy. A marker whose
 * source is gone is reported too: the copy finished and lost its marker, or
 * was cut short and its source removed by hand; either needs a look.
 */
async function movingFindings(tree: Tree): Promise<FindingJson[]> {
  const marked = await mapBatched(liveDirectories(tree), async (entry) => ({
    entry,
    content: await readRegularFile(
      path.join(entry.dir, MOVING_MARKER_FILENAME),
    ),
  }));

  const out: FindingJson[] = [];
  for (const { entry, content } of marked) {
    if (content === null) continue;
    // A group holds no task of its own: the finding is about the tree.
    const subject = entry.task ? entry.id : null;
    const marker = shown(tree, path.join(entry.dir, MOVING_MARKER_FILENAME));
    const destination = `${entry.id} (${shown(tree, entry.dir)})`;
    const line = (content.split("\n")[0] ?? "").trim();
    const source = markerSource(line);
    if (source === null || (!source.archived && source.id === entry.id)) {
      out.push(
        finding(
          "duplicate-id",
          subject,
          `${marker} does not name the source of a move (${JSON.stringify(line)}); an interrupted move may have left ${destination} incomplete: check it, then delete the marker`,
        ),
      );
      continue;
    }

    const sourceDir = source.archived
      ? archivedTaskDir(tree, source.id)
      : taskDir(tree, source.id);
    const from = `${source.archived ? "archived " : ""}${source.id} (${shown(tree, sourceDir)})`;
    out.push(
      finding(
        "duplicate-id",
        subject,
        (await isDirectory(sourceDir))
          ? `an interrupted move left the same task twice, at ${from} and at ${destination}, as ${marker} records: keep one copy, then delete the marker`
          : `${marker} records a move from ${from}, which no longer exists: the move finished without removing its marker, or stopped before copying everything; check ${destination}, then delete the marker`,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Workspace files                                                          */
/* ------------------------------------------------------------------------ */

/** A log with conflict markers, live or archived, parsed or not. */
async function logFindings(tree: Tree): Promise<FindingJson[]> {
  const holders = [
    ...[...tree.tasks, ...tree.archived]
      .filter((task) => task.workspace.log)
      .map((task) => ({ id: task.id, dir: task.dir, archived: task.archived })),
    // A malformed manifest says nothing about the files beside it.
    ...[...tree.malformed, ...tree.archivedMalformed]
      .filter((entry) => entry.id !== "")
      .map((entry) => ({
        id: entry.id,
        dir: entry.dir,
        archived: entry.archived,
      })),
  ];

  const logs = await mapBatched(holders, async (holder) => ({
    holder,
    source: await readRegularFile(path.join(holder.dir, LOG_FILENAME)),
  }));

  const out: FindingJson[] = [];
  for (const { holder, source } of logs) {
    if (source === null || !hasConflictMarkers(source)) continue;
    const line =
      source.split("\n").findIndex((text) => hasConflictMarkers(text)) + 1;
    out.push(
      finding(
        "log-conflict-markers",
        holder.id,
        `${archivedPrefix(tree, holder)}log.md has version-control conflict markers (the first at line ${line}): resolve them by keeping both entries, in time order`,
      ),
    );
  }
  return out;
}

/** `state.md` against the status: a paused task has one, a todo task none. */
function workspaceFindings(tree: Tree): FindingJson[] {
  const out: FindingJson[] = [];
  for (const task of tree.tasks) {
    const status = task.frontmatter.status;
    if (status === "PAUSED" && !hasState(task)) {
      out.push(
        finding(
          "paused-without-state",
          task.id,
          `is PAUSED without a state.md, the resume point a paused task keeps; write one with \`tasks state ${task.id}\``,
        ),
      );
    } else if (status === "TODO" && hasState(task)) {
      out.push(
        finding(
          "todo-with-state",
          task.id,
          "is TODO, but a state.md exists: a task with a resume point has started, and started work is PAUSED, not TODO",
        ),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* References                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Gate references that waiting cannot satisfy. Only an open task waits at a
 * gate: a dead reference in a resolved one blocks nothing, and cancelling a
 * stranded dependent is one of the remedies the warning asks a person for.
 */
async function referenceFindings(
  context: CommandContext,
  load: LoadedTree,
): Promise<FindingJson[]> {
  const out: FindingJson[] = [];
  for (const site of await context.gates.referenceSites([load])) {
    const holder = load.tree.byId.get(site.task);
    if (holder === undefined || !isOpenTask(holder)) continue;
    // One that does not parse is the malformed-ref error already.
    if (!safeParseReference(site.ref).ok) continue;
    const reason = site.resolved.reason;
    if (reason === null || !UNSATISFIABLE_REASONS.includes(reason)) continue;
    // A cancelled target satisfies a finish gate: the scope was redefined.
    if (reason === "cancelled" && site.field === "finishes_after") continue;
    out.push(
      finding(
        "unsatisfiable-ref",
        site.task,
        `${VERBS[site.field]} ${site.ref}, ${unsatisfiableText(site.resolved)} (${reason})`,
      ),
    );
  }
  return out;
}

function unsatisfiableText(ref: ResolvedRef): string {
  switch (ref.reason) {
    case "cancelled":
      return "which is CANCELLED, and cancelled work never satisfies a dependency";
    case "missing":
      return "but no task exists at that path";
    case "archived":
      return "which is archived, and an archived task satisfies no gate";
    case "unresolved-project":
      return `but ${ref.project} does not lead to a .tasks tree`;
    case "not-checked-out":
      return `but project ${ref.project} is not checked out here`;
    case "unsupported-version":
      return `but project ${ref.project} is a v1 tree or one of a version this implementation does not support`;
    default:
      return "which can never satisfy it";
  }
}

/* ------------------------------------------------------------------------ */
/* Claims                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Claims that protect nothing, or whose liveness cannot be told. A claim
 * without a session is a person at a terminal, the normal case, and no
 * finding.
 */
async function livenessFindings(tree: Tree): Promise<FindingJson[]> {
  const liveness = await livenessForTree(tree);
  const out: FindingJson[] = [];
  for (const task of tree.tasks) {
    const session = task.frontmatter.claimed_session;
    const claim = liveness.get(task.id);
    if (claim === undefined || session === null) continue;
    const who = `claimed by ${task.frontmatter.claimed_by ?? "nobody"} in session ${session}`;
    if (claim.liveness === "orphaned") {
      const record = await readSession(tree.project.tasksDir, session);
      const seen = record.ended
        ? `which ended at ${claim.last_seen}`
        : `last seen ${claim.last_seen}, longer ago than the ${tree.config.sessionTimeoutMinutes}-minute timeout`;
      out.push(
        finding(
          "claim-liveness",
          task.id,
          `${who}, ${seen}: the claim is orphaned and may be taken over`,
        ),
      );
    } else if (claim.liveness === "unknown") {
      out.push(
        finding(
          "claim-liveness",
          task.id,
          `${who}, which has no heartbeat file in this tree (another machine, or a cleaned .locks/): its liveness is unknown, so only a force can take it over`,
        ),
      );
    }
  }
  return out;
}

/**
 * An open task whose assignee or claimant the roster does not list: the
 * name is misspelt or the roster is behind, and either way the task is in
 * nobody's `mine`. Resolved tasks keep their names as history and are not
 * judged; without a roster there is nothing to judge against.
 */
function actorFindings(tree: Tree): FindingJson[] {
  if (!hasRoster(tree.config)) return [];
  const out: FindingJson[] = [];
  const listed = listedActors(tree.config).join(", ");
  for (const task of tree.tasks) {
    if (!isOpenTask(task)) continue;
    const { assignee, claimed_by: claimant } = task.frontmatter;
    if (assignee !== null && !isListed(tree.config, assignee)) {
      out.push(
        finding(
          "unknown-actor",
          task.id,
          `is assigned to ${assignee}, who is not listed under actors: in config.yml (${listed}); \`tasks assign\` a listed actor, or add the name there`,
        ),
      );
    }
    if (claimant !== null && !isListed(tree.config, claimant)) {
      out.push(
        finding(
          "unknown-actor",
          task.id,
          `is claimed by ${claimant}, who is not listed under actors: in config.yml (${listed}); add the name there, or have the claim released and taken again by a listed actor`,
        ),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Projects and index.md                                                    */
/* ------------------------------------------------------------------------ */

/** Every listed project that did not load, in configuration order. */
async function projectFindings(
  context: CommandContext,
): Promise<FindingJson[]> {
  const out: FindingJson[] = [];
  // Two aliases can lead to one directory; the tree then loads once and is
  // listed twice, so every overview and aggregate counts it twice.
  const aliasesByTree = new Map<string, string[]>();
  const names = context.projects.aliases();
  const loads = await context.projects.listed();
  loads.forEach((load, index) => {
    if (load.kind !== "ok") {
      out.push(finding("project-unavailable", null, unavailableText(load)));
      return;
    }
    // `listed()` is aligned with `aliases()`; the load itself carries only
    // the first alias of a tree listed twice.
    const aliases = aliasesByTree.get(load.key) ?? [];
    aliases.push(names[index] ?? load.alias ?? load.key);
    aliasesByTree.set(load.key, aliases);
  });
  for (const [key, aliases] of aliasesByTree) {
    if (aliases.length < 2) continue;
    out.push(
      finding(
        "duplicate-project",
        null,
        `projects ${aliases.join(" and ")} lead to the same tree (${key}), which is listed once under each alias; drop one`,
      ),
    );
  }
  return out;
}

function unavailableText(load: UnavailableTree): string {
  const name = `project ${load.alias ?? load.relPath} (${load.relPath})`;
  switch (load.kind) {
    case "not-checked-out":
      return `${name} is not checked out: ${load.dir} does not exist, so references into it are unsatisfied (not-checked-out)`;
    case "unresolved":
      return load.cause === null
        ? `${name} does not lead to a .tasks tree: none is found from ${load.dir}, so references into it are unsatisfied (unresolved-project)`
        : `${name} cannot be read (${load.cause.message.replace(/\.$/, "")}), so references into it are unsatisfied (unresolved-project)`;
    case "unsupported-version":
      return load.version === 1
        ? `${name} is a .tasks v1 tree, so references into it are unsatisfied (unsupported-version); \`tasks migrate ${load.alias ?? load.relPath}\` upgrades it from here`
        : `${name} declares version ${load.version}, which this implementation does not support, so references into it are unsatisfied (unsupported-version)`;
  }
}

/**
 * Resolved subtrees older than `archive_resolved_after_days`, when the
 * configuration sets it: the hint to run `tasks archive --resolved-before`,
 * never an action of validation itself.
 */
function archiveFindings(tree: Tree): FindingJson[] {
  const days = tree.config.archiveResolvedAfterDays;
  if (days === null) return [];
  const roots = resolvedRoots(tree, daysBefore(days));
  if (roots.length === 0) return [];
  const count = roots.reduce(
    (sum, root) => sum + 1 + descendantsOf(tree, root.id).length,
    0,
  );
  return [
    finding(
      "resolved-unarchived",
      null,
      `${count} resolved ${count === 1 ? "task is" : "tasks are"} older than ${days} days and not archived (${listed(roots.map((root) => root.id))}); \`tasks archive --resolved-before\` archives them`,
    ),
  ];
}

/** A missing `index.md` is no finding: the file is optional. */
async function indexFindings(
  context: CommandContext,
  load: LoadedTree,
): Promise<FindingJson[]> {
  if (!(await indexExists(load.tree))) return [];
  const derived = await deriveForIndex(context, load);
  if (!(await isIndexStale(load.tree, derived))) return [];
  return [
    finding(
      "index-stale",
      null,
      `${shown(load.tree, indexPath(load.tree))} is out of date; \`tasks reindex\` or \`tasks validate --fix\` regenerates it`,
    ),
  ];
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function finding(
  kind: FindingKind,
  task: string | null,
  message: string,
): FindingJson {
  return { severity: SEVERITY[kind], kind, task, message };
}

function sortFindings(findings: FindingJson[]): FindingJson[] {
  // Array sort is stable: within one task, findings keep the order the
  // checks produced them in (fields, then stored order).
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      KIND_RANK.get(a.kind)! - KIND_RANK.get(b.kind)! ||
      compareSubjects(a.task, b.task),
  );
}

/** Tree-level findings first, then by id in tree order. */
function compareSubjects(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareIds(a, b);
}

/** A path as messages show it: relative to the project root, posix-style. */
function shown(tree: Tree, target: string): string {
  return path.relative(tree.project.root, target).split(path.sep).join("/");
}

/** Archived tasks share ids with live ones; their messages say where. */
function archivedPrefix(
  tree: Tree,
  task: { archived: boolean; dir: string },
): string {
  return task.archived ? `archived at ${shown(tree, task.dir)}: ` : "";
}

function listed(labels: readonly string[]): string {
  if (labels.length <= LIST_LIMIT) return labels.join(", ");
  const rest = labels.length - LIST_LIMIT;
  return `${labels.slice(0, LIST_LIMIT).join(", ")} and ${rest} more`;
}

/** A regular file's contents, or `null` when there is none at `file`. */
async function readRegularFile(file: string): Promise<string | null> {
  try {
    if (!(await fs.stat(file)).isFile()) return null;
    return await fs.readFile(file, "utf8");
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return null;
    }
    throw err;
  }
}

async function mapBatched<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += IO_BATCH) {
    out.push(
      ...(await Promise.all(items.slice(start, start + IO_BATCH).map(fn))),
    );
  }
  return out;
}
