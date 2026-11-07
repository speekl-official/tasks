import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { CommandContext } from "../context.js";
import { TaskError, isTaskError } from "../errors.js";
import { addressTree, authorize, checkPlacement } from "./archive.js";
import type { Placement } from "./archive.js";
import { errnoCode, removeEmptyDirs } from "./fs-utils.js";
import type { ReferenceSite } from "./gates.js";
import {
  assertTaskPath,
  compareIds,
  depthOf,
  isBelow,
  isWithin,
  safeParseReference,
} from "./ids.js";
import type { Fresh } from "./mutate.js";
import { withMutation } from "./mutate.js";
import type { LoadedTree } from "./projects.js";
import { claimLiveness } from "./sessions.js";
import type { Task } from "./task.js";
import { makeTask } from "./task.js";
import type { SupersededClaim } from "./authorization.js";
import { isClaimant, supersededClaimOf } from "./authorization.js";
import { NO_CLAIM, cascadeTarget, claimsText } from "./transitions.js";
import type { Tree } from "./tree.js";
import {
  archivedTaskDir,
  hasLiveTask,
  isGroup,
  isReservedPath,
  resolveTaskId,
  taskDir,
  writeTask,
} from "./tree.js";
import type {
  CascadeClaimDetails,
  Frontmatter,
  GateField,
  RewrittenRefJson,
  UnrewrittenRefJson,
} from "./types.js";
import { MOVING_MARKER_FILENAME } from "./types.js";
import {
  appendLogEntry,
  cascadeLine,
  logEntryFor,
  moveLine,
  passedOverLine,
} from "./workspace.js";

/**
 * `move`: relocate a task or a group to a new path in the same tree.
 *
 * Ids are paths, so a move renames everything beneath its source. The source
 * tree decides and writes under its own lock. Every refusal is checked
 * against the tree as re-read there before anything is written; then the
 * directory moves in one rename (across filesystems, a copy marked by
 * `.moving`), the moved tasks are deferred when the destination lies under a
 * `BACKLOG` parent, every reference that tree holds to a moved task is
 * rewritten, and each moved task's log records the move. Once that lock is
 * released, every other tree the command can write — the local tree and the
 * trees it lists — has its references rewritten under its own lock, one tree
 * at a time; references in trees reached only by a bare path are reported,
 * never written. Nothing spans trees as a transaction: an interruption
 * between them leaves references dangling, which gates block on and
 * validation reports.
 */

/* ------------------------------------------------------------------------ */
/* Requests and results                                                     */
/* ------------------------------------------------------------------------ */

export interface MoveOptions {
  /**
   * `--force`: move work in progress whose claim is live or unknown and not
   * the caller's, and a task whose assignee is someone else. Every log entry
   * the move writes then says so.
   */
  force?: boolean;
}

/** One relocated task, qualified for a listed project. */
export interface MovedTaskJson {
  from: string;
  to: string;
}

/** What `move --json` prints. */
export interface MoveJson {
  /** The source path, qualified for a listed project. */
  from: string;
  /** The destination path, qualified likewise. */
  to: string;
  kind: "task" | "group";
  /** Every task that moved, in tree order of its former id. */
  tasks: MovedTaskJson[];
  /** New ids of the tasks deferred under a `BACKLOG` parent, in tree order. */
  deferred: string[];
  /** References rewritten: the source tree's first, then each other tree's. */
  rewritten: RewrittenRefJson[];
  /** References to moved tasks the command could read but not write. */
  unrewritten: UnrewrittenRefJson[];
  /** Writable trees it could not write; their references are in `unrewritten`. */
  skipped: SkippedTree[];
}

/** A writable tree whose references could not be rewritten, and why. */
export interface SkippedTree {
  /** The alias of the tree, or `null` for the local tree. */
  project: string | null;
  reason: string;
}

export interface MoveResult extends MoveJson {
  /** `--force` lifted at least one refusal. */
  forced: boolean;
  /** Claims the move went past: orphaned ones, and those `--force` overrode. */
  superseded: SupersededClaim[];
}

/** The contract fields of a result, as `--json` prints them. */
export function moveJson(result: MoveResult): MoveJson {
  return {
    from: result.from,
    to: result.to,
    kind: result.kind,
    tasks: result.tasks,
    deferred: result.deferred,
    rewritten: result.rewritten,
    unrewritten: result.unrewritten,
    skipped: result.skipped,
  };
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Move the task or group `sourceArg` names to `destinationArg`, a new path
 * in the same tree, and rewrite the references to every task it moves in
 * each tree the command can write.
 */
export async function moveSubtree(
  context: CommandContext,
  sourceArg: string,
  destinationArg: string,
  options: MoveOptions = {},
): Promise<MoveResult> {
  const { load, path: typed } = await addressTree(context, sourceArg, "source");
  const destination = await destinationIn(context, load, destinationArg);
  const force = options.force === true;

  const moved = await withMutation(context, load, (fresh) =>
    relocate(context, fresh, typed, destination, force),
  );

  const rewritten = [...moved.rewritten];
  const unrewritten: UnrewrittenRefJson[] = [];
  const skipped: SkippedTree[] = [];
  for (const other of await context.projects.writableTrees()) {
    if (other.key === load.key) continue;
    const outcome = await rewriteTree(context, other, load.key, moved.renames);
    rewritten.push(...outcome.rewritten);
    unrewritten.push(...outcome.unrewritten);
    if (outcome.skipped !== null) skipped.push(outcome.skipped);
  }
  unrewritten.push(
    ...(await readOnlyReferences(context, load.key, moved.renames)),
  );

  const qualify = (id: string) => context.projects.qualify(load, id);
  return {
    from: qualify(moved.source),
    to: qualify(moved.destination),
    kind: moved.kind,
    tasks: [...moved.renames].map(([from, to]) => ({
      from: qualify(from),
      to: qualify(to),
    })),
    deferred: moved.deferred.map(qualify),
    rewritten,
    unrewritten,
    forced: moved.forced,
    superseded: moved.superseded,
    skipped,
  };
}

/**
 * The destination as a path of the source's tree. It is a new path, so it
 * is never resolved as a suffix; an alias prefix is accepted only when it
 * names the source's own tree, because a move between trees is not defined.
 */
async function destinationIn(
  context: CommandContext,
  source: LoadedTree,
  arg: string,
): Promise<string> {
  const cut = arg.lastIndexOf(":");
  const destination = assertTaskPath(
    cut === -1 ? arg : arg.slice(cut + 1),
    "destination",
  );
  if (cut === -1) return destination;

  const prefix = arg.slice(0, cut);
  // An unknown alias is the usage error `byAlias` raises itself.
  const target = prefix === "" ? null : await context.projects.byAlias(prefix);
  if (target?.kind === "ok" && target.key === source.key) return destination;
  const project = context.projects.qualifier(source);
  throw TaskError.usage(
    `Cannot move to ${arg}: the source lies in ${project ?? "the local tree"}, and a move stays within one tree. Name the destination as a path of that tree.`,
    { destination: arg, project },
  );
}

/* ------------------------------------------------------------------------ */
/* Inside the source tree's lock                                            */
/* ------------------------------------------------------------------------ */

type Qualify = (id: string) => string;

/** How refusals name the move: both ends, qualified for a listed project. */
interface Subject {
  from: string;
  to: string;
}

interface Source {
  id: string;
  /** The task at `id`, or `null` for a group. */
  task: Task | null;
}

/** What the source tree's lock decided and wrote. */
interface Relocation {
  kind: "task" | "group";
  source: string;
  destination: string;
  /** Old id → new id of every moved task, in tree order of the old id. */
  renames: Map<string, string>;
  /** New ids of the deferred tasks, in tree order. */
  deferred: string[];
  rewritten: RewrittenRefJson[];
  forced: boolean;
  superseded: SupersededClaim[];
}

/**
 * Decide from the fresh tree, refusing before anything is written, then
 * write: the directory, the moved tasks' manifests where they change and
 * their log entries, then the other manifests of this tree that reference a
 * moved task.
 */
async function relocate(
  context: CommandContext,
  fresh: Fresh,
  typed: string,
  destination: string,
  force: boolean,
): Promise<Relocation> {
  const { tree, load, now } = fresh;
  const qualify: Qualify = (id) => context.projects.qualify(load, id);
  const source = resolveSource(tree, typed, qualify);
  const subject: Subject = {
    from: qualify(source.id),
    to: qualify(destination),
  };

  if (destination === source.id) {
    throw TaskError.conflict(
      `${subject.from} is already at ${subject.to}; a move needs a new path.`,
      { id: subject.from, to: subject.to, kind: "same-path" },
    );
  }
  if (isBelow(destination, source.id)) {
    throw TaskError.conflict(
      `Cannot move ${subject.from} to ${subject.to}: the destination lies inside the subtree that moves.`,
      { id: subject.from, to: subject.to, kind: "inside-subtree" },
    );
  }

  const placement = await placementOf(tree, destination, qualify, subject);
  await assertVacant(tree, destination, subject);
  const moved = movedTasks(tree, source.id, qualify, subject);
  await assertNoMarker(tree, source.id, subject);
  const renames = new Map(
    moved.map((task) => [task.id, renamed(task.id, source.id, destination)]),
  );
  assertUnreserved(tree, renames, qualify, subject);

  const after = afterMove(tree, renames, placement.parent);
  const trees = await context.projects.writableTrees();
  // Resolving every reference of the writable trees also loads the trees
  // they reach by a bare path, which `readOnlyReferences` reads afterwards.
  const sites = await context.gates.referenceSites(trees);
  assertNoAncestorDependency(load, sites, renames, after, qualify, subject);
  assertNoNewCycle(context, {
    load,
    trees,
    sites,
    renames,
    after,
    parent: placement.parent,
    subject,
  });

  // Overridable last, so a forced retry cannot run into another refusal.
  const claims = await passClaims(
    context,
    tree,
    moved,
    renames,
    qualify,
    subject,
    force,
  );
  let forced = claims.forced;
  if (source.task !== null) {
    // The assignee rule, as every write that is not a transition obeys it;
    // the claim it also checks was judged above.
    const authorization = await authorize(tree, source.task, context.identity, {
      force,
      label: subject.from,
      command: "move",
    });
    forced = forced || authorization.forced;
  }

  const tasksDir = tree.project.tasksDir;
  const sourceDir = taskDir(tree, source.id);
  await relocateDirectory(
    sourceDir,
    taskDir(tree, destination),
    source.id,
    tasksDir,
  );
  await removeEmptyDirs(path.dirname(sourceDir), tasksDir);

  const rewrites = rewritesOf(sites, load.key, load.key, renames);
  const refsByTask = groupByTask(rewrites);
  const { backlog } = placement;
  const deferred: string[] = [];
  // Deepest first, the order in which a cascade writes.
  for (const task of [...moved].sort(deepestFirst)) {
    const id = renames.get(task.id)!;
    const dir = taskDir(tree, id);
    const to = backlog === null ? null : cascadeTarget("defer", task);
    const refs = refsByTask.get(task.id);
    // A pure relocation leaves the manifest, and so `updated`, alone: the
    // id is the directory's path, not a field.
    if (to !== null || refs !== undefined) {
      let frontmatter: Frontmatter = { ...task.frontmatter, updated: now };
      if (to !== null) {
        frontmatter = { ...frontmatter, status: to, ...NO_CLAIM };
      }
      if (refs !== undefined) frontmatter = retargeted(frontmatter, refs);
      await writeTask(
        makeTask({
          id,
          dir,
          archived: false,
          parent: after.parents.get(id) ?? null,
          frontmatter,
          extra: task.extra,
          body: task.body,
          workspace: task.workspace,
        }),
      );
    }

    const status = task.frontmatter.status;
    const deferLine =
      backlog === null || to === null
        ? null
        : cascadeLine("defer", backlog, status, to, { forced });
    const claim = claims.superseded.get(task.id);
    const claimLine =
      claim === undefined
        ? null
        : passedOverLine(
            claim.claimant,
            claim.session,
            claim.liveness,
            claim.last_seen,
          );
    await appendLogEntry(
      dir,
      logEntryFor(context.identity, now, [
        moveLine(task.id, id, forced),
        deferLine,
        claimLine,
      ]),
    );
    if (to !== null) deferred.push(id);
  }

  // The rest of this tree: a rewritten reference changes the manifest, so it
  // is stamped; it is a repair, not an event, so it is not logged.
  for (const task of tree.tasks) {
    const refs = refsByTask.get(task.id);
    if (refs === undefined || renames.has(task.id)) continue;
    await writeTask({
      ...task,
      frontmatter: retargeted({ ...task.frontmatter, updated: now }, refs),
    });
  }

  const project = context.projects.qualifier(load);
  return {
    kind: source.task === null ? "group" : "task",
    source: source.id,
    destination,
    renames,
    deferred: deferred.sort(compareIds),
    rewritten: rewrites
      .map((rewrite) => ({
        project,
        task: renames.get(rewrite.task) ?? rewrite.task,
        field: rewrite.field,
        from: rewrite.from,
        to: rewrite.to,
      }))
      .sort((a, b) => compareIds(a.task, b.task)),
    forced,
    superseded: [...claims.superseded.values()],
  };
}

/**
 * The source as typed: a live task by exact id, else a group by its exact
 * path (groups are never resolved by suffix), else a live task by the
 * suffix rule. A malformed manifest cannot be moved: its status, claim and
 * references cannot be read.
 */
function resolveSource(tree: Tree, typed: string, qualify: Qualify): Source {
  let id = typed;
  if (!hasLiveTask(tree, typed)) {
    if (isGroup(tree, typed)) return { id: typed, task: null };
    try {
      id = resolveTaskId(tree, typed);
    } catch (err) {
      if (
        isTaskError(err) &&
        err.code === "NOT_FOUND" &&
        err.details?.archived !== true
      ) {
        throw TaskError.notFound(
          `No task or group matches "${qualify(typed)}": a group is named by its full path, a task by its path or an unambiguous suffix.`,
          { argument: qualify(typed) },
        );
      }
      throw err;
    }
  }

  const task = tree.byId.get(id);
  if (task !== undefined) return { id, task };
  const broken = tree.malformedById.get(id);
  if (broken === undefined) {
    throw TaskError.internal(`${qualify(id)} was resolved but is not live.`, {
      id: qualify(id),
    });
  }
  throw TaskError.conflict(
    `${qualify(id)} has a malformed task.md: ${broken.message}. Fix ${broken.path} by hand before moving it.`,
    {
      id: qualify(id),
      kind: "malformed",
      path: broken.path,
      message: broken.message,
    },
  );
}

/**
 * The placement rules `new` and `restore` obey — no live task at the path,
 * no resolved or unreadable ancestor, nothing but directories on the way —
 * with the move's two ends in `details`. Reservations are checked per moved
 * task instead: a group may sit on a path an archived task reserves.
 */
async function placementOf(
  tree: Tree,
  destination: string,
  qualify: Qualify,
  subject: Subject,
): Promise<Placement> {
  try {
    return await checkPlacement(tree, destination, {
      qualify,
      allowReserved: true,
    });
  } catch (err) {
    if (!isTaskError(err)) throw err;
    throw new TaskError(err.code, err.message, {
      ...err.details,
      id: subject.from,
      to: subject.to,
    });
  }
}

/** The destination is a new path: not even an empty group may be there. */
async function assertVacant(
  tree: Tree,
  destination: string,
  subject: Subject,
): Promise<void> {
  const dir = taskDir(tree, destination);
  if ((await lstatOrNull(dir)) === null) return;
  const what = isGroup(tree, destination) ? "a group" : "a directory";
  throw TaskError.conflict(
    `Cannot move ${subject.from} to ${subject.to}: ${what} is already there, and a move needs a new path.`,
    { id: subject.from, to: subject.to, kind: "exists", path: dir },
  );
}

/**
 * The parsed tasks that move, in tree order. A malformed manifest beneath
 * the source refuses the move: whether it is claimed, what it references and
 * whether a defer must reach it cannot be read.
 */
function movedTasks(
  tree: Tree,
  sourceId: string,
  qualify: Qualify,
  subject: Subject,
): Task[] {
  const broken = tree.malformed
    .filter((entry) => entry.id !== "" && isWithin(entry.id, sourceId))
    .map((entry) => qualify(entry.id));
  if (broken.length > 0) {
    const one = broken.length === 1;
    throw TaskError.conflict(
      `Cannot move ${subject.from}: ${broken.join(", ")} beneath it ${one ? "has" : "have"} a malformed task.md. Fix ${one ? "it" : "them"} by hand first.`,
      {
        id: subject.from,
        to: subject.to,
        kind: "malformed-descendants",
        descendants: broken,
      },
    );
  }
  return tree.tasks.filter((task) => isWithin(task.id, sourceId));
}

/**
 * A source that holds a `.moving` marker is the unfinished destination of
 * an earlier move: the same task may exist twice. That is resolved first.
 */
async function assertNoMarker(
  tree: Tree,
  sourceId: string,
  subject: Subject,
): Promise<void> {
  const marker = path.join(taskDir(tree, sourceId), MOVING_MARKER_FILENAME);
  if ((await lstatOrNull(marker)) === null) return;
  throw TaskError.conflict(
    `Cannot move ${subject.from}: it holds ${MOVING_MARKER_FILENAME}, left by a move into it that did not finish. Run \`tasks validate\`, keep one copy, delete the marker, then move it.`,
    {
      id: subject.from,
      to: subject.to,
      kind: "interrupted-move",
      path: marker,
    },
  );
}

/** No moved task may land on a path an archived task reserves. */
function assertUnreserved(
  tree: Tree,
  renames: Map<string, string>,
  qualify: Qualify,
  subject: Subject,
): void {
  for (const [from, to] of renames) {
    if (!isReservedPath(tree, to)) continue;
    const shown = qualify(to);
    throw TaskError.conflict(
      `Cannot move ${subject.from} to ${subject.to}: ${qualify(from)} would land on ${shown}, which an archived task reserves. Release the path with \`tasks purge ${shown}\`, which deletes the archived task for good, or choose another destination.`,
      {
        id: subject.from,
        to: subject.to,
        kind: "reserved",
        task: shown,
        archived: archivedTaskDir(tree, to),
      },
    );
  }
}

/* ------------------------------------------------------------------------ */
/* The tree after the move                                                  */
/* ------------------------------------------------------------------------ */

/** The source tree's containment as it will stand after the move. */
interface After {
  /** Live ids, parsed and malformed. */
  ids: Set<string>;
  /** Each live id → its parent. */
  parents: Map<string, string | null>;
  /** New ids of the moved tasks whose parent lies outside the move. */
  roots: string[];
}

function renamed(id: string, source: string, destination: string): string {
  return destination + id.slice(source.length);
}

/**
 * Relative containment survives a move; only the moved tasks whose parent
 * stays behind — the source task, or a group's top tasks — get a new one,
 * the destination's nearest task ancestor.
 */
function afterMove(
  tree: Tree,
  renames: Map<string, string>,
  parent: string | null,
): After {
  const ids = new Set<string>();
  const parents = new Map<string, string | null>();
  const roots: string[] = [];
  for (const task of tree.tasks) {
    const id = renames.get(task.id);
    if (id === undefined) {
      ids.add(task.id);
      parents.set(task.id, task.parent);
      continue;
    }
    const inner = task.parent === null ? undefined : renames.get(task.parent);
    ids.add(id);
    parents.set(id, inner ?? parent);
    if (inner === undefined) roots.push(id);
  }
  for (const entry of tree.malformed) {
    if (entry.id === "") continue;
    ids.add(entry.id);
    parents.set(entry.id, entry.parent);
  }
  return { ids, parents, roots };
}

const VERBS: Record<GateField, string> = {
  depends_on: "depend on",
  finishes_after: "finish after",
};

/**
 * No moved task may depend on, or finish after, one of its ancestors as they
 * stand after the move: the ancestor is done only after it, so neither could
 * ever finish. This is the ancestor rule of dependency editing, applied to
 * the references the move carries.
 */
function assertNoAncestorDependency(
  load: LoadedTree,
  sites: ReferenceSite[],
  renames: Map<string, string>,
  after: After,
  qualify: Qualify,
  subject: Subject,
): void {
  for (const site of sites) {
    if (site.holder.key !== load.key || site.target?.tree.key !== load.key) {
      continue;
    }
    // Tasks that stay keep their ancestors; only moved ones gain new ones.
    const holder = renames.get(site.task);
    if (holder === undefined) continue;
    const target = renames.get(site.target.id) ?? site.target.id;
    if (!after.ids.has(target) || !isBelow(holder, target)) continue;
    const command = site.field === "depends_on" ? "dep" : "after";
    throw TaskError.conflict(
      `Cannot move ${subject.from} to ${subject.to}: ${qualify(holder)} would ${VERBS[site.field]} ${qualify(target)}, its own ancestor there, which is done only after it, so neither could ever finish. Remove the reference first with \`tasks ${command} rm\`.`,
      {
        id: subject.from,
        to: subject.to,
        kind: "ancestor",
        task: qualify(holder),
        field: site.field,
        ref: site.ref,
        ancestor: qualify(target),
      },
    );
  }
}

/** A directed graph over node keys, each with the name a message shows. */
class Graph {
  private readonly names = new Map<string, string>();
  private readonly next = new Map<string, Set<string>>();

  node(key: string, name: string): string {
    if (!this.names.has(key)) this.names.set(key, name);
    return key;
  }

  name(key: string): string {
    return this.names.get(key) ?? key;
  }

  edge(from: string, to: string): void {
    let out = this.next.get(from);
    if (out === undefined) {
      out = new Set();
      this.next.set(from, out);
    }
    out.add(to);
  }

  /** A shortest path from `from` to `to`, both included, or `null`. */
  path(from: string, to: string): string[] | null {
    const via = new Map<string, string | null>([[from, null]]);
    const queue = [from];
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]!;
      if (current === to) {
        const out: string[] = [];
        for (
          let node: string | null = current;
          node !== null;
          node = via.get(node) ?? null
        ) {
          out.unshift(node);
        }
        return out;
      }
      for (const following of this.next.get(current) ?? []) {
        if (!via.has(following)) {
          via.set(following, current);
          queue.push(following);
        }
      }
    }
    return null;
  }
}

/**
 * No new cycle may arise in the combined gate graph, built as it will stand
 * after the move with the gates module's rules: an edge from each task to
 * every live task it depends on or finishes after, in this tree or a listed
 * one (a tree reached by a bare path contributes no edge), and from each
 * parent to every live child. Moved tasks carry their edges under their new
 * ids, as the rewrite will store them.
 *
 * A move creates two kinds of edges, and a new cycle runs through at least
 * one of them: the new parent waits for each moved task that becomes its
 * child, and a reference that named a path the move now fills starts to
 * bind. Each is refused when its target already reaches its source. Cycles
 * elsewhere in the tree are validation's to report, not a move's to refuse.
 */
/** What the cycle check reads: the trees and references as they are now. */
interface CycleInput {
  load: LoadedTree;
  trees: LoadedTree[];
  sites: ReferenceSite[];
  renames: Map<string, string>;
  after: After;
  /** The destination's nearest task ancestor, the moved roots' new parent. */
  parent: string | null;
  subject: Subject;
}

function assertNoNewCycle(context: CommandContext, input: CycleInput): void {
  const { load, trees, sites, renames, after, parent, subject } = input;
  const graph = new Graph();
  const at = (tree: LoadedTree, id: string): string =>
    graph.node(`${tree.key}\0${id}`, context.projects.qualify(tree, id));

  for (const tree of trees) {
    if (tree.key === load.key) {
      for (const [id, above] of after.parents) {
        if (above !== null) graph.edge(at(load, above), at(load, id));
      }
      continue;
    }
    for (const task of tree.tree.tasks) {
      if (task.parent !== null) {
        graph.edge(at(tree, task.parent), at(tree, task.id));
      }
    }
    for (const entry of tree.tree.malformed) {
      if (entry.id !== "" && entry.parent !== null) {
        graph.edge(at(tree, entry.parent), at(tree, entry.id));
      }
    }
  }

  const created: Array<[string, string]> = [];
  if (parent !== null) {
    for (const root of after.roots) {
      created.push([at(load, parent), at(load, root)]);
    }
  }

  for (const site of sites) {
    const target = site.target;
    if (target === null || !target.tree.writable) continue;
    const holder =
      site.holder.key === load.key
        ? (renames.get(site.task) ?? site.task)
        : site.task;
    let id = target.id;
    let binds = false;
    if (target.tree.key === load.key) {
      const moved = renames.get(id);
      if (moved !== undefined) id = moved;
      else binds = !hasLiveTask(load.tree, id);
      if (!after.ids.has(id)) continue;
    } else if (!hasLiveTask(target.tree.tree, id)) {
      continue;
    }
    const edge: [string, string] = [
      at(site.holder, holder),
      at(target.tree, id),
    ];
    graph.edge(edge[0], edge[1]);
    if (binds) created.push(edge);
  }

  for (const [from, to] of created) {
    const back = graph.path(to, from);
    if (back === null) continue;
    const cycle = [from, ...back.slice(0, -1)].map((key) => graph.name(key));
    throw TaskError.conflict(
      `Cannot move ${subject.from} to ${subject.to}: it would close a cycle, ${[...cycle, cycle[0]].join(" → ")}, in which no task could ever finish.`,
      { id: subject.from, to: subject.to, kind: "cycle", cycle },
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Work in progress                                                         */
/* ------------------------------------------------------------------------ */

interface Claims {
  /** `--force` lifted the refusal over a live or unknown claim. */
  forced: boolean;
  /** Claims the move goes past, by the old id of the task that carries one. */
  superseded: Map<string, SupersededClaim>;
}

/**
 * The claimant rule over every task that moves, as the cascade liveness rule
 * applies it to a subtree: an `IN_PROGRESS` task whose claim is live or
 * unknown moves only with its claimant (the same actor, and the same session
 * when the claim has one) or by force; an orphaned claim protects nothing,
 * and the move records it as a takeover would.
 */
async function passClaims(
  context: CommandContext,
  tree: Tree,
  moved: Task[],
  renames: Map<string, string>,
  qualify: Qualify,
  subject: Subject,
  force: boolean,
): Promise<Claims> {
  const live: CascadeClaimDetails["claims"] = [];
  const superseded = new Map<string, SupersededClaim>();
  for (const task of moved) {
    const fm = task.frontmatter;
    if (fm.status !== "IN_PROGRESS" || isClaimant(fm, context.identity)) {
      continue;
    }
    const claim = await claimLiveness(tree, task);
    const passed = supersededClaimOf(
      qualify(renames.get(task.id) ?? task.id),
      fm,
      claim,
    );
    if (passed !== null) superseded.set(task.id, passed);
    if (claim.liveness !== "orphaned") {
      live.push({
        id: qualify(task.id),
        claimant: fm.claimed_by ?? "",
        session: fm.claimed_session,
        liveness: claim.liveness,
      });
    }
  }

  if (live.length > 0 && !force) {
    const details: CascadeClaimDetails = { id: subject.from, claims: live };
    throw TaskError.conflict(
      `Cannot move ${subject.from} to ${subject.to}: it would carry work in progress, ${claimsText(live)}. Only the claimant moves claimed work; wait for it to pause, or pass --force.`,
      { ...details, to: subject.to, kind: "cascade-claim" },
    );
  }
  return { forced: live.length > 0, superseded };
}

/* ------------------------------------------------------------------------ */
/* References                                                               */
/* ------------------------------------------------------------------------ */

/** One reference to rewrite: where it is stored, before and after. */
interface Rewrite {
  /** The task storing it, by its id in its own tree before the move. */
  task: string;
  field: GateField;
  from: string;
  to: string;
}

/**
 * The references stored in the tree `holder` that resolve to a moved task of
 * the tree `source`, with the form each takes after the move: the project
 * path as stored, the id replaced. A reference to a path beneath the source
 * where no task lives (missing, or archived) names no moved task and stays
 * as it is: an archived path keeps its reservation only while references
 * still name it.
 */
function rewritesOf(
  sites: ReferenceSite[],
  holder: string,
  source: string,
  renames: Map<string, string>,
): Rewrite[] {
  const out: Rewrite[] = [];
  for (const site of sites) {
    if (site.holder.key !== holder || site.target?.tree.key !== source) {
      continue;
    }
    const id = renames.get(site.target.id);
    if (id === undefined) continue;
    out.push({
      task: site.task,
      field: site.field,
      from: site.ref,
      to: retarget(site.ref, id),
    });
  }
  return out;
}

/** The stored reference with its id replaced and its project path kept. */
function retarget(ref: string, id: string): string {
  const parsed = safeParseReference(ref);
  return parsed.ok && parsed.ref.kind === "external"
    ? `${parsed.ref.projectPath}:${id}`
    : id;
}

/** Task id → (stored form → new form), in the order the rewrites came. */
function groupByTask(rewrites: Rewrite[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const rewrite of rewrites) {
    let refs = out.get(rewrite.task);
    if (refs === undefined) {
      refs = new Map();
      out.set(rewrite.task, refs);
    }
    refs.set(rewrite.from, rewrite.to);
  }
  return out;
}

function retargeted(fm: Frontmatter, refs: Map<string, string>): Frontmatter {
  const replace = (list: string[]) => list.map((ref) => refs.get(ref) ?? ref);
  return {
    ...fm,
    depends_on: replace(fm.depends_on),
    finishes_after: replace(fm.finishes_after),
  };
}

interface TreeRewrite {
  rewritten: RewrittenRefJson[];
  unrewritten: UnrewrittenRefJson[];
  skipped: SkippedTree | null;
}

/**
 * Rewrite, under its own lock, the references another writable tree holds
 * to the moved tasks. A tree that names none is neither locked nor written.
 * The move itself is done by now, so a tree that cannot be written (its
 * lock stays busy, a write fails) does not undo it: its references stay
 * dangling, as after an interruption, and are reported as not rewritten.
 */
async function rewriteTree(
  context: CommandContext,
  load: LoadedTree,
  source: string,
  renames: Map<string, string>,
): Promise<TreeRewrite> {
  const project = context.projects.qualifier(load);
  const toJson = (rewrite: Rewrite): RewrittenRefJson => ({
    project,
    task: rewrite.task,
    field: rewrite.field,
    from: rewrite.from,
    to: rewrite.to,
  });

  let planned = rewritesOf(
    await context.gates.referenceSites([load]),
    load.key,
    source,
    renames,
  );
  if (planned.length === 0) {
    return { rewritten: [], unrewritten: [], skipped: null };
  }

  const written: Rewrite[] = [];
  try {
    await withMutation(context, load, async (fresh) => {
      // Decided again from the tree as re-read under its lock.
      planned = rewritesOf(
        await context.gates.referenceSites([fresh.load]),
        fresh.load.key,
        source,
        renames,
      );
      for (const [id, refs] of groupByTask(planned)) {
        const task = fresh.tree.byId.get(id);
        if (task === undefined) continue;
        await writeTask({
          ...task,
          frontmatter: retargeted(
            { ...task.frontmatter, updated: fresh.now },
            refs,
          ),
        });
        written.push(...planned.filter((rewrite) => rewrite.task === id));
      }
    });
  } catch (err) {
    if (!isTaskError(err) && errnoCode(err) === undefined) throw err;
    const left = planned.filter((rewrite) => !written.includes(rewrite));
    return {
      rewritten: written.map(toJson),
      unrewritten: left.map((rewrite) => ({
        project,
        task: rewrite.task,
        field: rewrite.field,
        ref: rewrite.from,
      })),
      skipped: {
        project,
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
  return { rewritten: written.map(toJson), unrewritten: [], skipped: null };
}

/**
 * References to the moved tasks held by trees this command could read but
 * not write: trees reached by a bare relative path from a tree it can write,
 * which it loaded while resolving references. A tree it never reached is
 * out of sight, and so are the references it holds.
 */
async function readOnlyReferences(
  context: CommandContext,
  source: string,
  renames: Map<string, string>,
): Promise<UnrewrittenRefJson[]> {
  const readOnly = context.projects
    .knownTrees()
    .filter((load) => !load.writable)
    .map((load) => ({
      load,
      project: context.projects.qualifier(load) ?? load.project.root,
    }))
    .sort((a, b) =>
      a.project < b.project ? -1 : a.project > b.project ? 1 : 0,
    );

  const out: UnrewrittenRefJson[] = [];
  for (const { load, project } of readOnly) {
    const sites = await context.gates.referenceSites([load]);
    for (const rewrite of rewritesOf(sites, load.key, source, renames)) {
      out.push({
        project,
        task: rewrite.task,
        field: rewrite.field,
        ref: rewrite.from,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Moving the directory                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Move the directory `from` (the tree path `sourceId`) to `to`, which must
 * not exist, creating the groups above `to` on demand. On one filesystem
 * this is one atomic rename. Across filesystems it is `copyAcross`. When
 * nothing moved, the groups made for `to` are removed again.
 */
export async function relocateDirectory(
  from: string,
  to: string,
  sourceId: string,
  tasksDir: string,
): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (errnoCode(err) !== "EXDEV") throw err;
    }
    await copyAcross(from, to, sourceId);
  } catch (err) {
    // Removes only what is empty: a copy left behind keeps its parents.
    await removeEmptyDirs(path.dirname(to), tasksDir);
    throw err;
  }
}

/**
 * Copy the subtree `from` into a new directory `to`, then remove `from`.
 * `to` holds a `.moving` marker naming `sourceId` from before the first
 * entry is copied until after `from` is gone, so an interruption anywhere in
 * between leaves the task present twice with the marker telling which copy
 * is the unfinished one; validation reports that as a duplicate rather than
 * choosing. A copy that fails with an error is undone (the marker last), and
 * the source, untouched, stays the one copy. Modification times are kept:
 * the ages of workspace files feed staleness warnings.
 */
export async function copyAcross(
  from: string,
  to: string,
  sourceId: string,
): Promise<void> {
  const top = await fs.lstat(from);
  const marker = path.join(to, MOVING_MARKER_FILENAME);
  await fs.mkdir(to);
  try {
    await fs.writeFile(marker, `${sourceId}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    for (const entry of await fs.readdir(from)) {
      await copyEntry(path.join(from, entry), path.join(to, entry));
    }
  } catch (err) {
    await discardCopy(to);
    throw err;
  }
  await fs.rm(from, { recursive: true, force: true });
  await fs.rm(marker);
  // Removing the marker touched the directory; give it the source's times.
  await fs.utimes(to, top.atime, top.mtime);
}

async function copyEntry(from: string, to: string): Promise<void> {
  const stat = await fs.lstat(from);
  if (stat.isSymbolicLink()) {
    // Copied as the link itself; its own times are not worth a lutimes.
    await fs.symlink(await fs.readlink(from), to);
    return;
  }
  if (stat.isDirectory()) {
    await fs.mkdir(to);
    for (const entry of await fs.readdir(from)) {
      await copyEntry(path.join(from, entry), path.join(to, entry));
    }
  } else if (stat.isFile()) {
    await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
  } else {
    throw TaskError.internal(
      `${from} is not a file, a directory or a symbolic link, so it cannot be copied to another filesystem.`,
      { path: from, kind: "special-file" },
    );
  }
  // Set after the entries: creating them changed a directory's times.
  await fs.utimes(to, stat.atime, stat.mtime);
}

/**
 * Remove an unfinished copy, the marker last, so that wherever this stops
 * the marker still says what the directory is. Best effort: the failure
 * that brought us here is the one reported.
 */
async function discardCopy(to: string): Promise<void> {
  try {
    for (const entry of await fs.readdir(to)) {
      if (entry === MOVING_MARKER_FILENAME) continue;
      await fs.rm(path.join(to, entry), { recursive: true, force: true });
    }
    await fs.rm(path.join(to, MOVING_MARKER_FILENAME), { force: true });
    await fs.rmdir(to);
  } catch {
    // The marker stays where this stopped; validation reports it.
  }
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function deepestFirst(a: Task, b: Task): number {
  return depthOf(b.id) - depthOf(a.id) || compareIds(a.id, b.id);
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (err) {
    if (errnoCode(err) === "ENOENT" || errnoCode(err) === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}
