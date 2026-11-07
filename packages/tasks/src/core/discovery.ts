import path from "node:path";

import { TaskError } from "../errors.js";
import { isDirectory } from "./fs-utils.js";
import { TASKS_DIRNAME } from "./types.js";

export interface Project {
  /** Directory containing `.tasks/`: the anchor for relative references. */
  root: string;
  /** Absolute path of the `.tasks/` directory itself. */
  tasksDir: string;
}

/**
 * Walk up from `startDir` looking for `.tasks/`, git-style. Nearest wins: the
 * first match is the tree, with no merging into or fallthrough to a tree
 * further up, which is what makes a nested package its own scope.
 *
 * A start directory that does not exist finds nothing rather than walking up
 * from where it would be: a reference to a sibling repository that is not
 * checked out must not resolve to some unrelated tree above it.
 */
export async function findProject(startDir: string): Promise<Project | null> {
  let dir = path.resolve(startDir);
  if (!(await isDirectory(dir))) return null;

  for (;;) {
    const candidate = path.join(dir, TASKS_DIRNAME);
    if (await isDirectory(candidate)) {
      return { root: dir, tasksDir: candidate };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `startDir` is where discovery begins: the cwd, or the CLI's `-C <dir>`. */
export async function requireProject(startDir: string): Promise<Project> {
  const project = await findProject(startDir);
  if (!project) {
    const cwd = path.resolve(startDir);
    const where = (await isDirectory(cwd))
      ? `in "${cwd}" or any parent`
      : `because "${cwd}" is not a directory`;
    throw TaskError.notFound(
      `No ${TASKS_DIRNAME}/ directory found ${where}. Run \`tasks init\` to create one.`,
      { cwd },
    );
  }
  return project;
}
