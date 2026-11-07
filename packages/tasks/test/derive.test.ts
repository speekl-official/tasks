import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  DerivedTask,
  SnapshotTask,
  TreeSnapshot,
} from "../src/core/derive.js";
import {
  SITUATION_TABLE,
  deriveTree,
  effectivePriority,
  hasOpenStatus,
  inScope,
  labels,
  priorityLabel,
  readyComparator,
  readySet,
  situationFilter,
  situationOf,
  situationText,
} from "../src/core/derive.js";
import type { Tree } from "../src/core/tree.js";
import {
  ancestorsOf,
  childrenOf,
  findTask,
  loadTree,
  malformedChildrenOf,
} from "../src/core/tree.js";
import type {
  ClaimLiveness,
  FinishGate,
  GateReason,
  LastEntryJson,
  ResolvedRef,
  Situation,
  StartGate,
  Status,
} from "../src/core/types.js";
import { SITUATIONS, TASKS_DIRNAME, isOpen } from "../src/core/types.js";
import type { TreeSpec } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

/* ------------------------------------------------------------------------ */
/* Snapshot builders                                                        */
/* ------------------------------------------------------------------------ */

interface Overrides {
  start?: Record<string, StartGate>;
  finish?: Record<string, Partial<FinishGate>>;
  liveness?: Record<string, ClaimLiveness>;
  lastEntry?: Record<string, LastEntryJson>;
}

function unsatisfiedRef(
  ref: string,
  reason: GateReason = "not-done",
  status: Status | null = "TODO",
): ResolvedRef {
  return { ref, project: null, id: ref, satisfied: false, reason, status };
}

function satisfiedRef(ref: string, status: Status = "DONE"): ResolvedRef {
  return { ref, project: null, id: ref, satisfied: true, reason: null, status };
}

function blockedBy(...refs: ResolvedRef[]): StartGate {
  return { satisfied: refs.every((ref) => ref.satisfied), refs };
}

/**
 * The finish gate as the gates module reports it: every live open child,
 * malformed ones included, plus whatever `finishes_after` refs a test gives.
 */
function finishGateOf(
  tree: Tree,
  id: string,
  override: Partial<FinishGate> = {},
): FinishGate {
  const openChildren = [
    ...childrenOf(tree, id)
      .filter((child) => isOpen(child.frontmatter.status))
      .map((child) => child.id),
    ...malformedChildrenOf(tree, id).map((entry) => entry.id),
  ];
  const refs = override.refs ?? [];
  const open_children = override.open_children ?? openChildren;
  return {
    satisfied:
      override.satisfied ??
      (open_children.length === 0 && refs.every((ref) => ref.satisfied)),
    open_children,
    refs,
  };
}

function snapshotOf(
  tree: Tree,
  overrides: Overrides = {},
  project: string | null = null,
): TreeSnapshot {
  return {
    tree,
    project,
    tasks: tree.tasks.map(
      (task): SnapshotTask => ({
        task,
        project,
        start: overrides.start?.[task.id] ?? { satisfied: true, refs: [] },
        finish: finishGateOf(tree, task.id, overrides.finish?.[task.id]),
        liveness:
          task.frontmatter.status === "IN_PROGRESS"
            ? (overrides.liveness?.[task.id] ?? {
                liveness: "unknown",
                last_seen: null,
              })
            : null,
        lastEntry: overrides.lastEntry?.[task.id] ?? null,
      }),
    ),
  };
}

interface DeriveOptions {
  /** Defaults to the fixture actor; `null` derives as `index.md` does. */
  actor?: string | null;
  overrides?: Overrides;
  /** Ids at which to write an unparseable `task.md`. */
  malformed?: string[];
}

async function derive(
  spec: TreeSpec,
  options: DeriveOptions = {},
): Promise<Map<string, DerivedTask>> {
  sandbox = await treeSandbox(spec);
  for (const id of options.malformed ?? []) {
    await sandbox.write(`.tasks/${id}/task.md`, "no frontmatter here\n");
  }
  const tree = await sandbox.loadTree();
  return deriveTree(
    snapshotOf(tree, options.overrides),
    options.actor === undefined ? "tester" : options.actor,
  );
}

function get(derived: Map<string, DerivedTask>, id: string): DerivedTask {
  const d = derived.get(id);
  if (d === undefined) throw new Error(`no derived task ${id}`);
  return d;
}

/** The situation and its labels, as one overview line reads them. */
function shown(d: DerivedTask): string {
  return [situationText(d), ...labels(d)].join(" · ");
}

const LIVE: ClaimLiveness = {
  liveness: "live",
  last_seen: "2026-09-21T16:40:12Z",
};
const ORPHANED: ClaimLiveness = {
  liveness: "orphaned",
  last_seen: "2026-09-21T16:40:12Z",
};

/* ------------------------------------------------------------------------ */
/* Situations                                                               */
/* ------------------------------------------------------------------------ */

describe("the situation table", () => {
  it("lists the rows in the precedence order of SITUATIONS", () => {
    expect(SITUATION_TABLE.map(([situation]) => situation)).toEqual([
      ...SITUATIONS,
    ]);
  });

  it("falls back to ready when no earlier row holds", () => {
    expect(
      situationOf({
        status: "TODO",
        started: false,
        heldBy: null,
        assignee: null,
        blocked: false,
        closable: false,
        openChildren: 0,
      }),
    ).toBe("ready");
  });

  it("gives every row its situation", async () => {
    const derived = await derive(
      {
        tasks: {
          finished: { status: "DONE" },
          dropped: { status: "CANCELLED" },
          worked: { status: "IN_PROGRESS", claimed_session: "s1" },
          shelved: { status: "BACKLOG", state: true },
          later: { status: "BACKLOG" },
          epic: { status: "IN_PROGRESS" },
          "epic/part": {},
          review: { status: "PAUSED", state: true, assignee: "alice" },
          deploy: { assignee: "alice" },
          waits: {},
          finishable: {},
          "finishable/part": { status: "DONE" },
          parent: {},
          "parent/done-part": { status: "DONE" },
          "parent/open-part": {},
          free: {},
        },
      },
      {
        overrides: {
          start: { waits: blockedBy(unsatisfiedRef("free")) },
          liveness: { worked: LIVE },
        },
      },
    );
    const expected: Record<string, [Situation, string]> = {
      finished: ["done", "done"],
      dropped: ["cancelled", "cancelled"],
      worked: ["working", "working by tester"],
      shelved: ["parked", "parked"],
      later: ["backlog", "backlog"],
      "epic/part": ["held", "held by epic"],
      review: ["waiting", "waiting for alice"],
      deploy: ["assigned", "assigned alice"],
      waits: ["blocked", "blocked by free"],
      finishable: ["closable", "closable"],
      parent: ["open", "open 1/2"],
      free: ["ready", "ready"],
    };
    for (const [id, [situation, text]] of Object.entries(expected)) {
      const d = get(derived, id);
      expect([id, d.derived.situation, situationText(d)]).toEqual([
        id,
        situation,
        text,
      ]);
      expect(d.json.situation).toBe(situation);
    }
  });

  it("calls IN_PROGRESS working even when the claim fields disagree", async () => {
    const derived = await derive({
      tasks: {
        odd: { status: "IN_PROGRESS", claimed_by: null, claimed_at: null },
      },
    });
    expect(get(derived, "odd").derived.situation).toBe("working");
  });

  it("names the reason when a reference can never be satisfied", async () => {
    const derived = await derive(
      { tasks: { a: {}, b: {}, c: {} } },
      {
        overrides: {
          start: {
            a: blockedBy(
              unsatisfiedRef("x", "cancelled", "CANCELLED"),
              unsatisfiedRef("y", "not-done", "TODO"),
            ),
            b: blockedBy(unsatisfiedRef("gone", "missing", null)),
            c: blockedBy(satisfiedRef("x"), unsatisfiedRef("y")),
          },
        },
      },
    );
    expect(situationText(get(derived, "a"))).toBe(
      "blocked by x (cancelled), y",
    );
    expect(situationText(get(derived, "b"))).toBe("blocked by gone (missing)");
    expect(get(derived, "c").derived.blocked_by).toEqual([
      { ref: "y", reason: "not-done", status: "TODO" },
    ]);
  });

  it("shows a project reference qualified by its alias", async () => {
    const derived = await derive(
      { tasks: { a: {} } },
      {
        overrides: {
          start: {
            a: blockedBy({
              ref: "../backend:api/tokens",
              project: "backend",
              id: "api/tokens",
              satisfied: false,
              reason: "not-checked-out",
              status: null,
            }),
          },
        },
      },
    );
    const d = get(derived, "a");
    expect(situationText(d)).toBe(
      "blocked by backend:api/tokens (not-checked-out)",
    );
    // The JSON keeps the stored form.
    expect(d.derived.blocked_by[0]!.ref).toBe("../backend:api/tokens");
  });
});

describe("precedence", () => {
  it("prefers waiting over blocked for a PAUSED task with an assignee", async () => {
    const derived = await derive(
      { tasks: { t: { status: "PAUSED", state: true, assignee: "alice" } } },
      { overrides: { start: { t: blockedBy(unsatisfiedRef("dep")) } } },
    );
    const d = get(derived, "t");
    expect(d.derived.situation).toBe("waiting");
    expect(labels(d)).toEqual(["blocked by dep"]);
  });

  it("prefers blocked over open for a parent with an open child", async () => {
    const derived = await derive(
      { tasks: { epic: {}, "epic/part": {} } },
      { overrides: { start: { epic: blockedBy(unsatisfiedRef("dep")) } } },
    );
    expect(get(derived, "epic").derived.situation).toBe("blocked");
  });

  it("calls a BACKLOG task with a descendant's state.md parked", async () => {
    const derived = await derive({
      tasks: {
        epic: { status: "BACKLOG" },
        "epic/part": { status: "BACKLOG", state: true },
        "epic/other": { status: "BACKLOG" },
      },
    });
    expect(get(derived, "epic").derived.situation).toBe("parked");
    expect(get(derived, "epic").derived.started).toBe(true);
    expect(get(derived, "epic/part").derived.situation).toBe("parked");
    expect(get(derived, "epic/other").derived.situation).toBe("backlog");
  });

  it("prefers held over waiting, and shows the waiting as a label", async () => {
    const derived = await derive({
      tasks: {
        epic: { status: "IN_PROGRESS" },
        "epic/part": { status: "PAUSED", state: true, assignee: "alice" },
      },
    });
    const d = get(derived, "epic/part");
    expect(d.derived.situation).toBe("held");
    expect(labels(d)).toEqual(["started", "waiting for alice"]);
  });

  it("prefers assigned over blocked", async () => {
    const derived = await derive(
      { tasks: { t: { assignee: "alice" } } },
      { overrides: { start: { t: blockedBy(unsatisfiedRef("dep")) } } },
    );
    expect(shown(get(derived, "t"))).toBe("assigned alice · blocked by dep");
  });

  it("keeps working first under a holding ancestor", async () => {
    const derived = await derive({
      tasks: {
        epic: { assignee: "alice" },
        "epic/part": { status: "IN_PROGRESS" },
      },
    });
    const d = get(derived, "epic/part");
    expect(d.derived.situation).toBe("working");
    expect(d.derived.held_by).toBe("epic");
    expect(labels(d)).toEqual(["held by epic"]);
  });

  it("prefers closable over ready for a task whose joins are resolved", async () => {
    const derived = await derive(
      { tasks: { join: { finishes_after: ["x"] }, x: { status: "DONE" } } },
      { overrides: { finish: { join: { refs: [satisfiedRef("x")] } } } },
    );
    const d = get(derived, "join");
    expect(d.derived.closable).toBe(true);
    expect(d.derived.situation).toBe("closable");
    // finishes_after gates done, not the start: the task is still ready.
    expect(d.derived.ready).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* Derived fields                                                           */
/* ------------------------------------------------------------------------ */

describe("derived fields", () => {
  it("counts live children, a malformed one as open", async () => {
    const derived = await derive(
      {
        tasks: {
          epic: {},
          "epic/a": { status: "DONE" },
          "epic/b": { status: "CANCELLED" },
          "epic/c": { status: "PAUSED", state: true },
          "epic/group/d": {},
          "epic/a/deep": { status: "DONE" },
        },
        archived: { "epic/old": { status: "DONE" } },
      },
      { malformed: ["epic/broken"] },
    );
    const d = get(derived, "epic");
    expect(d.derived.children).toEqual({ open: 3, resolved: 2 });
    expect(situationText(d)).toBe("open 2/5");
    expect(d.derived.closable).toBe(false);
    expect(d.derived.ready).toBe(false);
  });

  it("computes active and started from the subtree", async () => {
    const derived = await derive({
      tasks: {
        epic: {},
        "epic/part": {},
        "epic/part/leaf": { status: "IN_PROGRESS", state: true },
        other: {},
      },
    });
    for (const id of ["epic", "epic/part"]) {
      expect(get(derived, id).derived.active).toBe(true);
      expect(get(derived, id).derived.started).toBe(true);
    }
    const leaf = get(derived, "epic/part/leaf");
    expect(leaf.derived.active).toBe(false);
    expect(leaf.derived.started).toBe(true);
    expect(get(derived, "other").derived.active).toBe(false);
    expect(get(derived, "other").derived.started).toBe(false);
  });

  it("sets waiting_for only for a PAUSED task", async () => {
    const derived = await derive({
      tasks: {
        paused: { status: "PAUSED", assignee: "alice" },
        todo: { assignee: "alice" },
      },
    });
    expect(get(derived, "paused").derived.waiting_for).toBe("alice");
    expect(get(derived, "todo").derived.waiting_for).toBeNull();
  });

  it("is closable only when open with a satisfied, non-trivial finish gate", async () => {
    const derived = await derive(
      {
        tasks: {
          leaf: {},
          parent: {},
          "parent/part": { status: "DONE" },
          joined: { finishes_after: ["x"] },
          x: {},
          resolved: { status: "DONE" },
          "resolved/part": { status: "DONE" },
          backlog: { status: "BACKLOG" },
          "backlog/part": { status: "CANCELLED" },
        },
      },
      {
        overrides: {
          finish: { joined: { refs: [unsatisfiedRef("x")] } },
        },
      },
    );
    expect(get(derived, "leaf").derived.closable).toBe(false);
    expect(get(derived, "parent").derived.closable).toBe(true);
    expect(get(derived, "joined").derived.closable).toBe(false);
    expect(get(derived, "resolved").derived.closable).toBe(false);
    const backlog = get(derived, "backlog");
    expect(backlog.derived.closable).toBe(true);
    expect(shown(backlog)).toBe("backlog · closable");
  });

  it("does not let a finish gate that disagrees with the tree make a parent closable", async () => {
    const derived = await derive(
      { tasks: { epic: {}, "epic/part": {} } },
      {
        overrides: {
          finish: { epic: { satisfied: true, open_children: [] } },
        },
      },
    );
    const d = get(derived, "epic");
    expect(d.derived.closable).toBe(false);
    expect(d.derived.situation).toBe("open");
    expect(d.derived.ready).toBe(false);
  });

  it("copies liveness for IN_PROGRESS tasks, and last_seen only with a session", async () => {
    const entry: LastEntryJson = {
      time: "2026-09-21T16:40:12Z",
      actor: "agent",
      via: null,
      session: "s1",
      text: "claim: TODO → IN_PROGRESS",
    };
    const derived = await derive(
      {
        tasks: {
          live: { status: "IN_PROGRESS", claimed_session: "s1" },
          nosession: { status: "IN_PROGRESS" },
          unresolved: { status: "IN_PROGRESS", claimed_session: "s2" },
          paused: { status: "PAUSED", state: true },
        },
      },
      {
        overrides: {
          liveness: {
            live: LIVE,
            nosession: {
              liveness: "unknown",
              last_seen: "2026-01-01T00:00:00Z",
            },
          },
          lastEntry: { live: entry },
        },
      },
    );
    expect(get(derived, "live").derived).toMatchObject({
      liveness: "live",
      last_seen: LIVE.last_seen,
      last_entry: entry,
    });
    expect(get(derived, "nosession").derived).toMatchObject({
      liveness: "unknown",
      last_seen: null,
    });
    expect(get(derived, "paused").derived).toMatchObject({
      liveness: null,
      last_seen: null,
      last_entry: null,
    });

    // A snapshot that left liveness unresolved protects the claim.
    const snapshot = snapshotOf(await sandbox!.loadTree());
    for (const task of snapshot.tasks) task.liveness = null;
    const unresolved = deriveTree(snapshot, "tester").get("unresolved")!;
    expect(unresolved.derived.liveness).toBe("unknown");
  });

  it("merges the task object and the derived conditions into json", async () => {
    const derived = await derive({
      tasks: { epic: { priority: "high" }, "epic/part": {} },
    });
    const d = get(derived, "epic/part");
    expect(d.json).toMatchObject({
      id: "epic/part",
      name: "part",
      parent: "epic",
      project: null,
      title: "part",
      status: "TODO",
      priority: "normal",
      situation: "ready",
      ready: true,
      effective_priority: "high",
      held_by: null,
      children: { open: 0, resolved: 0 },
      blocked_by: [],
    });
    expect(d.json.path).toBe(d.snapshot.task.dir);
  });

  it("leaves blocked_by, held_by and closable empty on resolved tasks", async () => {
    const derived = await derive(
      {
        tasks: {
          epic: { status: "DONE", assignee: "alice" },
          "epic/part": { status: "DONE" },
        },
      },
      { overrides: { start: { epic: blockedBy(unsatisfiedRef("dep")) } } },
    );
    const part = get(derived, "epic/part");
    expect(part.derived.held_by).toBeNull();
    const epic = get(derived, "epic");
    expect(epic.derived.blocked_by).toEqual([]);
    expect(epic.derived.closable).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Hold                                                                     */
/* ------------------------------------------------------------------------ */

describe("held_by", () => {
  it("names the nearest holder, through groups", async () => {
    const derived = await derive({
      tasks: {
        program: { assignee: "alice" },
        "program/epic": { status: "IN_PROGRESS" },
        "program/epic/phase/part": {},
        "program/other": {},
      },
    });
    expect(get(derived, "program/epic/phase/part").derived.held_by).toBe(
      "program/epic",
    );
    expect(get(derived, "program/epic").derived.held_by).toBe("program");
    expect(get(derived, "program/other").derived.held_by).toBe("program");
    expect(get(derived, "program").derived.held_by).toBeNull();
  });

  it("lets a malformed ancestor hold, fail safe", async () => {
    const derived = await derive(
      { tasks: { "broken/part": {} } },
      { malformed: ["broken"] },
    );
    const d = get(derived, "broken/part");
    expect(d.derived.held_by).toBe("broken");
    expect(d.derived.situation).toBe("held");
    expect(d.derived.ready).toBe(false);
  });

  it("is qualified with the project alias in a foreign tree", async () => {
    sandbox = await treeSandbox({});
    const root = await sandbox.project("backend", "../backend", {
      tasks: {
        epic: { assignee: "alice" },
        "epic/part": {},
      },
    });
    const tree = await loadTree({
      root,
      tasksDir: path.join(root, TASKS_DIRNAME),
    });
    const derived = deriveTree(snapshotOf(tree, {}, "backend"), "tester");
    const d = get(derived, "epic/part");
    expect(d.json.id).toBe("backend:epic/part");
    expect(d.json.parent).toBe("backend:epic");
    expect(d.derived.held_by).toBe("backend:epic");
    expect(situationText(d)).toBe("held by backend:epic");
  });
});

/* ------------------------------------------------------------------------ */
/* Ready                                                                    */
/* ------------------------------------------------------------------------ */

describe("ready", () => {
  it("offers free TODO and PAUSED tasks and nothing else", async () => {
    const derived = await derive({
      tasks: {
        todo: {},
        paused: { status: "PAUSED", state: true },
        backlog: { status: "BACKLOG" },
        working: { status: "IN_PROGRESS" },
        done: { status: "DONE" },
        cancelled: { status: "CANCELLED" },
      },
    });
    const ready = [...derived.values()]
      .filter((d) => d.derived.ready)
      .map((d) => d.json.id)
      .sort();
    expect(ready).toEqual(["paused", "todo"]);
  });

  it("excludes a parent with an open child, until the child resolves", async () => {
    const derived = await derive({
      tasks: {
        epic: {},
        "epic/part": {},
        finished: {},
        "finished/part": { status: "DONE" },
      },
    });
    expect(get(derived, "epic").derived.ready).toBe(false);
    expect(get(derived, "epic/part").derived.ready).toBe(true);
    expect(get(derived, "finished").derived.ready).toBe(true);
  });

  it("excludes a task with a malformed child", async () => {
    const derived = await derive(
      { tasks: { epic: {} } },
      { malformed: ["epic/broken"] },
    );
    const d = get(derived, "epic");
    expect(d.derived.ready).toBe(false);
    expect(d.derived.situation).toBe("open");
  });

  it("excludes the children of a BACKLOG epic", async () => {
    const derived = await derive({
      tasks: {
        epic: { status: "BACKLOG" },
        "epic/part": { status: "BACKLOG" },
      },
    });
    expect(get(derived, "epic/part").derived.ready).toBe(false);
    expect(get(derived, "epic/part").derived.situation).toBe("backlog");
  });

  it("excludes an open task under a BACKLOG or resolved ancestor, invariant broken", async () => {
    const derived = await derive({
      tasks: {
        epic: { status: "BACKLOG" },
        "epic/part": {},
        closed: { status: "DONE" },
        "closed/part": {},
      },
    });
    for (const id of ["epic/part", "closed/part"]) {
      const d = get(derived, id);
      expect(d.derived.ready).toBe(false);
      // No row before the last holds, so the situation falls back to ready.
      expect(d.derived.situation).toBe("ready");
    }
  });

  it("excludes the children of a claimed ancestor and of an assigned one", async () => {
    const derived = await derive({
      tasks: {
        claimed: { status: "IN_PROGRESS" },
        "claimed/part": {},
        assigned: { status: "PAUSED", state: true, assignee: "alice" },
        "assigned/part": {},
      },
    });
    expect(get(derived, "claimed/part").derived.ready).toBe(false);
    expect(get(derived, "assigned/part").derived.ready).toBe(false);
    expect(situationText(get(derived, "assigned/part"))).toBe(
      "held by assigned",
    );
  });

  it("offers an assigned task to its assignee only", async () => {
    const spec: TreeSpec = {
      tasks: { mine: { assignee: "tester" }, theirs: { assignee: "alice" } },
    };
    const derived = await derive(spec);
    expect(get(derived, "mine").derived.ready).toBe(true);
    expect(get(derived, "mine").derived.situation).toBe("assigned");
    expect(get(derived, "theirs").derived.ready).toBe(false);
  });

  it("requires no assignee at all without an actor", async () => {
    const derived = await derive(
      { tasks: { mine: { assignee: "tester" }, free: {} } },
      { actor: null },
    );
    expect(get(derived, "mine").derived.ready).toBe(false);
    expect(get(derived, "free").derived.ready).toBe(true);
  });

  it("excludes a blocked task, and a gate that is unsatisfied without refs", async () => {
    const derived = await derive(
      { tasks: { blocked: {}, odd: {} } },
      {
        overrides: {
          start: {
            blocked: blockedBy(unsatisfiedRef("dep")),
            odd: { satisfied: false, refs: [] },
          },
        },
      },
    );
    expect(get(derived, "blocked").derived.ready).toBe(false);
    expect(get(derived, "odd").derived.ready).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Priority and order                                                       */
/* ------------------------------------------------------------------------ */

describe("effective priority", () => {
  it("is the highest of the task's and its ancestors'", async () => {
    const derived = await derive({
      tasks: {
        epic: { priority: "urgent" },
        "epic/part": { priority: "low" },
        "epic/part/leaf": {},
        solo: { priority: "high" },
        quiet: { priority: "low" },
      },
    });
    expect(get(derived, "epic/part").derived.effective_priority).toBe("urgent");
    expect(get(derived, "epic/part/leaf").derived.effective_priority).toBe(
      "urgent",
    );
    expect(priorityLabel(get(derived, "epic/part"))).toBe("urgent (inherited)");
    expect(priorityLabel(get(derived, "epic"))).toBe("urgent");
    expect(priorityLabel(get(derived, "solo"))).toBe("high");
    expect(priorityLabel(get(derived, "quiet"))).toBe("low");

    const tree = await sandbox!.loadTree();
    const leaf = findTask(tree, "epic/part/leaf");
    expect(effectivePriority(leaf, ancestorsOf(tree, leaf.id))).toBe("urgent");
    expect(effectivePriority(leaf, [])).toBe("normal");
  });
});

describe("ready order", () => {
  it("sorts by priority, PAUSED first, then created, then id", async () => {
    const derived = await derive({
      tasks: {
        "old-todo": { created: "2026-01-01T00:00:00Z" },
        "new-todo": { created: "2026-03-01T00:00:00Z" },
        "late-urgent": {
          priority: "urgent",
          created: "2026-06-01T00:00:00Z",
        },
        "late-paused": {
          status: "PAUSED",
          state: true,
          created: "2026-05-01T00:00:00Z",
        },
        "b-twin": { created: "2026-02-01T00:00:00Z" },
        "a-twin": { created: "2026-02-01T00:00:00Z" },
        low: { priority: "low", created: "2025-01-01T00:00:00Z" },
      },
    });
    expect(
      readySet(derived.values(), { scope: null }).map((d) => d.json.id),
    ).toEqual([
      "late-urgent",
      "late-paused",
      "old-todo",
      "a-twin",
      "b-twin",
      "new-todo",
      "low",
    ]);
  });

  it("orders ids in tree order as the last key", async () => {
    const derived = await derive({ tasks: { "a-b": {}, "a/b": {} } });
    const [first, second] = [get(derived, "a/b"), get(derived, "a-b")];
    expect(readyComparator(first, second)).toBeLessThan(0);
  });

  it("interleaves projects by the same keys, local first, then aliases", async () => {
    sandbox = await treeSandbox({
      tasks: {
        a: { created: "2026-02-01T00:00:00Z" },
        late: { created: "2026-09-01T00:00:00Z" },
      },
    });
    const trees: Array<[string | null, Tree]> = [
      [null, await sandbox.loadTree()],
    ];
    for (const [alias, tasks] of [
      ["zeta", { a: { created: "2026-02-01T00:00:00Z" } }],
      [
        "alpha",
        {
          a: { created: "2026-02-01T00:00:00Z" },
          early: { created: "2026-01-01T00:00:00Z" },
        },
      ],
      ["omega", { a: { created: "2026-02-01T00:00:00Z" } }],
    ] as const) {
      const root = await sandbox.project(alias, `../${alias}`, { tasks });
      trees.push([
        alias,
        await loadTree({ root, tasksDir: path.join(root, TASKS_DIRNAME) }),
      ]);
    }
    const all = trees.flatMap(([alias, tree]) => [
      ...deriveTree(snapshotOf(tree, {}, alias), "tester").values(),
    ]);
    // omega is not in the alias order: after the known ones, by name.
    expect(
      readySet(all, { scope: null, aliasOrder: ["zeta", "alpha"] }).map(
        (d) => d.json.id,
      ),
    ).toEqual(["alpha:early", "a", "zeta:a", "alpha:a", "omega:a", "late"]);
  });
});

describe("scope", () => {
  it("is the scope itself or anything beneath it", () => {
    expect(inScope("auth", null)).toBe(true);
    expect(inScope("auth", "auth")).toBe(true);
    expect(inScope("auth/token", "auth")).toBe(true);
    expect(inScope("auth-rework", "auth")).toBe(false);
    expect(inScope("billing/x", "auth")).toBe(false);
  });

  it("limits the ready set of the local tree only", async () => {
    sandbox = await treeSandbox({
      tasks: { "auth/token": {}, "auth-rework": {}, billing: {} },
    });
    const local = deriveTree(snapshotOf(await sandbox.loadTree()), "tester");
    const root = await sandbox.project("backend", "../backend", {
      tasks: { "auth/api": {}, other: {} },
    });
    const foreign = deriveTree(
      snapshotOf(
        await loadTree({ root, tasksDir: path.join(root, TASKS_DIRNAME) }),
        {},
        "backend",
      ),
      "tester",
    );
    const ids = readySet([...local.values(), ...foreign.values()], {
      scope: "auth",
      aliasOrder: ["backend"],
    }).map((d) => d.json.id);
    expect(ids).toEqual(["auth/token", "backend:auth/api", "backend:other"]);
  });
});

/* ------------------------------------------------------------------------ */
/* Filters                                                                  */
/* ------------------------------------------------------------------------ */

describe("situationFilter", () => {
  it("selects each situation word, and resolved", async () => {
    const derived = await derive(
      {
        tasks: {
          "s-done": { status: "DONE" },
          "s-cancelled": { status: "CANCELLED" },
          "s-working": { status: "IN_PROGRESS" },
          "s-parked": { status: "BACKLOG", state: true },
          "s-backlog": { status: "BACKLOG" },
          "s-epic": { assignee: "alice", status: "PAUSED", state: true },
          "s-epic/s-held": {},
          "s-assigned": { assignee: "alice" },
          "s-blocked": {},
          "s-closable": {},
          "s-closable/part": { status: "DONE" },
          "s-open": {},
          "s-open/part": {},
        },
      },
      { overrides: { start: { "s-blocked": blockedBy(unsatisfiedRef("x")) } } },
    );
    const all = [...derived.values()];
    const pick = (name: Situation | "resolved") =>
      all
        .filter(situationFilter(name))
        .map((d) => d.json.id)
        .sort();

    expect(pick("done")).toEqual(["s-closable/part", "s-done"]);
    expect(pick("cancelled")).toEqual(["s-cancelled"]);
    expect(pick("working")).toEqual(["s-working"]);
    expect(pick("parked")).toEqual(["s-parked"]);
    expect(pick("backlog")).toEqual(["s-backlog"]);
    expect(pick("held")).toEqual(["s-epic/s-held"]);
    expect(pick("waiting")).toEqual(["s-epic"]);
    expect(pick("assigned")).toEqual(["s-assigned"]);
    expect(pick("blocked")).toEqual(["s-blocked"]);
    expect(pick("closable")).toEqual(["s-closable"]);
    expect(pick("open")).toEqual(["s-open"]);
    expect(pick("ready")).toEqual(["s-open/part"]);
    expect(pick("resolved")).toEqual([
      "s-cancelled",
      "s-closable/part",
      "s-done",
    ]);
    expect(all.filter(hasOpenStatus)).toHaveLength(all.length - 3);
  });
});

/* ------------------------------------------------------------------------ */
/* Labels                                                                   */
/* ------------------------------------------------------------------------ */

describe("labels", () => {
  it("come in the fixed order", async () => {
    const derived = await derive(
      {
        tasks: {
          epic: { assignee: "alice" },
          "epic/held": { status: "PAUSED", state: true, assignee: "bob" },
          "epic/held/part": { status: "IN_PROGRESS" },
          "epic/worked": {
            status: "IN_PROGRESS",
            claimed_session: "s1",
            priority: "high",
            assignee: "bob",
            state: true,
            finishes_after: ["x"],
          },
          x: { status: "DONE" },
        },
      },
      {
        overrides: {
          start: {
            "epic/held": blockedBy(
              unsatisfiedRef("x", "cancelled", "CANCELLED"),
            ),
            "epic/worked": blockedBy(unsatisfiedRef("y")),
          },
          finish: { "epic/worked": { refs: [satisfiedRef("x")] } },
          liveness: { "epic/worked": LIVE },
        },
      },
    );
    expect(shown(get(derived, "epic/held"))).toBe(
      "held by epic · started · blocked by x (cancelled) · active · waiting for bob",
    );
    expect(shown(get(derived, "epic/worked"))).toBe(
      "working by tester · blocked by y · high · live · assigned bob · held by epic · closable",
    );
  });

  it("label claims with a session by their liveness only", async () => {
    const derived = await derive(
      {
        tasks: {
          live: { status: "IN_PROGRESS", claimed_session: "s1" },
          orphaned: { status: "IN_PROGRESS", claimed_session: "s2" },
          unknown: { status: "IN_PROGRESS", claimed_session: "s3" },
          sessionless: { status: "IN_PROGRESS" },
        },
      },
      {
        overrides: {
          liveness: {
            live: LIVE,
            orphaned: ORPHANED,
            unknown: { liveness: "unknown", last_seen: null },
            sessionless: { liveness: "unknown", last_seen: null },
          },
        },
      },
    );
    expect(labels(get(derived, "live"))).toEqual(["live"]);
    expect(labels(get(derived, "orphaned"))).toEqual([
      "orphaned since 2026-09-21T16:40:12Z",
    ]);
    expect(labels(get(derived, "unknown"))).toEqual(["liveness unknown"]);
    expect(labels(get(derived, "sessionless"))).toEqual([]);
  });

  it("carry nothing on a resolved task but a broken invariant", async () => {
    const derived = await derive({
      tasks: {
        done: {
          status: "DONE",
          state: true,
          priority: "urgent",
          assignee: "alice",
        },
        broken: { status: "CANCELLED" },
        "broken/part": { status: "IN_PROGRESS" },
      },
    });
    expect(labels(get(derived, "done"))).toEqual([]);
    expect(labels(get(derived, "broken"))).toEqual(["active"]);
  });

  it("mark only the task's own resume point as started", async () => {
    const derived = await derive({
      tasks: {
        epic: {},
        "epic/part": { status: "PAUSED", state: true },
        planned: { state: true },
        "planned/part": {},
      },
    });
    const epic = get(derived, "epic");
    expect(epic.derived.started).toBe(true);
    expect(labels(epic)).toEqual([]);
    expect(shown(get(derived, "epic/part"))).toBe("ready · started");
    expect(shown(get(derived, "planned"))).toBe("open 0/1 · started");
  });
});

/* ------------------------------------------------------------------------ */
/* The spec's table of tasks that are not being worked                      */
/* ------------------------------------------------------------------------ */

describe("the agent protocol's Shown column", () => {
  it("reads as the spec draws it", async () => {
    const derived = await derive(
      {
        tasks: {
          free: {},
          waits: { depends_on: ["x"] },
          unscheduled: { status: "BACKLOG" },
          deploy: { assignee: "alice" },
          worked: { status: "IN_PROGRESS", claimed_session: "s1" },
          paused: { status: "PAUSED", state: true },
          crashed: { status: "IN_PROGRESS", claimed_session: "s2" },
          "paused-waits": { status: "PAUSED", state: true, depends_on: ["x"] },
          review: { status: "PAUSED", state: true, assignee: "alice" },
          "after-y": { status: "PAUSED", state: true, depends_on: ["y"] },
          "set-aside": { status: "BACKLOG", state: true },
          dropped: { status: "CANCELLED", state: true },
          confirm: { status: "PAUSED", state: true, assignee: "alice" },
          epic: {},
          "epic/a": { status: "DONE" },
          "epic/b": { status: "DONE" },
          "epic/c": { status: "IN_PROGRESS", state: true },
          "epic/d": {},
          "epic/e": {},
          planned: { status: "PAUSED", state: true, assignee: "alice" },
          "planned/part": {},
          parked: { status: "BACKLOG" },
          "parked/begun": { status: "BACKLOG", state: true },
          "parked/fresh": { status: "BACKLOG" },
        },
      },
      {
        overrides: {
          start: {
            waits: blockedBy(unsatisfiedRef("x")),
            "paused-waits": blockedBy(unsatisfiedRef("x")),
            "after-y": blockedBy(unsatisfiedRef("y")),
          },
          liveness: { worked: LIVE, crashed: ORPHANED },
        },
      },
    );
    const table: Record<string, string> = {
      free: "ready",
      waits: "blocked by x",
      unscheduled: "backlog",
      deploy: "assigned alice",
      worked: "working by tester · live",
      paused: "ready · started",
      crashed: "working by tester · orphaned since 2026-09-21T16:40:12Z",
      "paused-waits": "blocked by x · started",
      review: "waiting for alice",
      "after-y": "blocked by y · started",
      "set-aside": "parked",
      dropped: "cancelled",
      confirm: "waiting for alice",
      epic: "open 2/5 · active",
      planned: "waiting for alice",
      "planned/part": "held by planned",
      parked: "parked",
      "parked/begun": "parked",
      "parked/fresh": "backlog",
    };
    for (const [id, line] of Object.entries(table)) {
      expect([id, shown(get(derived, id))]).toEqual([id, line]);
    }
    // First in ready: the paused task, among equals.
    expect(readySet(derived.values(), { scope: null })[0]!.json.id).toBe(
      "paused",
    );
  });
});
