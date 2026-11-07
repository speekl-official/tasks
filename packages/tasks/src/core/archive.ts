import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { CommandContext } from "../context.js";
import { TaskError, isTaskError } from "../errors.js";
import type { SupersededClaim } from "./authorization.js";
import { judgeAuthorization } from "./authorization.js";
import {
  errnoCode,
  isDirectory,
  readFileIfExists,
  removeEmptyDirs,
  renameDir,
} from "./fs-utils.js";
import { holdsOpenTask, unavailableReason } from "./gates.js";
import {
  ancestorPaths,
  assertTaskPath,
  compareIds,
  isBelow,
  isWithin,
  segmentsOf,
} from "./ids.js";
import { withMutation } from "./mutate.js";
import type { LoadedTree, ProjectLoad } from "./projects.js";
import { claimLiveness } from "./sessions.js";
import { snapshotFromContext, snapshotTree } from "./snapshot.js";
import type { Task } from "./task.js";
import { isOpenTask, isResolvedTask } from "./task.js";
import type { Tree } from "./tree.js";
import {
  ancestorsOf,
  archivedTaskDir,
  descendantsOf,
  findArchivedTask,
  hasLiveTask,
  isReservedPath,
  malformedAncestorOf,
  malformedDescendantsOf,
  parentForPath,
  resolveTaskArg,
  taskDir,
} from "./tree.js";
import type {
  DependentsDetails,
  Identity,
  Status,
  TaskWithDerivedJson,
} from "./types.js";
import {
  CONVENTION_VERSION,
  LOG_FILENAME,
  TASK_FILENAME,
  isResolved,
} from "./types.js";
import {
  appendLogEntry,
  forcedSuffix,
  logEntryFor,
  parseLog,
  parseLogHeading,
} from "./workspace.js";

/**
 * The structure commands' core. Everything a write that is not a status
 * transition needs: addressing a tree from a command-line argument, the
 * authorization fence (`dep`, `after`, `state` and `delete` pass through the
 * same rules as transitions), where a task may be placed (`new`, `restore`),
 * moving a task directory with merge and duplicate detection, and the
 * archive family: `archive`, `restore`, `purge` and `delete`.
 *
 * Every write here runs inside `withMutation` on the tree that holds the
 * task and decides only from the tree as re-read inside its lock. Other
 * trees are read (to find the tasks that reference an archived subtree),
 * never written.
 */

/** `alias:id` for a listed project, the bare id for the local tree. */
type Qualify = (id: string) => string;

const sameId: Qualify = (id) => id;

function qualifierFor(context: CommandContext, load: LoadedTree): Qualify {
  return (id) => context.projects.qualify(load, id);
}

/* ------------------------------------------------------------------------ */
/* Addressing                                                               */
/* ------------------------------------------------------------------------ */

/** A command-line argument resolved to the tree it names. */
export interface Addressed {
  load: LoadedTree;
  /** The path as typed, without the alias: a full id or a suffix of one. */
  path: string;
}

/**
 * The tree a listed project names, or the error that addressing it raises:
 * a project that is not checked out (or holds no tree) is not found, a tree
 * of another version is a usage error naming the upgrade, and a tree whose
 * configuration is invalid raises that configuration's own error.
 */
export function requireAvailable(target: ProjectLoad, arg: string): LoadedTree {
  if (target.kind === "ok") return target;
  const project = target.alias ?? target.relPath;
  const details = {
    argument: arg,
    project,
    reason: unavailableReason(target),
    dir: target.dir,
  };
  switch (target.kind) {
    case "not-checked-out":
      throw TaskError.notFound(
        `${arg}: project ${project} is not checked out at ${target.dir}.`,
        details,
      );
    case "unsupported-version": {
      const remedy =
        target.version === 1 && target.alias !== null
          ? ` Upgrade it once with \`tasks migrate ${target.alias}\`.`
          : "";
      throw TaskError.usage(
        `${arg}: project ${project} is a .tasks v${target.version} tree; this tasks implements v${CONVENTION_VERSION}.${remedy}`,
        { ...details, version: target.version },
      );
    }
    case "unresolved":
      if (target.cause !== null) throw target.cause;
      throw TaskError.notFound(
        `${arg}: project ${project} holds no .tasks tree (${target.dir}).`,
        details,
      );
  }
}

/**
 * Split `alias:path` (a bare path names the local tree) and load the tree it
 * names. The path is checked first, so a malformed one is reported as the
 * `label` it is (`task`, `path`, `reference`); an unknown alias is a usage
 * error. Suffixes are left for the caller to resolve against the tree, inside
 * its lock when the command writes.
 */
export async function addressTree(
  context: CommandContext,
  arg: string,
  label = "task",
): Promise<Addressed> {
  const cut = arg.lastIndexOf(":");
  assertTaskPath(cut === -1 ? arg : arg.slice(cut + 1), label);
  const { target, path: rest } = await context.projects.resolveArgument(arg);
  return { load: requireAvailable(target, arg), path: rest };
}

/**
 * How human output names a path: relative to the working directory when it
 * lies inside it, absolute otherwise (`-C` may point anywhere).
 */
export function displayPath(target: string): string {
  const relative = path.relative(process.cwd(), target);
  return relative === "" ||
    relative.split(path.sep)[0] === ".." ||
    path.isAbsolute(relative)
    ? target
    : relative;
}

/**
 * The task object with derived conditions, for the calling actor, as the
 * tree stands now: what a write returns under `--json`.
 */
export async function derivedTaskJson(
  context: CommandContext,
  load: LoadedTree,
  id: string,
): Promise<TaskWithDerivedJson> {
  const { derived } = await snapshotTree(
    snapshotFromContext(context),
    context.projects.latest(load),
    context.identity.actor,
  );
  const entry = derived.get(id);
  if (entry === undefined) {
    throw TaskError.internal(`${id} is not in the tree after the write.`, {
      id,
    });
  }
  return entry.json;
}

/* ------------------------------------------------------------------------ */
/* Authorization                                                            */
/* ------------------------------------------------------------------------ */

export interface AuthorizeOptions {
  /** `--force`: overrides every rule here, and is then recorded. */
  force?: boolean;
  /** The id as output names it: qualified for a listed project. */
  label?: string;
  /** The command, for messages: `edit` by default, `delete`, `move`. */
  command?: string;
}

export interface Authorization {
  /** Only `--force` allowed the write; its log entry says so. */
  forced: boolean;
  /** The claim the write went past: orphaned, or overridden by `--force`. */
  superseded: SupersededClaim | null;
}

/**
 * The authorization rules, for the writes that are not transitions; the
 * rules themselves live in `authorization.ts`. Call it inside the lock, on
 * the task as re-read there.
 */
export async function authorize(
  tree: Tree,
  task: Task,
  identity: Identity,
  options: AuthorizeOptions = {},
): Promise<Authorization> {
  const fm = task.frontmatter;
  // Either claim signal counts, so a manifest whose claim fields disagree
  // with its status still protects whoever may be working on it.
  const claimed =
    fm.status === "IN_PROGRESS" || fm.claimed_by !== null
      ? await claimLiveness(tree, task)
      : null;
  const verdict = judgeAuthorization({
    task,
    ancestors: ancestorsOf(tree, task.id),
    identity,
    claimed,
    shown: options.label ?? task.id,
    command: options.command ?? "edit",
  });
  if (verdict.admitted)
    return { forced: false, superseded: verdict.superseded };
  if (options.force !== true) throw verdict.refusal;
  return { forced: true, superseded: verdict.superseded };
}

/* ------------------------------------------------------------------------ */
/* Placement                                                                */
/* ------------------------------------------------------------------------ */

export interface PlacementOptions {
  /** How messages and details name ids; the bare id by default. */
  qualify?: Qualify;
  /**
   * The path's own archive entry is what is being placed (`restore`), so the
   * reservation it holds does not count against it.
   */
  allowReserved?: boolean;
}

export interface Placement {
  /** The task that would be the parent, or `null` at the top of the tree. */
  parent: string | null;
  /**
   * The nearest `BACKLOG` ancestor, or `null`. An open task placed beneath
   * one must be `BACKLOG` itself (the containment invariant).
   */
  backlog: string | null;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

/**
 * Every directory on the way to `id`, the last one included, must be a real
 * directory or not exist yet. A file there makes the path unusable, and a
 * symbolic link would hide whatever is placed through it from the scanner,
 * which never follows one.
 */
async function assertPathUsable(
  tree: Tree,
  id: string,
  shown: string,
): Promise<void> {
  const segments = segmentsOf(id);
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const native = taskDir(tree, segments.slice(0, depth).join("/"));
    const stat = await lstatOrNull(native);
    if (stat === null) return;
    if (stat.isDirectory()) continue;
    const what = stat.isSymbolicLink() ? "a symbolic link" : "a file";
    throw TaskError.conflict(
      `${native} is ${what}, so no task can be placed at ${shown}.`,
      { id: shown, kind: "path-blocked", path: native },
    );
  }
}

/**
 * Whether a task may be placed at the live path `id`, by `new` or `restore`:
 * not where a live task already is, not on a path an archived task reserves,
 * never under a resolved ancestor, and — fail safe — never under an ancestor
 * whose manifest cannot be read, since it may be resolved for all anyone can
 * tell. An existing group at the path is fine: it becomes the task. Returns
 * the parent and the nearest `BACKLOG` ancestor.
 */
export async function checkPlacement(
  tree: Tree,
  id: string,
  options: PlacementOptions = {},
): Promise<Placement> {
  const qualify = options.qualify ?? sameId;
  const shown = qualify(id);

  if (hasLiveTask(tree, id)) {
    throw TaskError.conflict(`${shown} already exists.`, {
      id: shown,
      kind: "exists",
    });
  }
  if (options.allowReserved !== true && isReservedPath(tree, id)) {
    throw TaskError.conflict(
      `${shown} is reserved by an archived task. Release the path with \`tasks purge ${shown}\`, which deletes the archived task for good, or bring it back with \`tasks restore ${shown}\`.`,
      { id: shown, kind: "reserved", archived: archivedTaskDir(tree, id) },
    );
  }

  const broken = malformedAncestorOf(tree, id);
  if (broken !== null) {
    throw TaskError.conflict(
      `${shown} would be placed under ${qualify(broken.id)}, whose task.md is malformed (${broken.message}). Fix ${broken.path} first.`,
      {
        id: shown,
        kind: "malformed-ancestor",
        ancestor: qualify(broken.id),
        path: broken.path,
      },
    );
  }

  const ancestors = ancestorsOf(tree, id);
  const resolved = ancestors.find(isResolvedTask);
  if (resolved !== undefined) {
    throw TaskError.conflict(
      `${shown} would be placed under ${qualify(resolved.id)}, which is ${resolved.frontmatter.status}; reopen it first.`,
      {
        id: shown,
        kind: "resolved-ancestor",
        ancestor: qualify(resolved.id),
        status: resolved.frontmatter.status,
      },
    );
  }

  await assertPathUsable(tree, id, shown);
  return {
    parent: parentForPath(tree, id),
    backlog:
      ancestors.find((ancestor) => ancestor.frontmatter.status === "BACKLOG")
        ?.id ?? null,
  };
}

/* ------------------------------------------------------------------------ */
/* Moving task directories                                                  */
/* ------------------------------------------------------------------------ */

interface MovePlan {
  from: string;
  to: string;
  /** The destination exists: its content stays and the source merges in. */
  merge: boolean;
}

/**
 * Relative paths that exist on both sides, unless both are directories,
 * which merge. `incoming` names files that will exist at the top of `from`
 * by the time it moves although they may not yet.
 */
async function collisionsIn(
  from: string,
  to: string,
  relative: string,
  incoming: readonly string[],
): Promise<string[]> {
  const entries = new Map<string, boolean>();
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    // A symbolic link is moved as itself, never merged into.
    entries.set(entry.name, entry.isDirectory());
  }
  for (const name of incoming) {
    if (!entries.has(name)) entries.set(name, false);
  }

  const out: string[] = [];
  for (const [name, isDir] of entries) {
    const existing = await lstatOrNull(path.join(to, name));
    if (existing === null) continue;
    const at = relative === "" ? name : `${relative}/${name}`;
    if (isDir && existing.isDirectory()) {
      out.push(
        ...(await collisionsIn(
          path.join(from, name),
          path.join(to, name),
          at,
          [],
        )),
      );
    } else {
      out.push(at);
    }
  }
  return out;
}

/**
 * Plan moving the task directory `from` to `to`: one atomic rename when `to`
 * does not exist, else a merge into it. Every collision is found before
 * anything moves, so a refused move changes nothing; a `task.md` among them
 * is a task present twice, which is never resolved by choosing one.
 */
async function planMove(
  from: string,
  to: string,
  shown: string,
  incoming: readonly string[] = [],
): Promise<MovePlan> {
  const existing = await lstatOrNull(to);
  if (existing === null) return { from, to, merge: false };
  if (!existing.isDirectory()) {
    throw TaskError.conflict(
      `${shown} cannot move to ${to}: something other than a directory is there.`,
      { id: shown, kind: "path-blocked", path: to },
    );
  }

  const found = (await collisionsIn(from, to, "", incoming)).sort();
  if (found.length > 0) {
    const duplicate = found.some(
      (at) => path.posix.basename(at) === TASK_FILENAME,
    );
    throw TaskError.conflict(
      duplicate
        ? `${shown} cannot move to ${to}: ${found.join(", ")} would be present on both sides, so a task would exist twice. Resolve the duplicate by hand; neither copy is chosen silently.`
        : `${shown} cannot move to ${to}: ${found.join(", ")} would be present on both sides. Move one of them out of the way first.`,
      {
        id: shown,
        kind: duplicate ? "duplicate" : "collision",
        destination: to,
        paths: found,
      },
    );
  }
  return { from, to, merge: true };
}

/** `fs.rename` for one entry, copying across filesystems like `renameDir`. */
async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
    return;
  } catch (err) {
    if (errnoCode(err) !== "EXDEV") throw err;
  }
  const stat = await fs.lstat(from);
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(from), to);
  } else {
    await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    // Ages of workspace files feed staleness warnings; keep them.
    await fs.utimes(to, stat.atime, stat.mtime);
  }
  await fs.rm(from, { force: true });
}

/**
 * Move every entry of `from` into `to`, recursing where both hold a
 * directory, then remove `from`. `task.md` moves last in each directory: an
 * interrupted merge leaves every task on one side, never on both and never
 * lost, and what was moved so far is plain workspace content that reserves
 * nothing.
 */
async function mergeInto(from: string, to: string): Promise<void> {
  const entries = (await fs.readdir(from, { withFileTypes: true })).sort(
    (a, b) =>
      Number(a.name === TASK_FILENAME) - Number(b.name === TASK_FILENAME),
  );
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const existing = await lstatOrNull(target);
    if (existing === null) {
      if (entry.isDirectory()) await renameDir(source, target);
      else await moveEntry(source, target);
    } else if (entry.isDirectory() && existing.isDirectory()) {
      await mergeInto(source, target);
    } else {
      // The plan found no collision under the lock: something outside the
      // tooling wrote here meanwhile.
      throw TaskError.internal(
        `${target} appeared while ${from} was being merged into it.`,
        { path: target },
      );
    }
  }
  await fs.rmdir(from);
}

async function sizeOrNull(file: string): Promise<number | null> {
  return (await lstatOrNull(file))?.size ?? null;
}

/**
 * Undo the entry just appended to `file`, which was `size` bytes long (or
 * absent) before it. Best effort: where the log already moved, or cannot be
 * touched, the original failure is what the caller reports.
 */
async function rollBackLog(file: string, size: number | null): Promise<void> {
  try {
    if (size === null) await fs.rm(file, { force: true });
    else await fs.truncate(file, size);
  } catch {
    // Nothing more can be done; the move's own error follows.
  }
}

async function executeMove(plan: MovePlan): Promise<void> {
  if (plan.merge) await mergeInto(plan.from, plan.to);
  else await renameDir(plan.from, plan.to);
}

/* ------------------------------------------------------------------------ */
/* References into a subtree                                                */
/* ------------------------------------------------------------------------ */

/**
 * Live tasks, in the local tree and every listed tree, whose `depends_on` or
 * `finishes_after` names a task of `load` for which `targets` holds,
 * qualified and once each, local tree first. Tasks for which `inside` holds
 * are left out: they go wherever the targets go. With `openOnly`, resolved
 * referrers are left out too: an archive blocks only open work.
 */
async function referrersOf(
  context: CommandContext,
  load: LoadedTree,
  targets: (id: string) => boolean,
  inside: (id: string) => boolean = () => false,
  openOnly = false,
): Promise<string[]> {
  const out = new Set<string>();
  for (const site of await context.gates.referenceSites()) {
    if (site.target === null || site.target.tree.key !== load.key) continue;
    if (!targets(site.target.id)) continue;
    if (site.holder.key === load.key && inside(site.task)) continue;
    if (openOnly && !holdsOpenTask(site.holder, site.task)) continue;
    out.add(context.projects.qualify(site.holder, site.task));
  }
  return [...out];
}

/** The `task.md` files that did not parse, across `trees`, as absolute paths. */
function unreadableManifests(trees: LoadedTree[]): string[] {
  return trees.flatMap((load) =>
    load.tree.malformed.map((entry) => entry.path),
  );
}

/** Say on stderr which manifests of the writable trees could not be read. */
async function reportUnreadable(context: CommandContext): Promise<void> {
  const unreadable = unreadableManifests(
    await context.projects.writableTrees(),
  );
  if (unreadable.length === 0) return;
  context.diagnose(
    `${unreadable.length === 1 ? "a manifest" : `${unreadable.length} manifests`} could not be read, so references held there are unknown to this archive: ${unreadable.join(", ")}.`,
  );
}

/* ------------------------------------------------------------------------ */
/* archive                                                                  */
/* ------------------------------------------------------------------------ */

export interface ArchiveOptions {
  /** Archive even though open tasks reference the subtree. */
  force?: boolean;
  /** Say on stderr which manifests could not be read; off when the caller did. */
  reportUnreadable?: boolean;
}

export interface ArchiveResult {
  /** The archived task, qualified for a listed project. */
  id: string;
  /** Absolute path of its directory under `.archive/`. */
  path: string;
  /** The task and every descendant archived with it, in tree order. */
  tasks: string[];
  /** With `--force`: the live tasks whose references now dangle. */
  left_blocked: string[];
}

/**
 * Move a resolved task and its subtree to `.archive/<id>`. Refused while the
 * task is open, while a live descendant is open (or unreadable), when the
 * subtree would be present twice, and — unless forced — while live tasks in
 * this tree or a listed tree reference anything in the subtree. When the
 * destination exists because a descendant was archived earlier, the subtree
 * merges into it. The `archive` entry is logged before the move, so the
 * history travels with the directory; groups the move empties are removed.
 */
export async function archiveTask(
  context: CommandContext,
  load: LoadedTree,
  arg: string,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  return withMutation(context, load, async (fresh) => {
    const { tree } = fresh;
    const qualify = qualifierFor(context, fresh.load);
    const task = resolveTaskArg(tree, arg);
    const shown = qualify(task.id);
    const status = task.frontmatter.status;

    if (!isResolvedTask(task)) {
      throw TaskError.conflict(
        `${shown} is ${status}; only a resolved task is archived. Close it first with \`tasks done\` or \`tasks cancel\`.`,
        { id: shown, kind: "not-resolved", status },
      );
    }

    const descendants = descendantsOf(tree, task.id);
    const open = [
      ...descendants.filter(isOpenTask).map((child) => child.id),
      // Status unknown: it may be open, so it holds the subtree back.
      ...malformedDescendantsOf(tree, task.id).map((entry) => entry.id),
    ]
      .sort(compareIds)
      .map(qualify);
    if (open.length > 0) {
      throw TaskError.conflict(
        `${shown} has open descendants: ${open.join(", ")}. Close or move them first.`,
        { id: shown, kind: "open-descendants", open_descendants: open },
      );
    }

    const destination = archivedTaskDir(tree, task.id);
    // The log entry below creates log.md if the task has none yet.
    const plan = await planMove(task.dir, destination, shown, [LOG_FILENAME]);

    // Overridable last, so a forced retry cannot run into another refusal.
    const dependents = await referrersOf(
      context,
      fresh.load,
      (id) => isWithin(id, task.id),
      (id) => isWithin(id, task.id),
      true,
    );
    // A manifest that does not parse may hold references nobody can see.
    if (options.reportUnreadable !== false) {
      await reportUnreadable(context);
    }
    if (dependents.length > 0 && options.force !== true) {
      const details: DependentsDetails = { id: shown, dependents };
      throw TaskError.conflict(
        `${shown} is referenced by ${dependents.join(", ")}; archived, it would leave them blocked for good. Remove those references first, or pass --force to archive it anyway.`,
        { ...details, kind: "dependents" },
      );
    }

    const forced = dependents.length > 0;
    const logFile = path.join(task.dir, LOG_FILENAME);
    const logged = await sizeOrNull(logFile);
    await appendLogEntry(
      task.dir,
      logEntryFor(context.identity, fresh.now, [
        `archive${forcedSuffix(forced)}`,
        forced ? `left blocked: ${dependents.join(", ")}` : null,
      ]),
    );
    try {
      await executeMove(plan);
    } catch (err) {
      // The entry must not claim an archive that did not happen.
      await rollBackLog(logFile, logged);
      throw err;
    }
    await removeEmptyDirs(task.dir, tree.project.tasksDir);

    return {
      id: shown,
      path: destination,
      tasks: [task.id, ...descendants.map((child) => child.id)].map(qualify),
      left_blocked: forced ? dependents : [],
    };
  });
}

/* ------------------------------------------------------------------------ */
/* archive --resolved-before / --all-resolved                               */
/* ------------------------------------------------------------------------ */

/** A resolved subtree the batch left in place, with the refusal that kept it. */
export interface SkippedResolvedJson {
  id: string;
  /** The refusal's `kind`: `dependents`, `open-descendants`, … */
  reason: string;
  /** The refusal's other details, `dependents` for one. */
  [detail: string]: unknown;
}

export interface ResolvedArchiveJson {
  /** Roots resolved (by `updated`) before this were taken; `null` for all. */
  before: string | null;
  /** What was archived, root by root, in tree order. */
  archived: ArchiveResult[];
  /** Roots that qualified by age but a refusal kept, never forced. */
  skipped: SkippedResolvedJson[];
}

/**
 * The roots of the resolved subtrees of `tree`: resolved tasks whose parent
 * is not resolved, since a resolved parent takes its subtree along. With
 * `before`, only those whose `updated` lies before it.
 */
export function resolvedRoots(tree: Tree, before: string | null): Task[] {
  return tree.tasks.filter((task) => {
    if (!isResolvedTask(task)) return false;
    const parent =
      task.parent === null ? undefined : tree.byId.get(task.parent);
    if (parent !== undefined && isResolvedTask(parent)) return false;
    return before === null || task.frontmatter.updated < before;
  });
}

/**
 * `archive --resolved-before <when>` and `--all-resolved`: every resolved
 * subtree of the local tree whose root was resolved before `before`, each
 * archived as the single command would, under the lock and with its
 * refusals; a refused root is reported as skipped, never forced. The roots
 * come from the tree as it is now; each archive re-reads it.
 */
export async function archiveResolved(
  context: CommandContext,
  before: string | null,
): Promise<ResolvedArchiveJson> {
  await reportUnreadable(context);
  const archived: ArchiveResult[] = [];
  const skipped: SkippedResolvedJson[] = [];
  for (const root of resolvedRoots(context.projects.local.tree, before)) {
    try {
      archived.push(
        await archiveTask(context, context.projects.local, root.id, {
          reportUnreadable: false,
        }),
      );
    } catch (err) {
      const details = isTaskError(err) ? err.details : undefined;
      if (
        !isTaskError(err) ||
        err.code !== "CONFLICT" ||
        details === undefined ||
        typeof details.kind !== "string"
      ) {
        throw err;
      }
      const facts = Object.fromEntries(
        Object.entries(details).filter(
          ([key]) => key !== "kind" && key !== "id",
        ),
      );
      skipped.push({ id: root.id, reason: details.kind, ...facts });
    }
  }
  return { before, archived, skipped };
}

/* ------------------------------------------------------------------------ */
/* restore                                                                  */
/* ------------------------------------------------------------------------ */

export interface RestoreResult {
  /** The restored task's id inside its tree, unqualified. */
  id: string;
  /** Every task restored (the task, then its subtree), qualified. */
  tasks: string[];
}

type KnownStatus = Status | "malformed";

/**
 * The containment rules a restore must not break, for a subtree that merges
 * into what is live at its path. A restored task beneath the root must not
 * land under a live task that is resolved or unreadable (the root's own
 * ancestors are `checkPlacement`'s); and no open task — restored, or live
 * beneath a restored task — may end up under a resolved task, or under a
 * `BACKLOG` one without being `BACKLOG` itself.
 */
function assertRestoredStructure(
  tree: Tree,
  restored: Task[],
  qualify: Qualify,
  shown: string,
): void {
  const restoredById = new Map(restored.map((task) => [task.id, task]));
  const statusAt = (id: string): KnownStatus | null =>
    restoredById.get(id)?.frontmatter.status ??
    tree.byId.get(id)?.frontmatter.status ??
    (tree.malformedById.has(id) ? "malformed" : null);

  for (const task of restored.slice(1)) {
    const parent = ancestorPaths(task.id).find(
      (candidate) =>
        restoredById.has(candidate) || hasLiveTask(tree, candidate),
    );
    if (parent === undefined || restoredById.has(parent)) continue;
    const status = statusAt(parent);
    if (status === "malformed" || (status !== null && isResolved(status))) {
      const what =
        status === "malformed"
          ? "whose task.md is malformed"
          : `which is ${status}`;
      throw TaskError.conflict(
        `Restoring ${shown} would place ${qualify(task.id)} under ${qualify(parent)}, ${what}.`,
        {
          id: shown,
          kind:
            status === "malformed" ? "malformed-ancestor" : "resolved-ancestor",
          task: qualify(task.id),
          ancestor: qualify(parent),
          status: status === "malformed" ? null : status,
        },
      );
    }
  }

  // Open tasks the restore gives new ancestors, with the ancestors to check:
  // a restored task is judged against everything above it, a live one only
  // against the restored tasks it now sits beneath.
  const touched: Array<{ id: string; status: KnownStatus; above: string[] }> =
    [];
  for (const task of restored) {
    if (!isOpenTask(task)) continue;
    touched.push({
      id: task.id,
      status: task.frontmatter.status,
      above: ancestorPaths(task.id),
    });
  }
  const restoredAbove = (id: string) =>
    ancestorPaths(id).filter((candidate) => restoredById.has(candidate));
  for (const live of tree.tasks) {
    const above = restoredAbove(live.id);
    if (above.length > 0 && isOpenTask(live)) {
      touched.push({ id: live.id, status: live.frontmatter.status, above });
    }
  }
  for (const entry of tree.malformed) {
    if (entry.id === "") continue;
    const above = restoredAbove(entry.id);
    // Unknown status: fail safe and treat it as open work.
    if (above.length > 0) {
      touched.push({ id: entry.id, status: "malformed", above });
    }
  }

  for (const open of touched) {
    for (const ancestor of open.above) {
      const status = statusAt(ancestor);
      if (status === null || status === "malformed") continue;
      if (isResolved(status)) {
        throw TaskError.conflict(
          `Restoring ${shown} would leave ${qualify(open.id)} open under ${qualify(ancestor)}, which is ${status}. Move it elsewhere first.`,
          {
            id: shown,
            kind: "open-under-resolved",
            task: qualify(open.id),
            ancestor: qualify(ancestor),
            status,
          },
        );
      }
      if (status === "BACKLOG" && open.status !== "BACKLOG") {
        throw TaskError.conflict(
          `Restoring ${shown} would leave ${qualify(open.id)} under ${qualify(ancestor)}, which is BACKLOG, without being BACKLOG itself.`,
          {
            id: shown,
            kind: "backlog-invariant",
            task: qualify(open.id),
            ancestor: qualify(ancestor),
          },
        );
      }
    }
  }
}

/**
 * Move the archived task at exactly `archivePath` (no suffix resolution:
 * archived tasks are addressed in full) back to the live tree, with its
 * archived subtree. Refused when nothing is archived there, when a live task
 * is at the path, under a resolved or unreadable ancestor, when a task would
 * be present twice, and when the merge would break containment. A group at
 * the path merges with the restored directory and becomes the task again.
 * The `restore` entry is logged after the move.
 */
export async function restoreTask(
  context: CommandContext,
  load: LoadedTree,
  archivePath: string,
): Promise<RestoreResult> {
  return withMutation(context, load, async (fresh) => {
    const { tree } = fresh;
    const qualify = qualifierFor(context, fresh.load);
    const archived = findArchivedTask(tree, archivePath);
    const id = archived.id;
    const shown = qualify(id);

    await checkPlacement(tree, id, { qualify, allowReserved: true });

    const broken = malformedDescendantsOf(tree, id, { archived: true }).map(
      (entry) => entry.id,
    );
    if (broken.length > 0) {
      throw TaskError.conflict(
        `${shown} cannot be restored: archived ${broken.map(qualify).join(", ")} beneath it ${broken.length === 1 ? "has" : "have"} a malformed task.md. Fix ${broken.length === 1 ? "it" : "them"} first.`,
        {
          id: shown,
          kind: "malformed-descendants",
          tasks: broken.map(qualify),
        },
      );
    }

    const restored = [archived, ...descendantsOf(tree, id, { archived: true })];
    const destination = taskDir(tree, id);
    const plan = await planMove(archived.dir, destination, shown);
    assertRestoredStructure(tree, restored, qualify, shown);

    await executeMove(plan);
    await removeEmptyDirs(archived.dir, tree.project.tasksDir);
    await appendLogEntry(
      destination,
      logEntryFor(context.identity, fresh.now, ["restore"]),
    );
    return { id, tasks: restored.map((task) => qualify(task.id)) };
  });
}

/* ------------------------------------------------------------------------ */
/* purge                                                                    */
/* ------------------------------------------------------------------------ */

export interface PurgeResult {
  /** The archive path purged, qualified for a listed project. */
  id: string;
  /** Absolute path of the directory removed. */
  path: string;
  /** The archived tasks removed with it, in tree order. */
  removed: string[];
  /** Live tasks whose references named a removed task. */
  referenced_by: string[];
}

/**
 * Remove the archive entry at exactly `archivePath` for good, with
 * everything beneath it, and release the paths it reserved. A directory
 * there without `task.md` is removable too. Never refused for references:
 * the result names the live tasks that still name a removed task, which a
 * task recreated at that path would now satisfy — purging is that decision.
 */
export async function purgeArchive(
  context: CommandContext,
  load: LoadedTree,
  archivePath: string,
): Promise<PurgeResult> {
  return withMutation(context, load, async (fresh) => {
    const { tree } = fresh;
    const qualify = qualifierFor(context, fresh.load);
    const shown = qualify(archivePath);
    const dir = archivedTaskDir(tree, archivePath);
    if (!(await isDirectory(dir))) {
      throw TaskError.notFound(`Nothing is archived at ${shown}.`, {
        id: shown,
        archived: true,
      });
    }

    const removed = [
      ...tree.archivedById.keys(),
      ...tree.archivedMalformedById.keys(),
    ]
      .filter((id) => isWithin(id, archivePath))
      .sort(compareIds);
    const gone = new Set(removed);
    const referencedBy = await referrersOf(context, fresh.load, (id) =>
      gone.has(id),
    );

    await fs.rm(dir, { recursive: true, force: true });
    await removeEmptyDirs(path.dirname(dir), tree.project.tasksDir);
    return {
      id: shown,
      path: dir,
      removed: removed.map(qualify),
      referenced_by: referencedBy,
    };
  });
}

/* ------------------------------------------------------------------------ */
/* delete                                                                   */
/* ------------------------------------------------------------------------ */

export interface DeleteOptions {
  /** Override authorization; the four conditions are never overridden. */
  force?: boolean;
}

export interface DeleteResult {
  id: string;
  deleted: true;
}

/**
 * True when `log.md` records nothing but the task's creation: no entry, or
 * one entry whose text starts with `new:`, and no text outside entries.
 */
function isCreationOnly(source: string): boolean {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const first = text.split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return true;
  if (parseLogHeading(first.replace(/\r$/, "")) === null) return false;
  const entries = parseLog(text);
  return entries.length === 1 && entries[0]!.text.startsWith("new:");
}

/**
 * Remove a live task that was never worked, without archiving it: allowed
 * only when its log records nothing but its creation, it has no `state.md`,
 * nothing of the tree lies beneath it (no task and no group), and no live
 * task references it. Authorized like a transition. The first condition that
 * fails is the conflict, naming `archive` as the way to remove the task.
 */
export async function deleteTask(
  context: CommandContext,
  load: LoadedTree,
  arg: string,
  options: DeleteOptions = {},
): Promise<DeleteResult> {
  return withMutation(context, load, async (fresh) => {
    const { tree } = fresh;
    const qualify = qualifierFor(context, fresh.load);
    const task = resolveTaskArg(tree, arg);
    const shown = qualify(task.id);

    await authorize(tree, task, context.identity, {
      force: options.force,
      label: shown,
      command: "delete",
    });

    const instead = isResolvedTask(task)
      ? `archive it instead: \`tasks archive ${shown}\``
      : `cancel it and archive it instead: \`tasks cancel ${shown} -m "…"\`, then \`tasks archive ${shown}\``;
    const refuse = (reason: string, details: Record<string, unknown>) =>
      TaskError.conflict(
        `${shown} cannot be deleted: ${reason}. Only a task that was never worked is deleted; ${instead}.`,
        { id: shown, ...details, alternative: "archive" },
      );

    const log = await readFileIfExists(path.join(task.dir, LOG_FILENAME));
    if (log !== null && !isCreationOnly(log)) {
      throw refuse("its log.md records more than its creation", {
        kind: "history",
        entries: parseLog(log).length,
      });
    }
    if (task.workspace.state) {
      throw refuse("it has a state.md", { kind: "present-state" });
    }

    const beneath = [
      ...descendantsOf(tree, task.id).map((child) => child.id),
      ...malformedDescendantsOf(tree, task.id).map((entry) => entry.id),
      ...[...tree.groups].filter((group) => isBelow(group, task.id)),
    ]
      .sort(compareIds)
      .map(qualify);
    if (beneath.length > 0) {
      throw refuse(
        `${beneath.join(", ")} ${beneath.length === 1 ? "lies" : "lie"} beneath it`,
        {
          kind: "descendants",
          descendants: beneath,
        },
      );
    }

    const dependents = await referrersOf(
      context,
      fresh.load,
      (id) => id === task.id,
      (id) => id === task.id,
    );
    if (dependents.length > 0) {
      throw refuse(
        `${dependents.join(", ")} ${dependents.length === 1 ? "references" : "reference"} it`,
        {
          kind: "dependents",
          dependents,
        },
      );
    }

    await fs.rm(task.dir, { recursive: true, force: true });
    await removeEmptyDirs(path.dirname(task.dir), tree.project.tasksDir);
    return { id: shown, deleted: true };
  });
}
