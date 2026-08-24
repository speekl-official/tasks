import { loadConfig } from "./config.js";
import type { DependencyRef } from "./refs.js";
import { parseRef } from "./refs.js";
import type { TaskTree } from "./repo.js";
import { indexById, loadTree, resolveExternalProject } from "./repo.js";
import type { Task } from "./task.js";

export type UnsatisfiedReason =
  | "missing" // no such task in the target tree
  | "archived" // archived tasks never satisfy a dependency
  | "unresolved-project" // cross-repo path absent or has no .tasks/
  | "not-done"; // exists, simply isn't finished yet

export interface DependencyStatus {
  ref: DependencyRef;
  raw: string;
  satisfied: boolean;
  /** Present only when `satisfied` is false. */
  reason?: UnsatisfiedReason;
  /** The dependency's current status, when it could be read at all. */
  status?: string;
}

/**
 * Resolves dependency refs, caching external tree loads for the lifetime of one
 * command so a fan-out of refs into the same repo costs a single read.
 */
export class DependencyResolver {
  private readonly live: Map<string, Task>;
  private readonly archived: Set<string>;
  private readonly externalCache = new Map<string, Promise<ExternalTree | null>>();

  constructor(private readonly tree: TaskTree) {
    this.live = indexById(tree.tasks);
    this.archived = new Set(tree.archived.map((t) => t.id));
  }

  private loadExternal(projectPath: string): Promise<ExternalTree | null> {
    const cached = this.externalCache.get(projectPath);
    if (cached) return cached;

    const promise = (async (): Promise<ExternalTree | null> => {
      const project = await resolveExternalProject(this.tree.project, projectPath);
      if (!project) return null;
      const config = await loadConfig(project.tasksDir);
      const subtree = await loadTree(project);
      return {
        doneStatus: config.roles.done,
        live: indexById(subtree.tasks),
        archived: new Set(subtree.archived.map((t) => t.id)),
      };
    })().catch(() => null);

    this.externalCache.set(projectPath, promise);
    return promise;
  }

  async resolve(raw: string): Promise<DependencyStatus> {
    let ref: DependencyRef;
    try {
      ref = parseRef(raw);
    } catch {
      // A malformed ref can never be satisfied. `tasks validate` reports the
      // parse error itself; readiness queries just treat it as blocking.
      return { ref: { kind: "local", id: raw, raw }, raw, satisfied: false, reason: "missing" };
    }

    if (ref.kind === "local") {
      const task = this.live.get(ref.id);
      if (task) {
        const satisfied = task.status === this.tree.config.roles.done;
        return {
          ref,
          raw,
          satisfied,
          status: task.status,
          ...(satisfied ? {} : { reason: "not-done" as const }),
        };
      }
      if (this.archived.has(ref.id)) {
        return { ref, raw, satisfied: false, reason: "archived" };
      }
      return { ref, raw, satisfied: false, reason: "missing" };
    }

    const external = await this.loadExternal(ref.projectPath);
    if (!external) {
      return { ref, raw, satisfied: false, reason: "unresolved-project" };
    }

    const task = external.live.get(ref.id);
    if (task) {
      // Compared against the *other* project's done role, which may be a
      // different literal status name than this project's.
      const satisfied = task.status === external.doneStatus;
      return {
        ref,
        raw,
        satisfied,
        status: task.status,
        ...(satisfied ? {} : { reason: "not-done" as const }),
      };
    }
    if (external.archived.has(ref.id)) {
      return { ref, raw, satisfied: false, reason: "archived" };
    }
    return { ref, raw, satisfied: false, reason: "missing" };
  }

  async resolveAll(refs: string[]): Promise<DependencyStatus[]> {
    return Promise.all(refs.map((raw) => this.resolve(raw)));
  }

  async isReady(task: Task): Promise<boolean> {
    if (task.depends_on.length === 0) return true;
    const statuses = await this.resolveAll(task.depends_on);
    return statuses.every((s) => s.satisfied);
  }
}

interface ExternalTree {
  doneStatus: string;
  live: Map<string, Task>;
  archived: Set<string>;
}

/** Local-only adjacency; cross-repo refs cannot participate in a local cycle. */
function localEdges(tasks: Task[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const task of tasks) {
    const deps: string[] = [];
    for (const raw of task.depends_on) {
      try {
        const ref = parseRef(raw);
        if (ref.kind === "local") deps.push(ref.id);
      } catch {
        // Malformed refs are reported elsewhere; they form no edge.
      }
    }
    edges.set(task.id, deps);
  }
  return edges;
}

/**
 * Find dependency cycles. Without this check a cycle silently drops every task
 * in it out of `tasks ready` forever — the worst failure mode for an agent that
 * trusts the query.
 */
export function findCycles(tasks: Task[]): string[][] {
  const edges = localEdges(tasks);
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (id: string): void => {
    if (onStack.has(id)) {
      const start = stack.indexOf(id);
      if (start !== -1) cycles.push([...stack.slice(start), id]);
      return;
    }
    if (seen.has(id)) return;

    seen.add(id);
    stack.push(id);
    onStack.add(id);

    for (const next of edges.get(id) ?? []) {
      if (edges.has(next)) visit(next);
    }

    stack.pop();
    onStack.delete(id);
  };

  for (const id of edges.keys()) visit(id);
  return cycles;
}

/** True when adding `depIds` to `taskId` would introduce a cycle. */
export function wouldCreateCycle(tasks: Task[], taskId: string, depIds: string[]): boolean {
  const projected = tasks.map((task) =>
    task.id === taskId ? { ...task, depends_on: [...task.depends_on, ...depIds] } : task,
  );
  return findCycles(projected).length > 0;
}

export function describeUnsatisfied(dep: DependencyStatus): string {
  switch (dep.reason) {
    case "missing":
      return `${dep.raw} (no such task)`;
    case "archived":
      return `${dep.raw} (archived)`;
    case "unresolved-project":
      return `${dep.raw} (project not found)`;
    case "not-done":
      return `${dep.raw} (${dep.status})`;
    default:
      return dep.raw;
  }
}
