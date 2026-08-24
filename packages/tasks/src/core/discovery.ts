import path from "node:path";

import { TaskError } from "../errors.js";
import { isDirectory } from "./fs-utils.js";

export const TASKS_DIRNAME = ".tasks";

export interface Project {
  /** Directory containing `.tasks/` — the anchor for relative cross-repo refs. */
  root: string;
  /** Absolute path to the `.tasks/` directory itself. */
  tasksDir: string;
}

/**
 * Walk up from `startDir` looking for `.tasks/`, git-style. Nearest wins: the
 * first match is used, with no merging into or fallthrough to a parent tree.
 * This is what makes a nested monorepo package its own task scope.
 */
export async function findProject(startDir: string): Promise<Project | null> {
  let dir = path.resolve(startDir);

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

export async function requireProject(startDir: string): Promise<Project> {
  const project = await findProject(startDir);
  if (!project) {
    throw TaskError.notFound(
      `No ${TASKS_DIRNAME}/ directory found in "${path.resolve(startDir)}" or any parent. Run \`tasks init\` to create one.`,
      { cwd: path.resolve(startDir) },
    );
  }
  return project;
}
