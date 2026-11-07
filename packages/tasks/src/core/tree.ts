import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { TaskError, isTaskError } from "../errors.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import type { Project } from "./discovery.js";
import type { ManifestIssue, ParsedTaskFile } from "./frontmatter.js";
import { renderTaskFile, safeParseTaskFile } from "./frontmatter.js";
import { errnoCode, writeFileAtomic } from "./fs-utils.js";
import {
  ancestorPaths,
  compareIds,
  depthOf,
  idToNative,
  isBelow,
  resolveSuffix,
} from "./ids.js";
import type { Task, WorkspacePresence } from "./task.js";
import { makeTask } from "./task.js";
import type { MalformedJson } from "./types.js";
import {
  ARCHIVE_DIRNAME,
  DESIGN_FILENAME,
  LOG_FILENAME,
  PLAN_FILENAME,
  SEGMENT_PATTERN,
  STATE_FILENAME,
  TASK_FILENAME,
} from "./types.js";

/** A `task.md` that could not be read as a manifest. */
export interface Malformed {
  /**
   * The task id it would have. Empty for a `task.md` placed directly in
   * `.tasks/` (or `.archive/`), which no id can name.
   */
  id: string;
  /** Absolute path of the `task.md`. */
  path: string;
  /** Absolute path of its directory. */
  dir: string;
  parent: string | null;
  archived: boolean;
  message: string;
  issues: ManifestIssue[];
}

/**
 * One snapshot of a tree, read from disk in one pass. Nothing caches or
 * refreshes it: a mutation re-reads what it depends on inside the lock.
 */
export interface Tree {
  project: Project;
  config: Config;
  /** Live tasks that parsed, in tree order. */
  tasks: Task[];
  /** Archived tasks that parsed, ids relative to `.archive/`, in tree order. */
  archived: Task[];
  /** Live manifests that did not parse. They still anchor parenthood. */
  malformed: Malformed[];
  /** Archived manifests that did not parse. They still reserve their path. */
  archivedMalformed: Malformed[];
  /** Live matching directories without `task.md`. */
  groups: Set<string>;
  byId: Map<string, Task>;
  archivedById: Map<string, Task>;
  malformedById: Map<string, Malformed>;
  archivedMalformedById: Map<string, Malformed>;
}

/* ------------------------------------------------------------------------ */
/* Scanning                                                                 */
/* ------------------------------------------------------------------------ */

interface ScanResult {
  tasks: Task[];
  malformed: Malformed[];
  groups: string[];
}

/** A directory holding `task.md`, found by the walk, not yet read. */
interface Found {
  id: string;
  dir: string;
  parent: string | null;
  workspace: WorkspacePresence;
}

const WORKSPACE_KEYS: ReadonlyArray<[keyof WorkspacePresence, string]> = [
  ["state", STATE_FILENAME],
  ["design", DESIGN_FILENAME],
  ["plan", PLAN_FILENAME],
  ["log", LOG_FILENAME],
];

/**
 * Manifests read at once. `readFile` holds a descriptor between its open and
 * its reads, so an unbounded fan-out over a wide group could exhaust the
 * process's descriptor limit (256 by default on macOS).
 */
const READ_BATCH = 32;

async function readEntries(dir: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/** Symlinked files count; symlinked directories are never followed. */
async function isFileEntry(dir: string, entry: Dirent): Promise<boolean> {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fs.stat(path.join(dir, entry.name))).isFile();
  } catch {
    return false;
  }
}

async function workspaceOf(
  dir: string,
  entries: Dirent[],
): Promise<WorkspacePresence> {
  const presence: WorkspacePresence = {
    state: false,
    design: false,
    plan: false,
    log: false,
  };
  for (const [key, filename] of WORKSPACE_KEYS) {
    const entry = entries.find((candidate) => candidate.name === filename);
    presence[key] = entry !== undefined && (await isFileEntry(dir, entry));
  }
  return presence;
}

async function readManifest(
  file: string,
): Promise<
  | { ok: true; parsed: ParsedTaskFile }
  | { ok: false; message: string; issues: ManifestIssue[] }
> {
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (err) {
    const message = `task.md cannot be read (${errnoCode(err) ?? String(err)})`;
    return { ok: false, message, issues: [{ field: null, message }] };
  }
  const parsed = safeParseTaskFile(source);
  return parsed.ok ? { ok: true, parsed } : parsed;
}

const ROOT_MANIFEST_MESSAGE =
  "task.md directly under the tree root is not a task: a task is a directory under .tasks/ that contains task.md";

/**
 * The segment rule: descend into every directory whose name matches the
 * segment pattern (which also excludes every dot-directory), never into
 * anything else. A directory holding `task.md` is a task and becomes the
 * parent of every task beneath it, whether its manifest parses or not, so
 * parenthood needs no manifest read.
 */
async function walk(
  dir: string,
  id: string,
  parent: string | null,
  found: Found[],
  groups: string[],
  rootManifests: string[],
): Promise<void> {
  const entries = await readEntries(dir);
  if (entries === null) return;

  let anchor = parent;
  const manifest = entries.find((entry) => entry.name === TASK_FILENAME);
  if (manifest !== undefined && (await isFileEntry(dir, manifest))) {
    if (id === "") {
      rootManifests.push(path.join(dir, TASK_FILENAME));
    } else {
      found.push({
        id,
        dir,
        parent,
        workspace: await workspaceOf(dir, entries),
      });
      anchor = id;
    }
  } else if (id !== "") {
    groups.push(id);
  }

  await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && SEGMENT_PATTERN.test(entry.name),
      )
      .map((entry) =>
        walk(
          path.join(dir, entry.name),
          id === "" ? entry.name : `${id}/${entry.name}`,
          anchor,
          found,
          groups,
          rootManifests,
        ),
      ),
  );
}

async function scan(baseDir: string, archived: boolean): Promise<ScanResult> {
  const found: Found[] = [];
  const groups: string[] = [];
  const rootManifests: string[] = [];
  await walk(baseDir, "", null, found, groups, rootManifests);

  const out: ScanResult = { tasks: [], malformed: [], groups };
  for (const file of rootManifests) {
    out.malformed.push({
      id: "",
      path: file,
      dir: path.dirname(file),
      parent: null,
      archived,
      message: ROOT_MANIFEST_MESSAGE,
      issues: [{ field: null, message: ROOT_MANIFEST_MESSAGE }],
    });
  }

  for (let start = 0; start < found.length; start += READ_BATCH) {
    const batch = found.slice(start, start + READ_BATCH);
    const reads = await Promise.all(
      batch.map((entry) => readManifest(path.join(entry.dir, TASK_FILENAME))),
    );
    batch.forEach((entry, index) => {
      const read = reads[index]!;
      if (read.ok) {
        out.tasks.push(
          makeTask({
            id: entry.id,
            dir: entry.dir,
            archived,
            parent: entry.parent,
            frontmatter: read.parsed.frontmatter,
            extra: read.parsed.extra,
            body: read.parsed.body,
            workspace: entry.workspace,
          }),
        );
      } else {
        out.malformed.push({
          id: entry.id,
          path: path.join(entry.dir, TASK_FILENAME),
          dir: entry.dir,
          parent: entry.parent,
          archived,
          message: read.message,
          issues: read.issues,
        });
      }
    });
  }

  out.tasks.sort((a, b) => compareIds(a.id, b.id));
  out.malformed.sort((a, b) => compareIds(a.id, b.id));
  out.groups.sort(compareIds);
  return out;
}

export interface LoadTreeOptions {
  /** A configuration already loaded for this tree, to skip reading it twice. */
  config?: Config;
}

/** Read the whole tree: configuration, live tasks, archive. */
export async function loadTree(
  project: Project,
  options: LoadTreeOptions = {},
): Promise<Tree> {
  const config = options.config ?? (await loadConfig(project.tasksDir));
  const [live, archive] = await Promise.all([
    scan(project.tasksDir, false),
    scan(path.join(project.tasksDir, ARCHIVE_DIRNAME), true),
  ]);

  const named = (list: Malformed[]) => list.filter((entry) => entry.id !== "");
  return {
    project,
    config,
    tasks: live.tasks,
    archived: archive.tasks,
    malformed: live.malformed,
    archivedMalformed: archive.malformed,
    groups: new Set(live.groups),
    byId: new Map(live.tasks.map((task) => [task.id, task])),
    archivedById: new Map(archive.tasks.map((task) => [task.id, task])),
    malformedById: new Map(named(live.malformed).map((m) => [m.id, m])),
    archivedMalformedById: new Map(
      named(archive.malformed).map((m) => [m.id, m]),
    ),
  };
}

/* ------------------------------------------------------------------------ */
/* Paths                                                                    */
/* ------------------------------------------------------------------------ */

export function archiveRoot(tree: Tree): string {
  return path.join(tree.project.tasksDir, ARCHIVE_DIRNAME);
}

/** Where the live task `id` lives, or would live. */
export function taskDir(tree: Tree, id: string): string {
  return idToNative(tree.project.tasksDir, id);
}

/** Where the archived task `id` lives, or would live. */
export function archivedTaskDir(tree: Tree, id: string): string {
  return idToNative(archiveRoot(tree), id);
}

/* ------------------------------------------------------------------------ */
/* Reading and writing one task                                             */
/* ------------------------------------------------------------------------ */

function malformedError(entry: {
  id: string;
  path: string;
  message: string;
}): TaskError {
  return TaskError.conflict(
    `${entry.id} has a malformed task.md: ${entry.message}. Fix ${entry.path} by hand first.`,
    {
      id: entry.id,
      kind: "malformed",
      path: entry.path,
      message: entry.message,
    },
  );
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** The nearest ancestor directory holding a `task.md`, as on disk now. */
async function nearestTaskOnDisk(
  base: string,
  id: string,
): Promise<string | null> {
  for (const candidate of ancestorPaths(id)) {
    if (await isFile(path.join(idToNative(base, candidate), TASK_FILENAME))) {
      return candidate;
    }
  }
  return null;
}

export interface ReloadOptions {
  /** Read the task under `.archive/` instead of the live tree. */
  archived?: boolean;
}

/**
 * Re-read one task from disk, parent and workspace included. Meant for use
 * inside the tree lock, where anything read before acquiring it is stale.
 * The snapshot is not modified.
 */
export async function reloadTask(
  tree: Tree,
  id: string,
  options: ReloadOptions = {},
): Promise<Task> {
  const archived = options.archived ?? false;
  const base = archived ? archiveRoot(tree) : tree.project.tasksDir;
  const dir = idToNative(base, id);
  const file = path.join(dir, TASK_FILENAME);

  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      throw TaskError.notFound(`No task "${id}".`, {
        id,
        ...(archived ? { archived: true } : {}),
      });
    }
    throw err;
  }

  const parsed = safeParseTaskFile(source);
  if (!parsed.ok) {
    throw malformedError({ id, path: file, message: parsed.message });
  }
  return makeTask({
    id,
    dir,
    archived,
    parent: await nearestTaskOnDisk(base, id),
    frontmatter: parsed.frontmatter,
    extra: parsed.extra,
    body: parsed.body,
    workspace: await workspaceOf(dir, (await readEntries(dir)) ?? []),
  });
}

/** Write the manifest atomically and canonically; groups appear on demand. */
export async function writeTask(task: Task): Promise<void> {
  await writeFileAtomic(
    task.file,
    renderTaskFile(task.frontmatter, task.extra, task.body),
  );
}

/* ------------------------------------------------------------------------ */
/* Lookup                                                                   */
/* ------------------------------------------------------------------------ */

/** A live task (parsed or malformed) exists at `id`. */
export function hasLiveTask(tree: Tree, id: string): boolean {
  return tree.byId.has(id) || tree.malformedById.has(id);
}

/** `.archive/` holds a `task.md` at `id`, which reserves the path. */
export function isReservedPath(tree: Tree, id: string): boolean {
  return tree.archivedById.has(id) || tree.archivedMalformedById.has(id);
}

/** A live matching directory without `task.md`. */
export function isGroup(tree: Tree, id: string): boolean {
  return tree.groups.has(id);
}

/**
 * The live task at exactly `id`. A malformed manifest is a conflict (it must
 * be fixed by hand); a path that exists only in `.archive/` is not found,
 * with `details.archived`.
 */
export function findTask(tree: Tree, id: string): Task {
  const task = tree.byId.get(id);
  if (task) return task;
  const broken = tree.malformedById.get(id);
  if (broken) throw malformedError(broken);
  if (isReservedPath(tree, id)) {
    throw TaskError.notFound(
      `${id} is archived. Restore it with \`tasks restore ${id}\` first.`,
      { id, archived: true },
    );
  }
  throw TaskError.notFound(`No task "${id}".`, { id });
}

/** The archived task at exactly `id`. */
export function findArchivedTask(tree: Tree, id: string): Task {
  const task = tree.archivedById.get(id);
  if (task) return task;
  const broken = tree.archivedMalformedById.get(id);
  if (broken) throw malformedError(broken);
  throw TaskError.notFound(`No archived task "${id}".`, {
    id,
    archived: true,
  });
}

export interface ResolveTaskIdOptions {
  /** The argument as the user typed it, for messages; `arg` by default. */
  argument?: string;
  /** How messages name ids: qualified by the alias of a listed project. */
  qualify?: (id: string) => string;
}

/**
 * Resolve a command-line path over the live tree by the suffix rule. When it
 * matches nothing live but names an archived task, the not-found error says
 * so (`details.archived`).
 */
export function resolveTaskId(
  tree: Tree,
  arg: string,
  options: ResolveTaskIdOptions = {},
): string {
  const argument = options.argument ?? arg;
  const qualify = options.qualify ?? ((id: string) => id);
  try {
    return resolveSuffix(
      arg,
      [...tree.byId.keys(), ...tree.malformedById.keys()],
      { argument, qualify },
    );
  } catch (err) {
    if (!isTaskError(err) || err.code !== "NOT_FOUND") throw err;
    let archived: string | null = null;
    try {
      archived = resolveSuffix(arg, [
        ...tree.archivedById.keys(),
        ...tree.archivedMalformedById.keys(),
      ]);
    } catch {
      // Nothing (or several things) archived either: the original stands.
    }
    if (archived === null) throw err;
    const shown = qualify(archived);
    throw TaskError.notFound(
      `${shown} is archived. Restore it with \`tasks restore ${shown}\` first.`,
      { argument, id: shown, archived: true },
    );
  }
}

/** `resolveTaskId`, then the task itself. */
export function resolveTaskArg(tree: Tree, arg: string): Task {
  return findTask(tree, resolveTaskId(tree, arg));
}

/* ------------------------------------------------------------------------ */
/* Containment                                                              */
/* ------------------------------------------------------------------------ */

export interface ContainmentOptions {
  /** Walk the archive instead of the live tree. */
  archived?: boolean;
}

function tasksOf(tree: Tree, options: ContainmentOptions): Task[] {
  return options.archived ? tree.archived : tree.tasks;
}

function hasTaskAt(tree: Tree, id: string, options: ContainmentOptions) {
  return options.archived ? isReservedPath(tree, id) : hasLiveTask(tree, id);
}

/** Parsed tasks whose parent is `id` (`null`: the top-level tasks). */
export function childrenOf(
  tree: Tree,
  id: string | null,
  options: ContainmentOptions = {},
): Task[] {
  return tasksOf(tree, options).filter((task) => task.parent === id);
}

/** Malformed manifests whose parent is `id`: children of unknown status. */
export function malformedChildrenOf(
  tree: Tree,
  id: string | null,
  options: ContainmentOptions = {},
): Malformed[] {
  const list = options.archived ? tree.archivedMalformed : tree.malformed;
  return list.filter((entry) => entry.id !== "" && entry.parent === id);
}

export interface DescendantsOptions extends ContainmentOptions {
  /** Deepest first, the order in which a cascade writes. */
  deepestFirst?: boolean;
}

/** Parsed tasks strictly beneath `id`, in tree order or deepest first. */
export function descendantsOf(
  tree: Tree,
  id: string,
  options: DescendantsOptions = {},
): Task[] {
  const found = tasksOf(tree, options).filter((task) => isBelow(task.id, id));
  if (options.deepestFirst) {
    found.sort(
      (a, b) => depthOf(b.id) - depthOf(a.id) || compareIds(a.id, b.id),
    );
  }
  return found;
}

/** Malformed manifests strictly beneath `id`. */
export function malformedDescendantsOf(
  tree: Tree,
  id: string,
  options: ContainmentOptions = {},
): Malformed[] {
  const list = options.archived ? tree.archivedMalformed : tree.malformed;
  return list.filter((entry) => isBelow(entry.id, id));
}

/**
 * Ids of every ancestor task of the path `id`, nearest first, malformed ones
 * included. Works for a path that is not (yet) a task.
 */
export function ancestorIdsOf(
  tree: Tree,
  id: string,
  options: ContainmentOptions = {},
): string[] {
  return ancestorPaths(id).filter((candidate) =>
    hasTaskAt(tree, candidate, options),
  );
}

/**
 * Parsed ancestor tasks, nearest first. A malformed ancestor has no parsed
 * state and is left out; `malformedAncestorOf` reports it, so a rule that
 * depends on ancestors can fail safe.
 */
export function ancestorsOf(
  tree: Tree,
  id: string,
  options: ContainmentOptions = {},
): Task[] {
  const index = options.archived ? tree.archivedById : tree.byId;
  return ancestorIdsOf(tree, id, options).flatMap((candidate) => {
    const task = index.get(candidate);
    return task ? [task] : [];
  });
}

/** The nearest malformed ancestor of the path `id`, or `null`. */
export function malformedAncestorOf(
  tree: Tree,
  id: string,
  options: ContainmentOptions = {},
): Malformed | null {
  const index = options.archived
    ? tree.archivedMalformedById
    : tree.malformedById;
  for (const candidate of ancestorPaths(id)) {
    const entry = index.get(candidate);
    if (entry) return entry;
  }
  return null;
}

/** The task that would be the parent of a task placed at `id`, or `null`. */
export function parentForPath(
  tree: Tree,
  id: string,
  options: ContainmentOptions = {},
): string | null {
  return ancestorIdsOf(tree, id, options)[0] ?? null;
}

export function toMalformedJson(entry: Malformed): MalformedJson {
  return { path: entry.path, message: entry.message };
}
