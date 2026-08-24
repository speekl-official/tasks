import { withTaskLock } from "./lock.js";
import type { TaskTree } from "./repo.js";
import { findTask, reloadTask, writeTask } from "./repo.js";
import type { Task } from "./task.js";
import { nowIso } from "./task.js";

/**
 * Apply a change to one task under its exclusive lock.
 *
 * The task is re-read from disk *inside* the lock, because whatever the caller
 * loaded beforehand may have been changed by a concurrent process. `mutator`
 * receives that fresh copy and returns the updated task; `updated` is stamped
 * automatically.
 */
export async function mutateTask(
  tree: TaskTree,
  id: string,
  mutator: (task: Task) => Task | Promise<Task>,
): Promise<Task> {
  const located = findTask(tree, id);

  return withTaskLock(tree.project.tasksDir, id, async () => {
    const fresh = await reloadTask(located.filePath, located.archived);
    const next = await mutator(fresh);
    const stamped: Task = { ...next, updated: nowIso() };
    await writeTask(stamped);
    return stamped;
  });
}
