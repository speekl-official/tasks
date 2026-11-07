import { ancestorPaths, compareIds, isWithin, qualifyId } from "./ids.js";
import type { Task } from "./task.js";
import { toTaskJson } from "./task.js";
import type { Tree } from "./tree.js";
import { ancestorIdsOf } from "./tree.js";
import type {
  BlockedByJson,
  ChildrenProgress,
  ClaimLiveness,
  Derived,
  FinishGate,
  LastEntryJson,
  Priority,
  ResolvedRef,
  Situation,
  StartGate,
  Status,
  TaskWithDerivedJson,
} from "./types.js";
import { PRIORITY_RANK, higherPriority, isOpen, isResolved } from "./types.js";

/**
 * Derived conditions are computed on every query and never stored. This
 * module is the one place that computes them: pure functions over a snapshot
 * of one tree whose gates and liveness the caller has already resolved, so
 * nothing here touches the disk and every command derives alike.
 */

/* ------------------------------------------------------------------------ */
/* Snapshot                                                                 */
/* ------------------------------------------------------------------------ */

export interface SnapshotTask {
  task: Task;
  /** The alias of the task's tree, or null for the local tree. */
  project: string | null;
  start: StartGate;
  finish: FinishGate;
  /** IN_PROGRESS tasks only; null otherwise. */
  liveness: ClaimLiveness | null;
  lastEntry: LastEntryJson | null;
}

export interface TreeSnapshot {
  tree: Tree;
  project: string | null;
  /** Every live parsed task of the tree. */
  tasks: SnapshotTask[];
}

export interface DerivedTask {
  snapshot: SnapshotTask;
  derived: Derived;
  /** toTaskJson(task, project) merged with derived. */
  json: TaskWithDerivedJson;
}

/* ------------------------------------------------------------------------ */
/* Structure                                                                */
/* ------------------------------------------------------------------------ */

/** What the containment rules need about the whole tree, computed once. */
interface Structure {
  /** Parsed live tasks; the snapshot's copies win over the tree's. */
  byId: Map<string, Task>;
  /** Parsed live children by parent id. */
  children: Map<string, Task[]>;
  /** Malformed live children by parent id: children of unknown status. */
  malformedChildren: Map<string, number>;
  /** Ids with an IN_PROGRESS task strictly beneath them. */
  activeBelow: Set<string>;
  /** Ids with a state.md strictly beneath them. */
  startedBelow: Set<string>;
}

function buildStructure(snapshot: TreeSnapshot): Structure {
  const byId = new Map(snapshot.tree.byId);
  for (const entry of snapshot.tasks) byId.set(entry.task.id, entry.task);

  const structure: Structure = {
    byId,
    children: new Map(),
    malformedChildren: new Map(),
    activeBelow: new Set(),
    startedBelow: new Set(),
  };

  for (const task of byId.values()) {
    if (task.parent !== null) {
      const siblings = structure.children.get(task.parent);
      if (siblings) siblings.push(task);
      else structure.children.set(task.parent, [task]);
    }
    // Every prefix path is marked, groups included: lookups are by task id,
    // so a marked group is never read, and skipping them would cost a check.
    if (task.frontmatter.status === "IN_PROGRESS") {
      for (const above of ancestorPaths(task.id)) {
        structure.activeBelow.add(above);
      }
    }
    if (task.workspace.state) {
      for (const above of ancestorPaths(task.id)) {
        structure.startedBelow.add(above);
      }
    }
  }

  for (const entry of snapshot.tree.malformed) {
    if (entry.id === "" || entry.parent === null) continue;
    const count = structure.malformedChildren.get(entry.parent) ?? 0;
    structure.malformedChildren.set(entry.parent, count + 1);
  }

  return structure;
}

/** What a task's ancestors decide for it. */
interface Lineage {
  /** Parsed ancestors, nearest first. */
  ancestors: Task[];
  /** The nearest ancestor that holds the subtree, unqualified. */
  holder: string | null;
  backlog: boolean;
  resolved: boolean;
  malformed: boolean;
}

/** A claimed or assigned task holds its subtree (see Hold in the spec). */
export function holdsSubtree(task: Task): boolean {
  const fm = task.frontmatter;
  // Either claim signal counts, so inconsistent claim fields still hold.
  return (
    fm.status === "IN_PROGRESS" ||
    fm.claimed_by !== null ||
    fm.assignee !== null
  );
}

function lineageOf(tree: Tree, structure: Structure, id: string): Lineage {
  const lineage: Lineage = {
    ancestors: [],
    holder: null,
    backlog: false,
    resolved: false,
    malformed: false,
  };
  for (const ancestorId of ancestorIdsOf(tree, id)) {
    const ancestor = structure.byId.get(ancestorId);
    if (ancestor === undefined) {
      // A malformed ancestor may be claimed or assigned for all anyone can
      // tell; fail safe and let it hold the subtree.
      lineage.malformed = true;
      lineage.holder ??= ancestorId;
      continue;
    }
    lineage.ancestors.push(ancestor);
    const status = ancestor.frontmatter.status;
    if (status === "BACKLOG") lineage.backlog = true;
    if (isResolved(status)) lineage.resolved = true;
    if (lineage.holder === null && holdsSubtree(ancestor)) {
      lineage.holder = ancestorId;
    }
  }
  return lineage;
}

/* ------------------------------------------------------------------------ */
/* Situation                                                                */
/* ------------------------------------------------------------------------ */

/** The facts the situation table reads. */
export interface SituationFacts {
  status: Status;
  started: boolean;
  heldBy: string | null;
  assignee: string | null;
  blocked: boolean;
  closable: boolean;
  openChildren: number;
}

/**
 * The situation table of the spec as an ordered list of predicates: the
 * first row that holds is the situation, so the precedence reads top to
 * bottom here and nowhere else. The last row holds unconditionally. In a
 * valid tree an open task reaches it exactly when it is free and unblocked;
 * only a tree that breaks the BACKLOG or resolved-parent invariant can bring
 * an open task under such an ancestor here while its `ready` stays false.
 */
export const SITUATION_TABLE: ReadonlyArray<
  readonly [Situation, (facts: SituationFacts) => boolean]
> = [
  ["done", (f) => f.status === "DONE"],
  ["cancelled", (f) => f.status === "CANCELLED"],
  // Status alone decides, even when the claim fields disagree with it.
  ["working", (f) => f.status === "IN_PROGRESS"],
  ["parked", (f) => f.status === "BACKLOG" && f.started],
  ["backlog", (f) => f.status === "BACKLOG"],
  ["held", (f) => f.heldBy !== null],
  ["waiting", (f) => f.status === "PAUSED" && f.assignee !== null],
  ["assigned", (f) => f.assignee !== null],
  ["blocked", (f) => f.blocked],
  ["closable", (f) => f.closable],
  ["open", (f) => f.openChildren > 0],
  ["ready", () => true],
];

export function situationOf(facts: SituationFacts): Situation {
  for (const [situation, holds] of SITUATION_TABLE) {
    if (holds(facts)) return situation;
  }
  return "ready";
}

/* ------------------------------------------------------------------------ */
/* Deriving                                                                 */
/* ------------------------------------------------------------------------ */

/** A claim whose liveness nobody resolved protects itself, as unknown does. */
const UNKNOWN_CLAIM: ClaimLiveness = { liveness: "unknown", last_seen: null };

export function effectivePriority(task: Task, ancestors: Task[]): Priority {
  return ancestors.reduce(
    (level, ancestor) => higherPriority(level, ancestor.frontmatter.priority),
    task.frontmatter.priority,
  );
}

function blockedByOf(start: StartGate): BlockedByJson[] {
  return start.refs
    .filter((ref) => !ref.satisfied)
    .map((ref) => ({
      ref: ref.ref,
      // An unsatisfied reference always has a reason; `missing` is the
      // spec's recommendation for one that cannot be read at all.
      reason: ref.reason ?? "missing",
      status: ref.status,
    }));
}

function deriveTask(
  entry: SnapshotTask,
  tree: Tree,
  structure: Structure,
  actor: string | null,
): Derived {
  const { task } = entry;
  const fm = task.frontmatter;
  const open = isOpen(fm.status);
  const lineage = lineageOf(tree, structure, task.id);

  const parsedChildren = structure.children.get(task.id) ?? [];
  const resolvedChildren = parsedChildren.filter((child) =>
    isResolved(child.frontmatter.status),
  ).length;
  const children: ChildrenProgress = {
    // A malformed child is a live child of unknown status: counted open, so
    // progress never claims more than is known and the parent stays open.
    open:
      parsedChildren.length -
      resolvedChildren +
      (structure.malformedChildren.get(task.id) ?? 0),
    resolved: resolvedChildren,
  };

  // Blocked, held and closable are conditions of open tasks only.
  const blocked_by = open ? blockedByOf(entry.start) : [];
  const held_by =
    open && lineage.holder !== null
      ? qualifyId(entry.project, lineage.holder)
      : null;
  const noOpenChild =
    children.open === 0 && entry.finish.open_children.length === 0;
  const closable =
    open &&
    (children.open + children.resolved > 0 || fm.finishes_after.length > 0) &&
    entry.finish.satisfied &&
    noOpenChild;

  const ready =
    (fm.status === "TODO" || fm.status === "PAUSED") &&
    entry.start.satisfied &&
    blocked_by.length === 0 &&
    (fm.assignee === null || fm.assignee === actor) &&
    noOpenChild &&
    held_by === null &&
    // A BACKLOG or resolved ancestor means a broken invariant, under which
    // claim refuses; a malformed one is unknown. None is offered as work.
    !lineage.backlog &&
    !lineage.resolved &&
    !lineage.malformed;

  const started = task.workspace.state || structure.startedBelow.has(task.id);
  const claim =
    fm.status === "IN_PROGRESS" ? (entry.liveness ?? UNKNOWN_CLAIM) : null;

  return {
    situation: situationOf({
      status: fm.status,
      started,
      heldBy: held_by,
      assignee: fm.assignee,
      blocked: blocked_by.length > 0,
      closable,
      openChildren: children.open,
    }),
    blocked_by,
    ready,
    effective_priority: effectivePriority(task, lineage.ancestors),
    held_by,
    started,
    children,
    active: structure.activeBelow.has(task.id),
    waiting_for: fm.status === "PAUSED" ? fm.assignee : null,
    closable,
    liveness: claim?.liveness ?? null,
    last_seen:
      claim !== null && fm.claimed_session !== null ? claim.last_seen : null,
    last_entry: entry.lastEntry,
  };
}

/**
 * Derive every task of one tree for the calling actor. A null actor (as for
 * `index.md`) requires no assignee: only unassigned tasks can be ready. The
 * map is keyed by the task's id within its tree, unqualified.
 */
export function deriveTree(
  snapshot: TreeSnapshot,
  actor: string | null,
): Map<string, DerivedTask> {
  const structure = buildStructure(snapshot);
  const out = new Map<string, DerivedTask>();
  for (const entry of snapshot.tasks) {
    const derived = deriveTask(entry, snapshot.tree, structure, actor);
    out.set(entry.task.id, {
      snapshot: entry,
      derived,
      json: { ...toTaskJson(entry.task, entry.project), ...derived },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Ready order and scope                                                    */
/* ------------------------------------------------------------------------ */

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Local first, then aliases in the given order, then any other by name. */
function compareProjects(
  a: string | null,
  b: string | null,
  aliasOrder: readonly string[],
): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const left = aliasOrder.indexOf(a);
  const right = aliasOrder.indexOf(b);
  if (left === -1 && right === -1) return compareText(a, b);
  if (left === -1) return 1;
  if (right === -1) return -1;
  return left - right;
}

/**
 * The ready order: effective priority (urgent first), then PAUSED before
 * TODO (finishing beats starting), then created ascending, then project
 * (local first, then aliases in the order given), then id. Canonical
 * timestamps compare correctly as text.
 */
export function readyComparator(
  a: DerivedTask,
  b: DerivedTask,
  aliasOrder: string[] = [],
): number {
  const left = a.snapshot.task;
  const right = b.snapshot.task;
  const paused = (task: Task) => (task.frontmatter.status === "PAUSED" ? 0 : 1);
  return (
    PRIORITY_RANK[a.derived.effective_priority] -
      PRIORITY_RANK[b.derived.effective_priority] ||
    paused(left) - paused(right) ||
    compareText(left.frontmatter.created, right.frontmatter.created) ||
    compareProjects(a.snapshot.project, b.snapshot.project, aliasOrder) ||
    compareIds(left.id, right.id)
  );
}

export function inScope(id: string, scope: string | null): boolean {
  return scope === null || isWithin(id, scope);
}

/**
 * Tasks with `derived.ready`, within scope (the scope itself or beneath it;
 * null = all), in ready order. A scope is a path of the local tree and
 * applies to the local tree only, so tasks of listed projects pass it; a
 * caller that wants the local tree alone filters them out first.
 */
export function readySet(
  derived: Iterable<DerivedTask>,
  options: { scope: string | null; aliasOrder?: string[] },
): DerivedTask[] {
  return [...derived]
    .filter(
      (d) =>
        d.derived.ready &&
        (d.snapshot.project !== null ||
          inScope(d.snapshot.task.id, options.scope)),
    )
    .sort((a, b) => readyComparator(a, b, options.aliasOrder));
}

/* ------------------------------------------------------------------------ */
/* Filters                                                                  */
/* ------------------------------------------------------------------------ */

export type SituationFilterName = Situation | "resolved";

/**
 * The `list --<situation>` filters: each situation word selects its own
 * situation (`open` is the word for a parent with open children, not "every
 * open task"), and `resolved` selects done and cancelled tasks together.
 */
export function situationFilter(
  name: SituationFilterName,
): (d: DerivedTask) => boolean {
  if (name === "resolved") {
    return (d) => isResolved(d.snapshot.task.frontmatter.status);
  }
  return (d) => d.derived.situation === name;
}

/** The default of `list` and `tree`: every task whose status is open. */
export function hasOpenStatus(d: DerivedTask): boolean {
  return isOpen(d.snapshot.task.frontmatter.status);
}

/* ------------------------------------------------------------------------ */
/* Words                                                                    */
/* ------------------------------------------------------------------------ */

/** Resolved children out of live children, as `open N/M` shows them. */
export function progressText(children: ChildrenProgress): string {
  return `${children.resolved}/${children.open + children.resolved}`;
}

/**
 * A reference as an overview shows it, qualified like the ids around it: a
 * target in a project carries that project; one in the task's own tree
 * carries the task's alias when that tree is foreign.
 */
export function referenceText(
  ref: ResolvedRef | null,
  raw: string,
  taskProject: string | null,
): string {
  if (ref !== null && ref.project !== null) {
    return qualifyId(ref.project, ref.id);
  }
  return taskProject !== null && !raw.includes(":")
    ? qualifyId(taskProject, raw)
    : raw;
}

/** `blocked by A, B (cancelled)`: the reason only where waiting cannot help. */
function blockedText(d: DerivedTask): string {
  const byRef = new Map(d.snapshot.start.refs.map((ref) => [ref.ref, ref]));
  const parts = d.derived.blocked_by.map((blocked) => {
    const shown = referenceText(
      byRef.get(blocked.ref) ?? null,
      blocked.ref,
      d.snapshot.project,
    );
    return blocked.reason === "not-done"
      ? shown
      : `${shown} (${blocked.reason})`;
  });
  return `blocked by ${parts.join(", ")}`;
}

/** The situation as an overview prints it, with its object. */
export function situationText(d: DerivedTask): string {
  const { derived } = d;
  switch (derived.situation) {
    case "working": {
      const by = d.snapshot.task.frontmatter.claimed_by;
      return by === null ? "working" : `working by ${by}`;
    }
    case "held":
      return `held by ${derived.held_by}`;
    case "waiting":
      return `waiting for ${derived.waiting_for}`;
    case "assigned":
      return `assigned ${d.snapshot.task.frontmatter.assignee}`;
    case "blocked":
      return blockedText(d);
    case "open":
      return `open ${progressText(derived.children)}`;
    default:
      return derived.situation;
  }
}

/** The effective priority when not normal; `high (inherited)` from above. */
export function priorityLabel(d: DerivedTask): string | null {
  const effective = d.derived.effective_priority;
  if (effective === "normal") return null;
  return d.snapshot.task.frontmatter.priority === effective
    ? effective
    : `${effective} (inherited)`;
}

/**
 * Overviews label every IN_PROGRESS task that has a session with its
 * liveness; a claim without a session carries none. Unknown with a session
 * means a heartbeat that never reached this machine, which is worth seeing.
 */
function livenessLabel(d: DerivedTask): string | null {
  const fm = d.snapshot.task.frontmatter;
  if (fm.status !== "IN_PROGRESS" || fm.claimed_session === null) return null;
  switch (d.derived.liveness) {
    case "live":
      return "live";
    case "orphaned":
      return d.derived.last_seen === null
        ? "orphaned"
        : `orphaned since ${d.derived.last_seen}`;
    default:
      return "liveness unknown";
  }
}

function assigneeLabel(d: DerivedTask): string | null {
  const fm = d.snapshot.task.frontmatter;
  if (fm.assignee === null) return null;
  if (fm.status === "PAUSED") {
    return d.derived.situation === "waiting"
      ? null
      : `waiting for ${fm.assignee}`;
  }
  return d.derived.situation === "assigned" ? null : `assigned ${fm.assignee}`;
}

/** Situations whose word already says that the task's own work began. */
const IMPLIES_STARTED: ReadonlySet<Situation> = new Set([
  "working",
  "parked",
  "waiting",
]);

/**
 * The secondary labels, in a fixed order: started, blocked by (when not the
 * situation), active, priority, liveness, the assignee, held by, closable.
 * `started` marks the task's own resume point, where the word does not
 * already imply one: below a parent, progress and `active` say more. A
 * resolved task carries only `active`, which there flags a broken invariant;
 * everything else concerns work still to schedule.
 */
export function labels(d: DerivedTask): string[] {
  const { derived } = d;
  const task = d.snapshot.task;
  if (isResolved(task.frontmatter.status)) {
    return derived.active ? ["active"] : [];
  }

  const out: string[] = [];
  if (task.workspace.state && !IMPLIES_STARTED.has(derived.situation)) {
    out.push("started");
  }
  if (derived.blocked_by.length > 0 && derived.situation !== "blocked") {
    out.push(blockedText(d));
  }
  if (derived.active) out.push("active");
  const priority = priorityLabel(d);
  if (priority !== null) out.push(priority);
  const liveness = livenessLabel(d);
  if (liveness !== null) out.push(liveness);
  const assignee = assigneeLabel(d);
  if (assignee !== null) out.push(assignee);
  if (derived.held_by !== null && derived.situation !== "held") {
    out.push(`held by ${derived.held_by}`);
  }
  if (derived.closable && derived.situation !== "closable") {
    out.push("closable");
  }
  return out;
}
