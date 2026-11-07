import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GateResolver,
  UNSATISFIABLE_REASONS,
  describeRef,
  toBlockedBy,
  unavailableReason,
} from "../src/core/gates.js";
import type { LoadedTree, ProjectLoad } from "../src/core/projects.js";
import { Projects } from "../src/core/projects.js";
import { findTask } from "../src/core/tree.js";
import type { GateReason, ResolvedRef, Status } from "../src/core/types.js";
import type { TaskError } from "../src/errors.js";
import { isTaskError } from "../src/errors.js";
import { addProjectAlias, renderSpec, writeTree } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { makeSandbox } from "./helpers.js";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await makeSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

async function caughtAsync(promise: Promise<unknown>): Promise<TaskError> {
  try {
    await promise;
  } catch (err) {
    if (isTaskError(err)) return err;
    throw err;
  }
  throw new Error("expected a TaskError");
}

function ok(load: ProjectLoad): LoadedTree {
  if (load.kind !== "ok") throw new Error(`expected a tree, got ${load.kind}`);
  return load;
}

function sibling(...segments: string[]): string {
  return path.join(sandbox.root, ...segments);
}

async function open(): Promise<{ projects: Projects; gates: GateResolver }> {
  const projects = new Projects(await sandbox.loadTree());
  return { projects, gates: new GateResolver(projects) };
}

function resolved(
  ref: string,
  project: string | null,
  id: string,
  reason: GateReason | null,
  status: Status | null,
): ResolvedRef {
  return { ref, project, id, satisfied: reason === null, reason, status };
}

/** A sibling tree listed as `alias` whose `config.yml` says `version`. */
async function versionedProject(
  alias: string,
  version: number,
  tasks: Record<string, object> = {},
): Promise<void> {
  await sandbox.project(alias, `../${alias}`, { tasks });
  await sandbox.write(`../${alias}/.tasks/config.yml`, `version: ${version}\n`);
}

describe("resolving references", () => {
  beforeEach(async () => {
    await sandbox.tree({
      tasks: {
        done: { status: "DONE" },
        todo: {},
        wip: { status: "IN_PROGRESS" },
        gone: { status: "CANCELLED" },
        free: {},
      },
      archived: { old: { status: "DONE" } },
    });
    await sandbox.write(".tasks/broken/task.md", "# no frontmatter\n");
    await sandbox.write(".tasks/.archive/old-broken/task.md", "garbage\n");
    await sandbox.project("backend", "../backend", {
      tasks: { api: { status: "DONE" }, wip: {} },
    });
    await addProjectAlias(sandbox.tasksDir, "ghost", "../ghost");
    await versionedProject("legacy", 1, { a: { status: "DONE" } });
    await versionedProject("future", 3, { a: { status: "DONE" } });
    await sandbox.write("../plain/README.md", "no tree here\n");
    await writeTree(sibling("bare", ".tasks"), {
      tasks: { z: { status: "DONE" } },
    });
  });

  it("gives every unsatisfied reference exactly one reason", async () => {
    const { projects, gates } = await open();
    const local = projects.local;

    const expected: ResolvedRef[] = [
      resolved("done", null, "done", null, "DONE"),
      resolved("todo", null, "todo", "not-done", "TODO"),
      resolved("wip", null, "wip", "not-done", "IN_PROGRESS"),
      resolved("gone", null, "gone", "cancelled", "CANCELLED"),
      resolved("nowhere", null, "nowhere", "missing", null),
      resolved("old", null, "old", "archived", null),
      resolved("old-broken", null, "old-broken", "archived", null),
      resolved("broken", null, "broken", "malformed", null),
      resolved("../plain:x", "../plain", "x", "unresolved-project", null),
      resolved("../ghost:x", "ghost", "x", "not-checked-out", null),
      resolved("../legacy:a", "legacy", "a", "unsupported-version", null),
      resolved("../future:a", "future", "a", "unsupported-version", null),
      resolved("../backend:api", "backend", "api", null, "DONE"),
      resolved("../backend:wip", "backend", "wip", "not-done", "TODO"),
      resolved("../backend:nope", "backend", "nope", "missing", null),
      resolved("../bare:z", "../bare", "z", null, "DONE"),
    ];
    for (const want of expected) {
      expect(await gates.resolveRef(local, want.ref)).toEqual(want);
    }
    expect(
      await gates.resolveRefs(
        local,
        expected.map((want) => want.ref),
      ),
    ).toEqual(expected);
  });

  it("resolves a reference that does not parse as missing, without throwing", async () => {
    const { projects, gates } = await open();
    for (const raw of [
      "Not A Ref",
      "/abs:x",
      ":x",
      "a//b",
      "../backend:",
      "",
    ]) {
      expect(await gates.resolveRef(projects.local, raw)).toEqual(
        resolved(raw, null, raw, "missing", null),
      );
    }
  });

  it("names the project from the local tree's point of view", async () => {
    const { projects, gates } = await open();
    const backend = ok(await projects.byAlias("backend"));
    const bare = ok(await projects.byPath(projects.local, "../bare"));

    expect(await gates.resolveRef(backend, "../repo:done")).toEqual(
      resolved("../repo:done", null, "done", null, "DONE"),
    );
    expect(await gates.resolveRef(backend, "api")).toEqual(
      resolved("api", "backend", "api", null, "DONE"),
    );
    expect(await gates.resolveRef(projects.local, "../repo:todo")).toEqual(
      resolved("../repo:todo", null, "todo", "not-done", "TODO"),
    );
    expect(await gates.resolveRef(bare, "z")).toEqual(
      resolved("z", "../bare", "z", null, "DONE"),
    );
    const foreign = await gates.gatesForTree(backend);
    expect([...foreign.keys()]).toEqual(["api", "wip"]);
    expect(foreign.get("api")!.finish).toEqual({
      satisfied: true,
      open_children: [],
      refs: [],
    });
  });

  it("follows reloads of every tree, before and after invalidate", async () => {
    const { projects, gates } = await open();
    const backend = ok(await projects.byAlias("backend"));
    expect((await gates.resolveRef(projects.local, "todo")).satisfied).toBe(
      false,
    );
    expect(
      (await gates.resolveRef(projects.local, "../backend:wip")).satisfied,
    ).toBe(false);

    await sandbox.write(
      ".tasks/todo/task.md",
      renderSpec("todo", { status: "DONE" }),
    );
    await sandbox.write(
      "../backend/.tasks/wip/task.md",
      renderSpec("wip", { status: "DONE" }),
    );
    const local = await projects.reload(projects.local);
    await projects.reload(backend);

    expect(await gates.resolveRef(local, "../backend:wip")).toMatchObject({
      satisfied: true,
      status: "DONE",
    });
    gates.invalidate();
    expect(await gates.resolveRef(local, "todo")).toMatchObject({
      satisfied: true,
      status: "DONE",
    });
  });

  it("maps unavailable trees to their reasons", () => {
    const base = { alias: null, relPath: "../x", dir: "/x" };
    expect(unavailableReason({ kind: "not-checked-out", ...base })).toBe(
      "not-checked-out",
    );
    expect(
      unavailableReason({ kind: "unresolved", ...base, cause: null }),
    ).toBe("unresolved-project");
    expect(
      unavailableReason({ kind: "unsupported-version", ...base, version: 1 }),
    ).toBe("unsupported-version");
    expect(UNSATISFIABLE_REASONS).not.toContain("not-done");
    expect(UNSATISFIABLE_REASONS).not.toContain("malformed");
  });
});

describe("start gate", () => {
  it("is satisfied by live DONE tasks only, and trivially by no references", async () => {
    await sandbox.tree({
      tasks: {
        done: { status: "DONE" },
        todo: {},
        gone: { status: "CANCELLED" },
        free: {},
        ready: { depends_on: ["done"] },
        blocked: { depends_on: ["done", "todo", "gone", "nowhere", "Bad Ref"] },
      },
    });
    const { projects, gates } = await open();
    const tree = projects.local.tree;

    expect(
      await gates.startGate(projects.local, findTask(tree, "free")),
    ).toEqual({ satisfied: true, refs: [] });
    expect(
      (await gates.startGate(projects.local, findTask(tree, "ready")))
        .satisfied,
    ).toBe(true);

    const gate = await gates.startGate(
      projects.local,
      findTask(tree, "blocked"),
    );
    expect(gate.satisfied).toBe(false);
    expect(gate.refs.map((ref) => ref.ref)).toEqual([
      "done",
      "todo",
      "gone",
      "nowhere",
      "Bad Ref",
    ]);
    expect(toBlockedBy(gate.refs)).toEqual([
      { ref: "todo", reason: "not-done", status: "TODO" },
      { ref: "gone", reason: "cancelled", status: "CANCELLED" },
      { ref: "nowhere", reason: "missing", status: null },
      { ref: "Bad Ref", reason: "missing", status: null },
    ]);
  });
});

describe("finish gate", () => {
  beforeEach(async () => {
    await sandbox.tree({
      tasks: {
        epic: {},
        "epic/open": {},
        "epic/open/deeper": {},
        "epic/g/finished": { status: "DONE" },
        "epic/dropped": { status: "CANCELLED" },
        closed: {},
        "closed/a": { status: "DONE" },
        "closed/b": { status: "CANCELLED" },
        joins: { finishes_after: ["gone", "done"] },
        lost: { finishes_after: ["nowhere"] },
        pending: { finishes_after: ["todo"] },
        stranded: { depends_on: ["gone"] },
        gone: { status: "CANCELLED" },
        done: { status: "DONE" },
        todo: {},
      },
    });
    await sandbox.write(".tasks/epic/broken/task.md", "garbage\n");
  });

  it("waits for open and malformed children, not for resolved ones", async () => {
    const { projects, gates } = await open();
    const tree = projects.local.tree;

    expect(
      await gates.finishGate(projects.local, findTask(tree, "epic")),
    ).toEqual({
      satisfied: false,
      open_children: ["epic/broken", "epic/open"],
      refs: [],
    });
    expect(
      await gates.finishGate(projects.local, findTask(tree, "closed")),
    ).toEqual({ satisfied: true, open_children: [], refs: [] });
  });

  it("is satisfied by a cancelled finishes_after target, unlike the start gate", async () => {
    const { projects, gates } = await open();
    const tree = projects.local.tree;

    expect(
      await gates.finishGate(projects.local, findTask(tree, "joins")),
    ).toEqual({
      satisfied: true,
      open_children: [],
      refs: [
        resolved("gone", null, "gone", null, "CANCELLED"),
        resolved("done", null, "done", null, "DONE"),
      ],
    });
    const start = await gates.startGate(
      projects.local,
      findTask(tree, "stranded"),
    );
    expect(start.refs).toEqual([
      resolved("gone", null, "gone", "cancelled", "CANCELLED"),
    ]);
  });

  it("is blocked by a missing or open finishes_after target", async () => {
    const { projects, gates } = await open();
    const tree = projects.local.tree;

    const lost = await gates.finishGate(projects.local, findTask(tree, "lost"));
    expect(lost.satisfied).toBe(false);
    expect(toBlockedBy(lost.refs)).toEqual([
      { ref: "nowhere", reason: "missing", status: null },
    ]);
    const pending = await gates.finishGate(
      projects.local,
      findTask(tree, "pending"),
    );
    expect(pending.satisfied).toBe(false);
    expect(toBlockedBy(pending.refs)).toEqual([
      { ref: "todo", reason: "not-done", status: "TODO" },
    ]);
  });

  it("computes both gates for every live task in one pass", async () => {
    const { projects, gates } = await open();
    const local = projects.local;
    const all = await gates.gatesForTree(local);

    expect([...all.keys()]).toEqual(local.tree.tasks.map((task) => task.id));
    for (const task of local.tree.tasks) {
      expect(all.get(task.id)).toEqual({
        start: await gates.startGate(local, task),
        finish: await gates.finishGate(local, task),
      });
    }
  });
});

describe("labels", () => {
  it("shows the reason unless the reference is merely not done yet", () => {
    expect(describeRef(resolved("done", null, "done", null, "DONE"))).toBe(
      "done",
    );
    expect(
      describeRef(resolved("todo", null, "todo", "not-done", "TODO")),
    ).toBe("todo");
    expect(
      describeRef(resolved("gone", null, "gone", "cancelled", "CANCELLED")),
    ).toBe("gone (cancelled)");
    expect(
      describeRef(
        resolved("../backend:wip", "backend", "wip", "not-done", "TODO"),
      ),
    ).toBe("backend:wip");
    expect(
      describeRef(
        resolved("../ghost:x", "ghost", "x", "not-checked-out", null),
      ),
    ).toBe("ghost:x (not-checked-out)");
    expect(
      describeRef(resolved("Bad Ref", null, "Bad Ref", "missing", null)),
    ).toBe("Bad Ref (missing)");
  });
});

describe("referenced by, dependents", () => {
  it("finds referencing tasks in the local tree and listed trees, qualified", async () => {
    await sandbox.tree({
      tasks: {
        target: {},
        a: { depends_on: ["target"] },
        b: { finishes_after: ["target"] },
        both: { depends_on: ["target"], finishes_after: ["../repo:target"] },
        c: { depends_on: ["other"] },
        other: {},
        reads: { depends_on: ["../bare:z"] },
      },
    });
    await sandbox.write(".tasks/broken/task.md", "garbage\n");
    await sandbox.project("backend", "../backend", {
      tasks: {
        x: { depends_on: ["../repo:target"] },
        y: { finishes_after: ["../repo:target"] },
        target: {},
        w: { depends_on: ["target"] },
      },
    });
    await writeTree(sibling("bare", ".tasks"), {
      tasks: { z: { depends_on: ["../repo:target"] } },
    });
    const { projects, gates } = await open();
    const backend = ok(await projects.byAlias("backend"));
    // The bare tree loads (a local task reads it) but is never searched.
    ok(await projects.byPath(projects.local, "../bare"));

    expect(await gates.referencedBy(projects.local, "target")).toEqual([
      "a",
      "b",
      "both",
      "backend:x",
      "backend:y",
    ]);
    expect(await gates.referencedBy(backend, "target")).toEqual(["backend:w"]);
    expect(await gates.referencedBy(projects.local, "a")).toEqual([]);
  });

  it("lists the open dependents of several targets once, by depends_on only", async () => {
    await sandbox.tree({
      tasks: {
        t1: {},
        t3: { depends_on: ["t1"] },
        a: { depends_on: ["t1"] },
        b: { depends_on: ["t1", "../backend:t2"] },
        c: { finishes_after: ["t1"] },
        // Resolved: nothing left to decide, so not a dependent.
        g: { depends_on: ["t1"], status: "DONE" },
        d: { depends_on: ["unrelated"] },
        unrelated: {},
      },
    });
    await sandbox.project("backend", "../backend", {
      tasks: {
        t2: {},
        e: { depends_on: ["t2"] },
        f: { depends_on: ["../repo:t1"] },
      },
    });
    const { projects, gates } = await open();
    const backend = ok(await projects.byAlias("backend"));

    expect(
      await gates.dependentsOf([
        { tree: projects.local, id: "t1" },
        { tree: projects.local, id: "t3" },
        { tree: backend, id: "t2" },
      ]),
    ).toEqual(["a", "b", "backend:e", "backend:f"]);
    expect(await gates.dependentsOf([])).toEqual([]);
  });

  it("keeps the target of a reference to a task that is not there", async () => {
    await sandbox.tree({
      tasks: { a: { depends_on: ["nowhere", "../ghost:x", "Bad Ref"] } },
    });
    await addProjectAlias(sandbox.tasksDir, "ghost", "../ghost");
    const { projects, gates } = await open();

    const sites = await gates.referenceSites();
    expect(
      sites.map((site) => [site.task, site.ref, site.target?.id ?? null]),
    ).toEqual([
      ["a", "nowhere", "nowhere"],
      ["a", "../ghost:x", null],
      ["a", "Bad Ref", null],
    ]);
    expect(sites[0]!.target!.tree).toBe(projects.local);
    expect(sites[0]!.resolved.reason).toBe("missing");
  });
});

describe("dependency editing", () => {
  beforeEach(async () => {
    await sandbox.tree({
      tasks: {
        a: { depends_on: ["b"] },
        b: {},
        epic: {},
        "epic/mid": {},
        "epic/mid/leaf": {},
        "epic/part": { depends_on: ["x"] },
        x: {},
        gone: { status: "CANCELLED" },
        loop: {},
      },
      archived: { old: { status: "DONE" } },
    });
    await sandbox.write(".tasks/broken/task.md", "garbage\n");
    await sandbox.project("backend", "../backend", {
      tasks: { back: { depends_on: ["../repo:loop"] } },
    });
    await addProjectAlias(sandbox.tasksDir, "ghost", "../ghost");
  });

  async function refusal(
    taskId: string,
    field: "depends_on" | "finishes_after",
    ref: string,
  ): Promise<TaskError> {
    const { projects, gates } = await open();
    const task = findTask(projects.local.tree, taskId);
    return caughtAsync(
      gates.checkDependencyEdit(projects.local, task, field, ref),
    );
  }

  it("refuses a self-reference and a reference that does not parse", async () => {
    const self = await refusal("a", "depends_on", "a");
    expect(self.exitCode).toBe(2);
    expect(self.details).toEqual({ id: "a", field: "depends_on", ref: "a" });
    expect((await refusal("a", "finishes_after", "../repo:a")).exitCode).toBe(
      2,
    );
    expect((await refusal("a", "depends_on", "Bad Ref")).exitCode).toBe(2);
  });

  it("refuses a target that is not a live task, naming the reason", async () => {
    for (const [ref, reason] of [
      ["nowhere", "missing"],
      ["old", "archived"],
      ["broken", "malformed"],
      ["../ghost:x", "not-checked-out"],
      ["../backend:nope", "missing"],
    ] as const) {
      const err = await refusal("a", "depends_on", ref);
      expect(err.exitCode).toBe(3);
      expect(err.details).toEqual({
        id: "a",
        field: "depends_on",
        ref,
        reason,
      });
    }
  });

  it("refuses a reference to the task's own ancestor, in both fields", async () => {
    for (const [taskId, field, ref, ancestor] of [
      ["epic/mid", "depends_on", "epic", "epic"],
      ["epic/mid/leaf", "depends_on", "epic/mid", "epic/mid"],
      ["epic/mid/leaf", "depends_on", "epic", "epic"],
      ["epic/mid", "finishes_after", "epic", "epic"],
      ["epic/mid/leaf", "finishes_after", "epic", "epic"],
      ["epic/mid/leaf", "finishes_after", "../repo:epic/mid", "epic/mid"],
    ] as const) {
      const err = await refusal(taskId, field, ref);
      expect(err.exitCode).toBe(4);
      expect(err.details).toEqual({
        id: taskId,
        field,
        ref,
        kind: "ancestor",
        ancestor,
      });
    }
  });

  it("refuses a two-task cycle through depends_on", async () => {
    const err = await refusal("b", "depends_on", "a");
    expect(err.exitCode).toBe(4);
    expect(err.details).toEqual({
      id: "b",
      field: "depends_on",
      ref: "a",
      kind: "cycle",
      cycle: ["b", "a"],
    });
    expect(err.message).toContain("b → a → b");
  });

  it("refuses a cycle that runs through a child's finish edge", async () => {
    for (const field of ["depends_on", "finishes_after"] as const) {
      const err = await refusal("x", field, "epic");
      expect(err.exitCode).toBe(4);
      expect(err.details).toMatchObject({
        kind: "cycle",
        cycle: ["x", "epic", "epic/part"],
      });
    }
  });

  it("refuses a cycle through a listed tree", async () => {
    const err = await refusal("loop", "depends_on", "../backend:back");
    expect(err.exitCode).toBe(4);
    expect(err.details).toMatchObject({
      kind: "cycle",
      cycle: ["loop", "backend:back"],
    });
  });

  it("accepts every other edit", async () => {
    const { projects, gates } = await open();
    const local = projects.local;
    const tree = local.tree;
    for (const [taskId, field, ref] of [
      ["epic", "depends_on", "epic/part"],
      ["epic", "finishes_after", "epic/mid/leaf"],
      ["a", "depends_on", "gone"],
      ["a", "finishes_after", "x"],
      ["x", "depends_on", "../backend:back"],
    ] as const) {
      await expect(
        gates.checkDependencyEdit(local, findTask(tree, taskId), field, ref),
      ).resolves.toBeUndefined();
    }
  });
});

describe("cycles", () => {
  it("reports whether an edge would close a cycle", async () => {
    await sandbox.tree({
      tasks: { a: { depends_on: ["b"] }, b: {}, c: {} },
    });
    await addProjectAlias(sandbox.tasksDir, "ghost", "../ghost");
    const { projects, gates } = await open();
    const local = projects.local;

    expect(await gates.wouldCreateCycle(local, "b", "depends_on", "a")).toEqual(
      ["b", "a"],
    );
    expect(await gates.wouldCreateCycle(local, "a", "depends_on", "a")).toEqual(
      ["a"],
    );
    expect(
      await gates.wouldCreateCycle(local, "c", "depends_on", "a"),
    ).toBeNull();
    expect(
      await gates.wouldCreateCycle(local, "b", "depends_on", "nowhere"),
    ).toBeNull();
    expect(
      await gates.wouldCreateCycle(local, "b", "depends_on", "Bad Ref"),
    ).toBeNull();
  });

  it("treats an edge into a tree that did not load as a non-edge", async () => {
    await sandbox.tree({ tasks: { a: {} } });
    // Both would close a cycle, if they could be read.
    await versionedProject("legacy", 1, { l: { depends_on: ["../repo:a"] } });
    await addProjectAlias(sandbox.tasksDir, "ghost", "../ghost");
    const { projects, gates } = await open();
    const local = projects.local;

    expect(
      await gates.wouldCreateCycle(local, "a", "depends_on", "../legacy:l"),
    ).toBeNull();
    expect(
      await gates.wouldCreateCycle(local, "a", "depends_on", "../ghost:g"),
    ).toBeNull();
  });

  it("finds every cycle through the local tree once", async () => {
    await sandbox.tree({
      tasks: {
        a: { depends_on: ["b"] },
        b: { depends_on: ["a"] },
        c: { depends_on: ["d"] },
        d: { finishes_after: ["e"] },
        e: { depends_on: ["c"] },
        s: { depends_on: ["s"] },
        p: {},
        "p/child": { depends_on: ["q"] },
        q: { depends_on: ["p"] },
        fine: { depends_on: ["a"] },
        loop: { depends_on: ["../backend:back"] },
        thru: { depends_on: ["../bare:z"] },
        dead: { depends_on: ["../ghost:g", "../legacy:l"] },
      },
    });
    await sandbox.project("backend", "../backend", {
      tasks: {
        back: { depends_on: ["../repo:loop"] },
        inner1: { depends_on: ["inner2"] },
        inner2: { depends_on: ["inner1"] },
      },
    });
    await writeTree(sibling("bare", ".tasks"), {
      tasks: { z: { depends_on: ["../repo:thru"] } },
    });
    await addProjectAlias(sandbox.tasksDir, "ghost", "../ghost");
    await versionedProject("legacy", 1, {
      l: { depends_on: ["../repo:dead"] },
    });
    const { projects, gates } = await open();

    // `thru` and `../bare:z` wait on each other, but the bare tree is not
    // listed under `projects:`, so that edge is not traversable and no cycle
    // is reported for it.
    expect(await gates.findCycles(projects.local)).toEqual([
      ["a", "b"],
      ["c", "d", "e"],
      ["loop", "backend:back"],
      ["p", "p/child", "q"],
      ["s"],
    ]);
  });

  it("reports overlapping cycles separately, and nothing for a graph without one", async () => {
    await sandbox.tree({
      tasks: {
        m: { depends_on: ["n"] },
        n: { depends_on: ["m", "o"] },
        o: { depends_on: ["n"] },
      },
    });
    const { projects, gates } = await open();
    expect(await gates.findCycles(projects.local)).toEqual([
      ["m", "n"],
      ["n", "o"],
    ]);

    await sandbox.tree({
      tasks: {
        m: {},
        n: { depends_on: ["m"] },
        o: { depends_on: ["n", "m"] },
        "o/part": { depends_on: ["m"] },
      },
    });
    const fresh = await open();
    expect(await fresh.gates.findCycles(fresh.projects.local)).toEqual([]);
  });

  it("reports tasks that depend on their own ancestor", async () => {
    await sandbox.tree({
      tasks: {
        epic: {},
        "epic/a": { depends_on: ["epic"] },
        "epic/a/x": { depends_on: ["epic", "epic/a", "other"] },
        "epic/c": { depends_on: ["epic/g"] },
        "epic/d": { depends_on: ["../backend:epic"] },
        "epic/g/b": { finishes_after: ["epic"] },
        other: {},
      },
    });
    const { projects, gates } = await open();

    expect(gates.ancestorDependencies(projects.local)).toEqual([
      { id: "epic/a", field: "depends_on", ref: "epic" },
      { id: "epic/a/x", field: "depends_on", ref: "epic" },
      { id: "epic/a/x", field: "depends_on", ref: "epic/a" },
      { id: "epic/g/b", field: "finishes_after", ref: "epic" },
    ]);
  });
});
