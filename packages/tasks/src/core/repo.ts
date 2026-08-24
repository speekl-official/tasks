import fs from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import { TaskError } from "../errors.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import type { Project } from "./discovery.js";
import { findProject } from "./discovery.js";
import { writeFileAtomic } from "./fs-utils.js";
import type { Frontmatter } from "./frontmatter.js";
import {
  frontmatterSchema,
  renderTaskFile,
  splitTaskFile,
} from "./frontmatter.js";
import { LOCKS_DIRNAME } from "./lock.js";
import type { Task } from "./task.js";

export const ARCHIVE_DIRNAME = ".archive";
export const INDEX_FILENAME = "_index.md";
export const README_FILENAME = "README.md";

/** Directories under `.tasks/` that never hold live tasks. */
export const RESERVED_DIRS: ReadonlySet<string> = new Set([
  ARCHIVE_DIRNAME,
  LOCKS_DIRNAME,
]);

export interface MalformedTask {
  filePath: string;
  reason: string;
}

export interface TaskTree {
  project: Project;
  config: Config;
  /** Live tasks, excluding `.archive/`. */
  tasks: Task[];
  /** Archived tasks — ids stay reserved, but they never satisfy dependencies. */
  archived: Task[];
  /** Files that could not be parsed; surfaced by `tasks validate`. */
  malformed: MalformedTask[];
}

function toTask(
  filePath: string,
  source: string,
  archived: boolean,
): { task: Task } | { error: string } {
  let split;
  try {
    split = splitTaskFile(source);
  } catch (err) {
    return { error: `invalid frontmatter YAML — ${(err as Error).message}` };
  }

  const parsed = frontmatterSchema.safeParse(split.data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { error: `invalid frontmatter — ${issues}` };
  }

  const fm = parsed.data;
  const directoryPhase = path.basename(path.dirname(filePath));

  return {
    task: {
      id: fm.id,
      // The directory is authoritative for phase; frontmatter merely mirrors it.
      phase: archived ? fm.phase : directoryPhase,
      status: fm.status,
      depends_on: fm.depends_on,
      created: fm.created,
      updated: fm.updated,
      claimed_by: fm.claimed_by,
      claimed_at: fm.claimed_at,
      body: split.body,
      filePath,
      archived,
      frontmatterPhase: fm.phase,
      filenameId: path.basename(filePath, ".md"),
    },
  };
}

async function readTasksIn(patterns: string[], cwd: string, archived: boolean) {
  const matches = await fg(patterns, {
    cwd,
    absolute: true,
    dot: archived,
    onlyFiles: true,
  });
  // fast-glob always returns posix separators, even on Windows. Normalize to
  // native ones so a task's filePath compares equal to `taskFilePath()` — the
  // `--fix` path in `tasks validate` deletes the old file when they differ.
  const files = matches.map((file) => path.normalize(file));
  files.sort();

  const tasks: Task[] = [];
  const malformed: MalformedTask[] = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const result = toTask(filePath, source, archived);
    if ("task" in result) tasks.push(result.task);
    else malformed.push({ filePath, reason: result.error });
  }

  return { tasks, malformed };
}

export async function loadTree(project: Project): Promise<TaskTree> {
  const config = await loadConfig(project.tasksDir);

  // `dot: false` already excludes .archive/ and .locks/ from the live scan, and
  // `*/*.md` keeps root files like _index.md and README.md out of the results.
  const live = await readTasksIn(["*/*.md"], project.tasksDir, false);
  const archive = await readTasksIn(
    [`${ARCHIVE_DIRNAME}/*.md`],
    project.tasksDir,
    true,
  );

  return {
    project,
    config,
    tasks: live.tasks,
    archived: archive.tasks,
    malformed: [...live.malformed, ...archive.malformed],
  };
}

export function indexById(tasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const task of tasks) {
    if (!map.has(task.id)) map.set(task.id, task);
  }
  return map;
}

export function findTask(tree: TaskTree, id: string): Task {
  const task = tree.tasks.find((t) => t.id === id);
  if (task) return task;

  const archived = tree.archived.find((t) => t.id === id);
  if (archived) {
    throw TaskError.notFound(
      `Task "${id}" is archived. Restore it from ${ARCHIVE_DIRNAME}/ before modifying it.`,
      { id, archived: true },
    );
  }

  throw TaskError.notFound(`No task with id "${id}".`, { id });
}

export function toFrontmatter(task: Task): Frontmatter {
  return {
    id: task.id,
    phase: task.phase,
    status: task.status,
    depends_on: task.depends_on,
    created: task.created,
    updated: task.updated,
    claimed_by: task.claimed_by,
    claimed_at: task.claimed_at,
  };
}

export async function writeTask(task: Task): Promise<void> {
  await writeFileAtomic(
    task.filePath,
    renderTaskFile(toFrontmatter(task), task.body),
  );
}

/**
 * Re-read a single task from disk. Used inside the lock, where any state read
 * before acquiring it must be treated as stale.
 */
export async function reloadTask(
  filePath: string,
  archived = false,
): Promise<Task> {
  const source = await fs.readFile(filePath, "utf8");
  const result = toTask(filePath, source, archived);
  if ("error" in result) {
    throw TaskError.internal(`Cannot read ${filePath}: ${result.error}`);
  }
  return result.task;
}

export function taskFilePath(
  project: Project,
  phase: string,
  id: string,
): string {
  return path.join(project.tasksDir, phase, `${id}.md`);
}

export async function listPhases(project: Project): Promise<string[]> {
  const entries = await fs.readdir(project.tasksDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** Resolve another project's tree for a cross-repo dependency ref. */
export async function resolveExternalProject(
  project: Project,
  projectPath: string,
): Promise<Project | null> {
  const absolute = path.resolve(project.root, projectPath);
  return findProject(absolute);
}
