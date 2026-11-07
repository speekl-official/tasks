import { TaskError } from "../errors.js";
import {
  compareIds,
  isBelow,
  parseReference,
  qualifyId,
  safeParseReference,
} from "./ids.js";
import type { LoadedTree, Projects, UnavailableTree } from "./projects.js";
import type { Task } from "./task.js";
import type { Tree } from "./tree.js";
import {
  ancestorIdsOf,
  childrenOf,
  hasLiveTask,
  malformedChildrenOf,
} from "./tree.js";
import type {
  BlockedByJson,
  FinishGate,
  GateField,
  GateReason,
  ResolvedRef,
  StartGate,
  Status,
} from "./types.js";
import { isOpen } from "./types.js";

/**
 * Gate resolution over one or more trees: what each stored reference points
 * at and why it does not satisfy, the start and finish gates built from
 * those answers, who references a task, and the cycles of the combined gate
 * graph. Fail safe throughout: anything that cannot be resolved confidently
 * is unsatisfied, and a reference that does not parse never aborts a query.
 */

export type { GateField } from "./types.js";

export const GATE_FIELDS: readonly GateField[] = [
  "depends_on",
  "finishes_after",
];

/**
 * Reasons that waiting cannot clear: the reference needs a person to act on
 * it. Validation warns about these; `not-done` is ordinary waiting, and a
 * `malformed` target is reported as an error on the target itself.
 */
export const UNSATISFIABLE_REASONS: readonly GateReason[] = [
  "cancelled",
  "missing",
  "archived",
  "unresolved-project",
  "not-checked-out",
  "unsupported-version",
];

/** The gate reason a tree that did not load gives every reference into it. */
export function unavailableReason(load: UnavailableTree): GateReason {
  switch (load.kind) {
    case "not-checked-out":
      return "not-checked-out";
    case "unresolved":
      return "unresolved-project";
    case "unsupported-version":
      return "unsupported-version";
  }
}

/** Whether the task `id` of `holder` is open: only open work is stranded. */
export function holdsOpenTask(holder: LoadedTree, id: string): boolean {
  const task = holder.tree.byId.get(id);
  return task !== undefined && isOpen(task.frontmatter.status);
}

/** One reference stored in a live task, resolved. */
export interface ReferenceSite {
  /** The tree that stores the reference. */
  holder: LoadedTree;
  /** The id of the task storing it, inside the holder's tree. */
  task: string;
  field: GateField;
  /** The stored form. */
  ref: string;
  /** Start-gate semantics, as `resolveRef` returns it. */
  resolved: ResolvedRef;
  /**
   * The tree and id the reference names whenever that tree loaded, whether
   * or not a task is there (missing, archived and malformed targets
   * included); `null` for a reference that does not parse or that leads
   * into a tree that is unavailable.
   */
  target: { tree: LoadedTree; id: string } | null;
}

/** Where a reference leads, independent of any status: what is cached. */
type Address =
  | { kind: "unparseable" }
  | { kind: "unavailable"; reason: GateReason; project: string; id: string }
  | { kind: "tree"; tree: LoadedTree; id: string; project: string | null };

interface Resolution {
  resolved: ResolvedRef;
  target: { tree: LoadedTree; id: string } | null;
}

interface GraphNode {
  key: string;
  tree: LoadedTree;
  id: string;
}

/** State of one graph walk: the snapshot it started from, and indexes. */
interface GraphContext {
  root: LoadedTree;
  children: Map<string, Map<string, string[]>>;
}

/** Above this many cycles, `findCycles` stops looking for more. */
const MAX_CYCLES = 100;

/** Edge visits allowed to the cycle enumeration of one `findCycles`. */
const SEARCH_BUDGET = 100_000;

const VERBS: Record<GateField, string> = {
  depends_on: "depend on",
  finishes_after: "finish after",
};

export class GateResolver {
  private readonly projects: Projects;
  /**
   * Where each stored reference leads, per (holder, reference). Statuses are
   * not cached: they are read from the latest snapshot on every call, so a
   * `Projects.reload` after a write is seen at once.
   */
  private readonly addresses = new Map<string, Promise<Address>>();

  constructor(projects: Projects) {
    this.projects = projects;
  }

  /**
   * Resolve one stored reference held by `holder`, with start-gate
   * semantics: satisfied by a live `DONE` task only. `project` is from the
   * local tree's point of view: `null` for the local tree, the alias of a
   * listed tree, otherwise the stored project path.
   */
  async resolveRef(holder: LoadedTree, ref: string): Promise<ResolvedRef> {
    return (await this.resolution(holder, ref)).resolved;
  }

  async resolveRefs(
    holder: LoadedTree,
    refs: string[],
  ): Promise<ResolvedRef[]> {
    return Promise.all(refs.map((ref) => this.resolveRef(holder, ref)));
  }

  /** Satisfied when every `depends_on` reference is a live `DONE` task. */
  async startGate(holder: LoadedTree, task: Task): Promise<StartGate> {
    const refs = await this.resolveRefs(holder, task.frontmatter.depends_on);
    return { satisfied: refs.every((ref) => ref.satisfied), refs };
  }

  /**
   * Satisfied when no live child is open and every `finishes_after`
   * reference is a live resolved task. Its `refs` follow finish semantics: a
   * `CANCELLED` target is satisfied, with reason `null`, where `resolveRef`
   * reports it as `cancelled`. A malformed child counts as open, since its
   * status cannot be known.
   */
  async finishGate(holder: LoadedTree, task: Task): Promise<FinishGate> {
    const tree = holder.tree;
    const open = [
      ...childrenOf(tree, task.id)
        .filter((child) => isOpen(child.frontmatter.status))
        .map((child) => child.id),
      ...malformedChildrenOf(tree, task.id).map((child) => child.id),
    ].sort(compareIds);
    return this.finishGateWith(holder, task, open);
  }

  /** Both gates for every live, parsed task of a tree, keyed by its id. */
  async gatesForTree(
    holder: LoadedTree,
  ): Promise<Map<string, { start: StartGate; finish: FinishGate }>> {
    const open = childIndex(holder.tree, true);
    const entries = await Promise.all(
      holder.tree.tasks.map(async (task) => {
        const [start, finish] = await Promise.all([
          this.startGate(holder, task),
          this.finishGateWith(holder, task, open.get(task.id) ?? []),
        ]);
        return [task.id, { start, finish }] as const;
      }),
    );
    return new Map(entries);
  }

  /**
   * Every reference stored in the live, parsed tasks of `trees` — by default
   * the local tree and every listed tree that loaded — resolved, in tree
   * order, then task order, then field and stored order.
   */
  async referenceSites(trees?: LoadedTree[]): Promise<ReferenceSite[]> {
    const holders = trees ?? (await this.projects.writableTrees());
    const sites: ReferenceSite[] = [];
    for (const holder of holders) {
      for (const task of holder.tree.tasks) {
        for (const field of GATE_FIELDS) {
          for (const ref of task.frontmatter[field]) {
            const { resolved, target } = await this.resolution(holder, ref);
            sites.push({ holder, task: task.id, field, ref, resolved, target });
          }
        }
      }
    }
    return sites;
  }

  /**
   * Live tasks of the local tree and of every listed tree whose `depends_on`
   * or `finishes_after` resolves to `targetId` in `targetTree`, qualified,
   * local tree first, then listed trees in configuration order. A tree
   * reached only by a bare path is never searched: nothing lists it.
   */
  async referencedBy(
    targetTree: LoadedTree,
    targetId: string,
  ): Promise<string[]> {
    const out = new Set<string>();
    for (const site of await this.referenceSites()) {
      if (
        site.target !== null &&
        site.target.tree.key === targetTree.key &&
        site.target.id === targetId
      ) {
        out.add(this.projects.qualify(site.holder, site.task));
      }
    }
    return [...out];
  }

  /**
   * The open tasks whose `depends_on` names any of `targets` — what `cancel`
   * reports as `dependents` — once each, in the order of `referencedBy`.
   * The targets themselves are left out: the command that cancels them has
   * decided their fate already, so one depending on another is no news.
   */
  async dependentsOf(
    targets: Array<{ tree: LoadedTree; id: string }>,
  ): Promise<string[]> {
    const wanted = new Set(
      targets.map((target) => nodeKey(target.tree.key, target.id)),
    );
    const out = new Set<string>();
    for (const site of await this.referenceSites()) {
      if (site.field !== "depends_on" || site.target === null) continue;
      // A resolved holder has nothing left to decide; validation speaks for
      // it if it is reopened.
      if (!holdsOpenTask(site.holder, site.task)) continue;
      if (!wanted.has(nodeKey(site.target.tree.key, site.target.id))) continue;
      if (wanted.has(nodeKey(site.holder.key, site.task))) continue;
      out.add(this.projects.qualify(site.holder, site.task));
    }
    return [...out];
  }

  /**
   * The refusals of dependency editing, for `ref` in the stored form it
   * would take in `task`'s manifest. A reference that does not parse and a
   * self-reference are usage errors; a target that is not a live task
   * (missing, archived, malformed, in an unavailable tree) is not found,
   * with the reason; a reference to the task's own ancestor or one that
   * closes a cycle is a conflict.
   */
  async checkDependencyEdit(
    holder: LoadedTree,
    task: Task,
    field: GateField,
    ref: string,
  ): Promise<void> {
    assertGateField(field);
    parseReference(ref);
    const id = this.projects.qualify(holder, task.id);
    const { resolved, target } = await this.resolution(holder, ref);
    const sameTree = target !== null && target.tree.key === holder.key;

    if (sameTree && target.id === task.id) {
      throw TaskError.usage(`${id} cannot ${VERBS[field]} itself.`, {
        id,
        field,
        ref,
      });
    }

    if (resolved.reason !== null && !EXISTING.has(resolved.reason)) {
      throw TaskError.notFound(
        `${id} cannot ${VERBS[field]} ${ref}: ${reasonText(resolved)}.`,
        { id, field, ref, reason: resolved.reason },
      );
    }

    if (sameTree && isBelow(task.id, target.id)) {
      const ancestor = this.projects.qualify(holder, target.id);
      throw TaskError.conflict(
        `${id} cannot ${VERBS[field]} ${ref}: ${ancestor} is its ancestor, which is done only after it, so neither could ever finish.`,
        { id, field, ref, kind: "ancestor", ancestor },
      );
    }

    const cycle = await this.wouldCreateCycle(holder, task.id, field, ref);
    if (cycle !== null) {
      throw TaskError.conflict(
        `Adding ${ref} to the ${field} of ${id} would close a cycle: ${[...cycle, cycle[0]].join(" → ")}.`,
        { id, field, ref, kind: "cycle", cycle },
      );
    }
  }

  /**
   * Whether adding `ref` to a gate field of `taskId` closes a cycle in the
   * combined gate graph; the cycle, as qualified ids each waiting for the
   * next (the last for the first), starting at the task, or `null`. Edges
   * into trees that did not load are non-edges. Both fields add the same
   * edge: the task waits for the target.
   */
  async wouldCreateCycle(
    holder: LoadedTree,
    taskId: string,
    field: GateField,
    ref: string,
  ): Promise<string[] | null> {
    assertGateField(field);
    const { target } = await this.resolution(holder, ref);
    if (target === null) return null;

    const ctx = graphContext(holder);
    const start = graphNode(ctx, holder, taskId);
    const first = graphNode(ctx, target.tree, target.id);
    if (!hasLiveTask(first.tree.tree, first.id)) return null;
    if (first.key === start.key) return [this.qualifyNode(start)];

    // Breadth first, so the cycle reported is a shortest one.
    const via = new Map<string, GraphNode | null>([[first.key, null]]);
    const queue: GraphNode[] = [first];
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]!;
      for (const next of await this.prerequisites(ctx, current)) {
        if (next.key === start.key) {
          const chain: GraphNode[] = [];
          for (
            let node: GraphNode | null = current;
            node !== null;
            node = via.get(node.key) ?? null
          ) {
            chain.unshift(node);
          }
          return [start, ...chain].map((node) => this.qualifyNode(node));
        }
        if (!via.has(next.key)) {
          via.set(next.key, current);
          queue.push(next);
        }
      }
    }
    return null;
  }

  /**
   * Every elementary cycle through at least one task of `holder`, once, as
   * qualified ids each waiting for the next (the last for the first),
   * starting at the cycle's first task in tree order. Cross-tree edges count
   * when the other tree loaded. A pathological graph is cut off after
   * `MAX_CYCLES` cycles.
   */
  async findCycles(holder: LoadedTree): Promise<string[][]> {
    const ctx = graphContext(holder);
    const nodes: GraphNode[] = [];
    const indexOf = new Map<string, number>();
    const add = (node: GraphNode): number => {
      let index = indexOf.get(node.key);
      if (index === undefined) {
        index = nodes.length;
        indexOf.set(node.key, index);
        nodes.push(node);
      }
      return index;
    };

    for (const id of liveIds(holder.tree)) add(graphNode(ctx, holder, id));
    const local = nodes.length;

    // `nodes` grows while the loop runs: foreign tasks are pulled in as the
    // edges of local ones reach them.
    const adjacency: number[][] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const edges = await this.prerequisites(ctx, nodes[index]!);
      adjacency.push(edges.map(add));
    }

    return elementaryCycles(adjacency, local).map((cycle) =>
      cycle.map((index) => this.qualifyNode(nodes[index]!)),
    );
  }

  /**
   * Tasks that depend on, or finish after, one of their own ancestors, by
   * local reference. Such an edge is also a cycle with the containment
   * chain; validation reports it under its own name.
   */
  ancestorDependencies(
    holder: LoadedTree,
  ): Array<{ id: string; field: GateField; ref: string }> {
    const out: Array<{ id: string; field: GateField; ref: string }> = [];
    for (const task of holder.tree.tasks) {
      const ancestors = new Set(ancestorIdsOf(holder.tree, task.id));
      if (ancestors.size === 0) continue;
      for (const field of GATE_FIELDS) {
        for (const ref of task.frontmatter[field]) {
          const parsed = safeParseReference(ref);
          if (
            parsed.ok &&
            parsed.ref.kind === "local" &&
            ancestors.has(parsed.ref.path)
          ) {
            out.push({ id: task.id, field, ref });
          }
        }
      }
    }
    return out;
  }

  /** Drop every cached path resolution; call after any write. */
  invalidate(): void {
    this.addresses.clear();
  }

  /* ---------------------------------------------------------------------- */

  private async resolution(
    holder: LoadedTree,
    ref: string,
  ): Promise<Resolution> {
    const key = `${holder.key}\0${ref}`;
    let address = this.addresses.get(key);
    if (address === undefined) {
      address = this.address(holder, ref);
      this.addresses.set(key, address);
    }
    return this.lookup(holder, ref, await address);
  }

  private async address(holder: LoadedTree, ref: string): Promise<Address> {
    const parsed = safeParseReference(ref);
    if (!parsed.ok) return { kind: "unparseable" };
    if (parsed.ref.kind === "local") {
      return {
        kind: "tree",
        tree: holder,
        id: parsed.ref.path,
        project: this.projects.qualifier(holder),
      };
    }
    const { projectPath, path: id } = parsed.ref;
    const load = await this.projects.byPath(holder, projectPath);
    if (load.kind !== "ok") {
      return {
        kind: "unavailable",
        reason: unavailableReason(load),
        project: load.alias ?? projectPath,
        id,
      };
    }
    const project = load.local ? null : (load.alias ?? projectPath);
    return { kind: "tree", tree: load, id, project };
  }

  private lookup(
    holder: LoadedTree,
    ref: string,
    address: Address,
  ): Resolution {
    switch (address.kind) {
      case "unparseable":
        return {
          resolved: blocked(ref, null, ref, "missing"),
          target: null,
        };
      case "unavailable":
        return {
          resolved: blocked(ref, address.project, address.id, address.reason),
          target: null,
        };
      case "tree": {
        // The holder's own references read the snapshot the caller passed;
        // every other tree is read as of its latest reload.
        const tree =
          address.tree.key === holder.key
            ? holder
            : this.projects.latest(address.tree);
        const { reason, status } = classify(tree.tree, address.id);
        return {
          resolved: {
            ref,
            project: address.project,
            id: address.id,
            satisfied: reason === null,
            reason,
            status,
          },
          target: { tree, id: address.id },
        };
      }
    }
  }

  private async finishGateWith(
    holder: LoadedTree,
    task: Task,
    openChildren: string[],
  ): Promise<FinishGate> {
    const refs = (
      await this.resolveRefs(holder, task.frontmatter.finishes_after)
    ).map(finishSemantics);
    return {
      satisfied:
        openChildren.length === 0 && refs.every((ref) => ref.satisfied),
      open_children: [...openChildren],
      refs,
    };
  }

  /**
   * What a node waits for: the targets of its `depends_on` and
   * `finishes_after` that are live tasks in the local tree or in a tree
   * listed under `projects:`, then its live children. A cross-tree edge is
   * never assumed traversable: a tree reached only by a bare path is read for
   * the gate it satisfies, but contributes no edge to the cycle graph. A
   * malformed task's references cannot be read; only its children are known.
   */
  private async prerequisites(
    ctx: GraphContext,
    node: GraphNode,
  ): Promise<GraphNode[]> {
    const out = new Map<string, GraphNode>();
    const task = node.tree.tree.byId.get(node.id);
    if (task !== undefined) {
      for (const field of GATE_FIELDS) {
        for (const ref of task.frontmatter[field]) {
          const { target } = await this.resolution(node.tree, ref);
          if (target === null) continue;
          if (!target.tree.local && target.tree.alias === null) continue;
          const next = graphNode(ctx, target.tree, target.id);
          if (hasLiveTask(next.tree.tree, next.id) && !out.has(next.key)) {
            out.set(next.key, next);
          }
        }
      }
    }
    for (const child of childrenIn(ctx, node.tree).get(node.id) ?? []) {
      const next = graphNode(ctx, node.tree, child);
      if (!out.has(next.key)) out.set(next.key, next);
    }
    return [...out.values()];
  }

  private qualifyNode(node: GraphNode): string {
    return this.projects.qualify(node.tree, node.id);
  }
}

/* ------------------------------------------------------------------------ */
/* Pure helpers                                                             */
/* ------------------------------------------------------------------------ */

/** The unsatisfied references, in stored order, as JSON `blocked_by`. */
export function toBlockedBy(refs: ResolvedRef[]): BlockedByJson[] {
  return refs.flatMap((ref) =>
    ref.satisfied || ref.reason === null
      ? []
      : [{ ref: ref.ref, reason: ref.reason, status: ref.status }],
  );
}

/**
 * The label overviews show for a reference: its qualified id, followed by
 * the reason whenever the reference is unsatisfied for any reason but
 * ordinary waiting — `blocked by A (cancelled)`, but `blocked by B`.
 */
export function describeRef(ref: ResolvedRef): string {
  const label = qualifyId(ref.project, ref.id);
  return ref.satisfied || ref.reason === null || ref.reason === "not-done"
    ? label
    : `${label} (${ref.reason})`;
}

/** Reasons under which a dependency edit's target still exists. */
const EXISTING: ReadonlySet<GateReason> = new Set(["not-done", "cancelled"]);

function reasonText(ref: ResolvedRef): string {
  const target = qualifyId(ref.project, ref.id);
  switch (ref.reason) {
    case "missing":
      return `no task ${target} exists`;
    case "archived":
      return `${target} is archived`;
    case "malformed":
      return `${target} has a malformed task.md`;
    case "unresolved-project":
      return `project ${ref.project} does not resolve to a .tasks tree`;
    case "not-checked-out":
      return `project ${ref.project} is not checked out`;
    case "unsupported-version":
      return `project ${ref.project} is a tree of an unsupported version`;
    default:
      return `${target} is not a live task`;
  }
}

function blocked(
  ref: string,
  project: string | null,
  id: string,
  reason: GateReason,
): ResolvedRef {
  return { ref, project, id, satisfied: false, reason, status: null };
}

/**
 * The reference table of the start gate. A live task wins over an archived
 * one at the same path (validation reports that pair), and an archived task
 * reports no status: it is not a target, whatever it once was.
 */
function classify(
  tree: Tree,
  id: string,
): { reason: GateReason | null; status: Status | null } {
  const task = tree.byId.get(id);
  if (task !== undefined) {
    const status = task.frontmatter.status;
    if (status === "DONE") return { reason: null, status };
    if (status === "CANCELLED") return { reason: "cancelled", status };
    return { reason: "not-done", status };
  }
  if (tree.malformedById.has(id)) return { reason: "malformed", status: null };
  if (tree.archivedById.has(id) || tree.archivedMalformedById.has(id)) {
    return { reason: "archived", status: null };
  }
  return { reason: "missing", status: null };
}

/** A cancelled target satisfies a finish gate: the scope was redefined. */
function finishSemantics(ref: ResolvedRef): ResolvedRef {
  return ref.reason === "cancelled"
    ? { ...ref, satisfied: true, reason: null }
    : ref;
}

function assertGateField(field: string): asserts field is GateField {
  if (!(GATE_FIELDS as readonly string[]).includes(field)) {
    throw TaskError.internal(`Unknown gate field "${field}".`, { field });
  }
}

function nodeKey(treeKey: string, id: string): string {
  return `${treeKey}\0${id}`;
}

function graphContext(root: LoadedTree): GraphContext {
  return { root, children: new Map() };
}

/** Every snapshot of the walk's own tree is the one the walk started from. */
function graphNode(ctx: GraphContext, tree: LoadedTree, id: string): GraphNode {
  const load = tree.key === ctx.root.key ? ctx.root : tree;
  return { key: nodeKey(load.key, id), tree: load, id };
}

function childrenIn(
  ctx: GraphContext,
  load: LoadedTree,
): Map<string, string[]> {
  let index = ctx.children.get(load.key);
  if (index === undefined) {
    index = childIndex(load.tree, false);
    ctx.children.set(load.key, index);
  }
  return index;
}

/**
 * Parent id → live child ids (parsed and malformed), in tree order; with
 * `openOnly`, parsed children only when open, malformed ones always, since
 * their status is unknown.
 */
function childIndex(tree: Tree, openOnly: boolean): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const add = (parent: string | null, id: string): void => {
    if (parent === null) return;
    const list = index.get(parent);
    if (list === undefined) index.set(parent, [id]);
    else list.push(id);
  };
  for (const task of tree.tasks) {
    if (!openOnly || isOpen(task.frontmatter.status)) add(task.parent, task.id);
  }
  for (const entry of tree.malformed) {
    if (entry.id !== "") add(entry.parent, entry.id);
  }
  for (const list of index.values()) list.sort(compareIds);
  return index;
}

/** Live task ids, parsed and malformed, in tree order. */
function liveIds(tree: Tree): string[] {
  return [
    ...tree.tasks.map((task) => task.id),
    ...tree.malformed.filter((entry) => entry.id !== "").map((e) => e.id),
  ].sort(compareIds);
}

/**
 * Strongly connected components (Tarjan), iteratively so a long dependency
 * chain cannot overflow the stack. Returns the component of every node.
 */
function components(adjacency: number[][]): number[] {
  const count = adjacency.length;
  const order = new Array<number>(count).fill(-1);
  const low = new Array<number>(count).fill(0);
  const onStack = new Array<boolean>(count).fill(false);
  const component = new Array<number>(count).fill(-1);
  const stack: number[] = [];
  let counter = 0;
  let found = 0;

  const enter = (node: number): void => {
    order[node] = counter;
    low[node] = counter;
    counter += 1;
    stack.push(node);
    onStack[node] = true;
  };

  for (let root = 0; root < count; root += 1) {
    if (order[root] !== -1) continue;
    enter(root);
    const frames = [{ node: root, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = adjacency[frame.node]!;
      if (frame.next < edges.length) {
        const next = edges[frame.next]!;
        frame.next += 1;
        if (order[next] === -1) {
          enter(next);
          frames.push({ node: next, next: 0 });
        } else if (onStack[next]) {
          low[frame.node] = Math.min(low[frame.node]!, order[next]!);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        low[parent.node] = Math.min(low[parent.node]!, low[frame.node]!);
      }
      if (low[frame.node] === order[frame.node]) {
        for (;;) {
          const member = stack.pop()!;
          onStack[member] = false;
          component[member] = found;
          if (member === frame.node) break;
        }
        found += 1;
      }
    }
  }
  return component;
}

/**
 * Each elementary cycle once, rooted at its smallest node, for roots below
 * `rootLimit` (the walk's own tree is numbered first, so a cycle through it
 * is rooted in it). The search stays inside the root's component, so the
 * acyclic bulk of a tree costs nothing.
 */
function elementaryCycles(
  adjacency: number[][],
  rootLimit: number,
): number[][] {
  const component = components(adjacency);
  const sizes = new Map<number, number>();
  for (const id of component) sizes.set(id, (sizes.get(id) ?? 0) + 1);
  const cycles: number[][] = [];
  let budget = SEARCH_BUDGET;

  for (let root = 0; root < rootLimit; root += 1) {
    if (cycles.length >= MAX_CYCLES) break;
    // A node alone in its component closes a cycle only through itself.
    if (sizes.get(component[root]!) === 1) {
      if (adjacency[root]!.includes(root)) cycles.push([root]);
      continue;
    }
    if (budget <= 0) continue;
    const path = [root];
    const onPath = new Set([root]);
    const visit = (node: number): void => {
      for (const next of adjacency[node]!) {
        if (cycles.length >= MAX_CYCLES || budget <= 0) return;
        budget -= 1;
        if (next === root) {
          cycles.push([...path]);
          continue;
        }
        if (
          next < root ||
          component[next] !== component[root] ||
          onPath.has(next)
        ) {
          continue;
        }
        path.push(next);
        onPath.add(next);
        visit(next);
        path.pop();
        onPath.delete(next);
      }
    };
    visit(root);
  }
  return cycles;
}
