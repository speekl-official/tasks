import { requireProject } from "./core/discovery.js";
import type { TaskTree } from "./core/repo.js";
import { loadTree } from "./core/repo.js";
import type { Task } from "./core/task.js";
import { TaskError } from "./errors.js";

export interface ScopeOptions {
  phase?: string;
  all?: boolean;
}

export async function openTree(cwd: string = process.cwd()): Promise<TaskTree> {
  const project = await requireProject(cwd);
  return loadTree(project);
}

/**
 * Resolve which phase a query is scoped to.
 *
 * `--phase` wins, then `--all` (no scope), then `active_phase` from config.
 * `list` and `ready` share this so their defaults can't drift apart.
 */
export function resolveScope(tree: TaskTree, options: ScopeOptions): string | null {
  if (options.phase) return options.phase;
  if (options.all) return null;
  return tree.config.activePhase ?? null;
}

export function scopeTasks(tree: TaskTree, options: ScopeOptions): Task[] {
  const phase = resolveScope(tree, options);
  const tasks = phase ? tree.tasks.filter((t) => t.phase === phase) : tree.tasks;
  return [...tasks].sort((a, b) => a.phase.localeCompare(b.phase) || a.id.localeCompare(b.id));
}

export function assertKnownStatus(tree: TaskTree, status: string): void {
  if (!tree.config.isValidStatus(status)) {
    throw TaskError.usage(
      `Unknown status "${status}". Configured statuses: ${tree.config.statuses.join(", ")}.`,
      { status, statuses: tree.config.statuses },
    );
  }
}

/** Identity recorded on claim. Explicit flag wins, then env, then a fallback. */
export function defaultActor(): string {
  return (
    process.env.TASKS_ACTOR ||
    process.env.USER ||
    process.env.USERNAME ||
    "unknown"
  );
}
