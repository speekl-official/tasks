import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MoveJson } from "../src/core/relocate.js";
import type { CollectionJson, ValidationJson } from "../src/core/types.js";
import { MOVING_MARKER_FILENAME } from "../src/core/types.js";
import type { TreeSpec } from "./fixtures.js";
import { DEFAULT_STATE, FIXTURE_TIME, writeTree } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";
import {
  errorOf,
  frontmatterOf,
  heartbeat,
  lastEntry,
  lastSeen,
  logTexts,
  plain,
  refusal,
} from "./transitions-support.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

/** Minutes past the default 30-minute session timeout. */
const STALE = 31;

async function box(spec: TreeSpec): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

async function move(s: Sandbox, ...argv: string[]): Promise<MoveJson> {
  const result = await s.run("move", ...argv, "--json");
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return result.json<MoveJson>();
}

/** Ids of the live tasks of the local tree, in tree order. */
async function liveIds(s: Sandbox): Promise<string[]> {
  return [...(await s.loadTree()).byId.keys()];
}

describe("move: relocation", () => {
  it("moves a task with its subtree: new ids, new parent, every file travels", async () => {
    const s = await box({
      tasks: {
        "old/x": {
          state: "## Done\nhalf of it\n",
          design: true,
          log: "## 2026-01-02T00:00:00Z tester\nnew: TODO\n",
          created: "2026-01-02T00:00:00Z",
        },
        "old/x/c": {},
        dest: {},
      },
    });
    await s.write(".tasks/old/x/notes/sketch.txt", "workspace content\n");

    // A suffix names the source; the destination is taken as written.
    expect(await move(s, "x", "dest/x")).toEqual({
      from: "old/x",
      to: "dest/x",
      kind: "task",
      tasks: [
        { from: "old/x", to: "dest/x" },
        { from: "old/x/c", to: "dest/x/c" },
      ],
      deferred: [],
      rewritten: [],
      unrewritten: [],
      skipped: [],
    });

    const tree = await s.loadTree();
    expect([...tree.byId.keys()]).toEqual(["dest", "dest/x", "dest/x/c"]);
    expect(tree.byId.get("dest/x")?.parent).toBe("dest");
    expect(tree.byId.get("dest/x/c")?.parent).toBe("dest/x");
    // The group the source leaves empty goes with it.
    expect(await s.exists(".tasks/old")).toBe(false);

    expect(await s.read(".tasks/dest/x/state.md")).toBe(
      "## Done\nhalf of it\n",
    );
    expect(await s.read(".tasks/dest/x/design.md")).toBe("# Design\n");
    expect(await s.read(".tasks/dest/x/notes/sketch.txt")).toBe(
      "workspace content\n",
    );
    // A pure relocation changes no field: `created` and `updated` stay.
    expect(await frontmatterOf(s, "dest/x")).toMatchObject({
      created: "2026-01-02T00:00:00Z",
      updated: "2026-01-02T00:00:00Z",
    });
    expect(await logTexts(s, "dest/x")).toEqual([
      "new: TODO",
      "move: old/x → dest/x",
    ]);
    expect(await logTexts(s, "dest/x/c")).toEqual(["move: old/x/c → dest/x/c"]);
    expect((await lastEntry(s, "dest/x")).actor).toBe("tester");
  });

  it("moves a group: every task beneath it is renamed, the group logs nothing", async () => {
    const s = await box({
      tasks: {
        "phase1/a": {},
        "phase1/sub/b": {},
        "phase1/sub/b/c": {},
        epic: {},
      },
    });
    await s.write(".tasks/phase1/README.md", "about phase 1\n");

    const json = await move(s, "phase1", "epic/phase1");
    expect(json).toMatchObject({
      from: "phase1",
      to: "epic/phase1",
      kind: "group",
    });
    expect(json.tasks).toEqual([
      { from: "phase1/a", to: "epic/phase1/a" },
      { from: "phase1/sub/b", to: "epic/phase1/sub/b" },
      { from: "phase1/sub/b/c", to: "epic/phase1/sub/b/c" },
    ]);

    const tree = await s.loadTree();
    // Containment follows the paths: the group's top tasks are epic's now.
    expect(tree.byId.get("epic/phase1/a")?.parent).toBe("epic");
    expect(tree.byId.get("epic/phase1/sub/b")?.parent).toBe("epic");
    expect(tree.byId.get("epic/phase1/sub/b/c")?.parent).toBe(
      "epic/phase1/sub/b",
    );
    expect(tree.groups.has("epic/phase1")).toBe(true);
    expect(await s.read(".tasks/epic/phase1/README.md")).toBe(
      "about phase 1\n",
    );
    expect(await s.exists(".tasks/epic/phase1/log.md")).toBe(false);
    expect(await s.exists(".tasks/phase1")).toBe(false);
    expect(await logTexts(s, "epic/phase1/a")).toEqual([
      "move: phase1/a → epic/phase1/a",
    ]);
  });

  it("moves a group that holds no task", async () => {
    const s = await box({ groups: ["empty"], tasks: { t: {} } });
    expect(await move(s, "empty", "later/empty")).toEqual({
      from: "empty",
      to: "later/empty",
      kind: "group",
      tasks: [],
      deferred: [],
      rewritten: [],
      unrewritten: [],
      skipped: [],
    });
    expect(await s.exists(".tasks/later/empty")).toBe(true);
    expect(await s.exists(".tasks/empty")).toBe(false);
  });

  it("removes the groups the source leaves empty, and only those", async () => {
    const s = await box({ tasks: { "g1/g2/x": {}, "h/y": {} } });
    await s.write(".tasks/h/notes.md", "kept\n");

    await move(s, "g1/g2/x", "x");
    expect(await s.exists(".tasks/g1")).toBe(false);

    await move(s, "h/y", "y");
    expect(await s.exists(".tasks/h/y")).toBe(false);
    expect(await s.read(".tasks/h/notes.md")).toBe("kept\n");
    expect(await liveIds(s)).toEqual(["x", "y"]);
  });

  it("regenerates index.md when the tree has one", async () => {
    const s = await box({ tasks: { "a/x": { title: "Moved task" } } });
    expect((await s.run("reindex")).code).toBe(0);
    expect(await s.read(".tasks/index.md")).toContain("[a/x](a/x/)");

    await move(s, "a/x", "b/x");
    const index = await s.read(".tasks/index.md");
    expect(index).toContain("[b/x](b/x/) — Moved task");
    expect(index).not.toContain("a/x");
    const validation = (
      await s.run("validate", "--json")
    ).json<ValidationJson>();
    expect(validation.findings).toEqual([]);
  });

  it("prints one line, what moved along, the rewrites and what it could not rewrite", async () => {
    const s = await box({
      tasks: {
        "a/x": {},
        "a/x/c": {},
        y: { depends_on: ["a/x"] },
        l: { depends_on: ["../bare:q"] },
      },
    });
    await writeTree(path.join(s.root, "bare", ".tasks"), {
      tasks: { q: { depends_on: ["../repo:a/x/c"] } },
    });

    const result = await s.run("move", "a/x", "b/x");
    expect(result.code).toBe(0);
    const out = plain(result.stdout).split("\n");
    expect(out[0]).toBe("✓ move a/x → b/x");
    expect(out).toContain("  a/x/c → b/x/c");
    expect(out).toContain("  rewritten in this tree:");
    expect(out).toContain("    y depends_on: a/x → b/x");
    expect(out).toContain(
      "  ! not rewritten: ../bare:q depends_on ../repo:a/x/c",
    );
  });
});

describe("move: references", () => {
  it("rewrites every local reference to a moved task, in both fields", async () => {
    const s = await box({
      tasks: {
        "a/x": {},
        "a/x/c": {},
        "a/x/d": { depends_on: ["a/x/c"] },
        y: { depends_on: ["a/x"], finishes_after: ["a/x/c", "w"] },
        z: { depends_on: ["a/x/c", "a/x/ghost"] },
        w: {},
      },
    });

    const json = await move(s, "a/x", "b/x");
    expect(json.rewritten).toEqual([
      {
        project: null,
        task: "b/x/d",
        field: "depends_on",
        from: "a/x/c",
        to: "b/x/c",
      },
      { project: null, task: "y", field: "depends_on", from: "a/x", to: "b/x" },
      {
        project: null,
        task: "y",
        field: "finishes_after",
        from: "a/x/c",
        to: "b/x/c",
      },
      {
        project: null,
        task: "z",
        field: "depends_on",
        from: "a/x/c",
        to: "b/x/c",
      },
    ]);

    expect(await frontmatterOf(s, "y")).toMatchObject({
      depends_on: ["b/x"],
      finishes_after: ["b/x/c", "w"],
    });
    expect((await frontmatterOf(s, "b/x/d")).depends_on).toEqual(["b/x/c"]);
    // A path beneath the source where no task lives names nothing that
    // moved, so it is left as stored.
    expect((await frontmatterOf(s, "z")).depends_on).toEqual([
      "b/x/c",
      "a/x/ghost",
    ]);

    // `updated` follows the frontmatter: stamped where a reference changed,
    // left alone on a task that only moved and on one nothing touched.
    const stamp = (await frontmatterOf(s, "y")).updated;
    expect(stamp).not.toBe(FIXTURE_TIME);
    expect((await frontmatterOf(s, "z")).updated).toBe(stamp);
    expect((await frontmatterOf(s, "b/x/d")).updated).toBe(stamp);
    expect((await frontmatterOf(s, "b/x")).updated).toBe(FIXTURE_TIME);
    expect((await frontmatterOf(s, "w")).updated).toBe(FIXTURE_TIME);
    // One instant for the whole command; a rewrite is not logged.
    expect((await lastEntry(s, "b/x/d")).time).toBe(stamp);
    expect(await s.exists(".tasks/y/log.md")).toBe(false);
  });

  it("rewrites references in a listed tree, keeping the stored project path", async () => {
    const s = await box({ tasks: { "a/x": {}, "a/x/c": {} } });
    const backend = await s.project("backend", "../backend", {
      tasks: {
        k: { depends_on: ["../repo:a/x"], finishes_after: ["../repo:a/x/c"] },
        j: { depends_on: ["k"] },
      },
    });

    const json = await move(s, "a/x", "b/x");
    expect(json.rewritten).toEqual([
      {
        project: "backend",
        task: "k",
        field: "depends_on",
        from: "../repo:a/x",
        to: "../repo:b/x",
      },
      {
        project: "backend",
        task: "k",
        field: "finishes_after",
        from: "../repo:a/x/c",
        to: "../repo:b/x/c",
      },
    ]);
    expect(json.unrewritten).toEqual([]);
    const k = await frontmatterOf(s, "k", backend);
    expect(k).toMatchObject({
      depends_on: ["../repo:b/x"],
      finishes_after: ["../repo:b/x/c"],
    });
    expect(k.updated).not.toBe(FIXTURE_TIME);
    expect((await frontmatterOf(s, "j", backend)).updated).toBe(FIXTURE_TIME);
    expect(await logTexts(s, "k", backend)).toEqual([]);
  });

  it("reports the references a bare-path tree holds, and leaves that tree alone", async () => {
    const s = await box({
      tasks: { "a/x": {}, l: { depends_on: ["../bare:q"] } },
    });
    const bare = path.join(s.root, "bare", ".tasks");
    await writeTree(bare, {
      tasks: {
        q: { depends_on: ["../repo:a/x"] },
        r: { finishes_after: ["../repo:a/x", "q"] },
      },
    });
    const before = await fs.readFile(path.join(bare, "q", "task.md"), "utf8");

    const json = await move(s, "a/x", "b/x");
    expect(json.rewritten).toEqual([]);
    expect(json.unrewritten).toEqual([
      {
        project: "../bare",
        task: "q",
        field: "depends_on",
        ref: "../repo:a/x",
      },
      {
        project: "../bare",
        task: "r",
        field: "finishes_after",
        ref: "../repo:a/x",
      },
    ]);
    expect(await fs.readFile(path.join(bare, "q", "task.md"), "utf8")).toBe(
      before,
    );
  });

  it("moves inside a listed tree addressed by alias, rewriting both trees", async () => {
    const s = await box({ tasks: { l: { depends_on: ["../backend:a/x"] } } });
    const backend = await s.project("backend", "../backend", {
      tasks: { "a/x": {}, k: { depends_on: ["a/x"] } },
    });

    expect(await move(s, "backend:a/x", "backend:b/x")).toEqual({
      from: "backend:a/x",
      to: "backend:b/x",
      kind: "task",
      tasks: [{ from: "backend:a/x", to: "backend:b/x" }],
      deferred: [],
      rewritten: [
        {
          project: "backend",
          task: "k",
          field: "depends_on",
          from: "a/x",
          to: "b/x",
        },
        {
          project: null,
          task: "l",
          field: "depends_on",
          from: "../backend:a/x",
          to: "../backend:b/x",
        },
      ],
      unrewritten: [],
      skipped: [],
    });
    expect(await s.exists("../backend/.tasks/b/x/task.md")).toBe(true);
    expect(await s.exists("../backend/.tasks/a")).toBe(false);
    expect((await frontmatterOf(s, "k", backend)).depends_on).toEqual(["b/x"]);
    expect((await frontmatterOf(s, "l")).depends_on).toEqual([
      "../backend:b/x",
    ]);
    // The log speaks the tree's own ids.
    expect(await logTexts(s, "b/x", backend)).toEqual(["move: a/x → b/x"]);

    // A destination without an alias is a path of the source's tree.
    await move(s, "backend:b/x", "c/x");
    expect(await s.exists("../backend/.tasks/c/x/task.md")).toBe(true);
    expect(await s.exists(".tasks/c")).toBe(false);
  });
});

describe("move: refusals", () => {
  it("refuses the source's own path and any path inside its subtree", async () => {
    const s = await box({ tasks: { "a/x": {}, "a/x/c": {} } });
    expect(refusal(await s.run("move", "x", "a/x", "--json"))).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "same-path",
    });
    expect(refusal(await s.run("move", "a", "a/x/c/d", "--json"))).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "inside-subtree",
    });
    expect(refusal(await s.run("move", "a/x", "a/x/new", "--json")).kind).toBe(
      "inside-subtree",
    );
    expect(await liveIds(s)).toEqual(["a/x", "a/x/c"]);
  });

  it("refuses a destination where a task, a group or a file already is", async () => {
    const s = await box({ tasks: { "a/x": {}, y: {}, "grp/t": {} } });
    await s.write(".tasks/notes", "a file, not a directory\n");

    const task = await s.run("move", "a/x", "y", "--json");
    expect(refusal(task)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "exists",
    });
    expect(errorOf(task).details).toMatchObject({ id: "a/x", to: "y" });
    expect(refusal(await s.run("move", "a/x", "grp", "--json")).kind).toBe(
      "exists",
    );
    expect(refusal(await s.run("move", "a/x", "notes", "--json")).kind).toBe(
      "path-blocked",
    );
    expect(refusal(await s.run("move", "a/x", "notes/x", "--json")).kind).toBe(
      "path-blocked",
    );
    expect(await s.exists(".tasks/a/x/task.md")).toBe(true);
  });

  it("refuses a path an archived task reserves, for the task or anything it carries", async () => {
    const s = await box({
      tasks: { "a/x": {}, "a/x/c": {}, "phase1/t": {} },
      archived: {
        "b/x": { status: "DONE" },
        "c/x/c": { status: "DONE" },
        "later/phase1": { status: "DONE" },
      },
    });

    const own = await s.run("move", "a/x", "b/x", "--json");
    expect(refusal(own)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "reserved",
    });
    expect(errorOf(own).message).toContain("tasks purge b/x");

    const carried = await s.run("move", "a/x", "c/x", "--json");
    expect(errorOf(carried).details).toMatchObject({
      kind: "reserved",
      task: "c/x/c",
    });
    expect(await s.exists(".tasks/a/x/c/task.md")).toBe(true);

    // A group is not a task: it may sit on a reserved path.
    await move(s, "phase1", "later/phase1");
    expect(await s.exists(".tasks/later/phase1/t/task.md")).toBe(true);
  });

  it("refuses a destination under a resolved or an unreadable task", async () => {
    const s = await box({
      tasks: { "a/x": {}, shipped: { status: "DONE" } },
    });
    await s.write(".tasks/broken/task.md", "not a manifest\n");

    const resolved = await s.run("move", "a/x", "shipped/x", "--json");
    expect(refusal(resolved)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "resolved-ancestor",
    });
    expect(errorOf(resolved).details).toMatchObject({
      id: "a/x",
      to: "shipped/x",
      ancestor: "shipped",
      status: "DONE",
    });
    expect(refusal(await s.run("move", "a/x", "broken/x", "--json")).kind).toBe(
      "malformed-ancestor",
    );
    expect(await s.exists(".tasks/a/x/task.md")).toBe(true);
  });

  it("refuses to carry a task under an ancestor it depends on or finishes after", async () => {
    const s = await box({
      tasks: {
        p: {},
        m: { depends_on: ["p"] },
        n: {},
        "n/c": { finishes_after: ["p"] },
      },
    });

    const direct = await s.run("move", "m", "p/m", "--json");
    expect(refusal(direct)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "ancestor",
    });
    expect(errorOf(direct).details).toEqual({
      id: "m",
      to: "p/m",
      kind: "ancestor",
      task: "p/m",
      field: "depends_on",
      ref: "p",
      ancestor: "p",
    });
    const deeper = await s.run("move", "n", "p/n", "--json");
    expect(errorOf(deeper).details).toMatchObject({
      kind: "ancestor",
      task: "p/n/c",
      field: "finishes_after",
      ancestor: "p",
    });
    expect(await liveIds(s)).toEqual(["m", "n", "n/c", "p"]);
  });

  it("refuses a move that would close a cycle through the new parent", async () => {
    const s = await box({
      tasks: { p: {}, q: { depends_on: ["p"] }, m: { depends_on: ["q"] } },
    });
    const result = await s.run("move", "m", "p/m", "--json");
    expect(refusal(result).kind).toBe("cycle");
    expect(errorOf(result).details).toEqual({
      id: "m",
      to: "p/m",
      kind: "cycle",
      cycle: ["p", "p/m", "q"],
    });
    // Elsewhere is fine: nothing there waits for m.
    await move(s, "m", "r/m");
  });

  it("refuses a move that would make a waiting reference close a cycle", async () => {
    // z names b/m before anything lives there; the move fills that path.
    const s = await box({
      tasks: { z: { depends_on: ["b/m"] }, m: { depends_on: ["z"] } },
    });
    const result = await s.run("move", "m", "b/m", "--json");
    expect(errorOf(result).details).toEqual({
      id: "m",
      to: "b/m",
      kind: "cycle",
      cycle: ["z", "b/m"],
    });
  });

  it("counts edges through a listed tree in the cycle check", async () => {
    const s = await box({
      tasks: { p: {}, m: { depends_on: ["../backend:k"] } },
    });
    await s.project("backend", "../backend", {
      tasks: { k: { depends_on: ["../repo:p"] } },
    });
    const result = await s.run("move", "m", "p/m", "--json");
    expect(errorOf(result).details).toMatchObject({
      kind: "cycle",
      cycle: ["p", "p/m", "backend:k"],
    });
  });

  it("refuses to move a subtree holding a malformed manifest", async () => {
    const s = await box({ tasks: { "a/x": {} } });
    await s.write(".tasks/a/x/bad/task.md", "garbage\n");
    const result = await s.run("move", "a/x", "b/x", "--json");
    expect(refusal(result).kind).toBe("malformed-descendants");
    expect(errorOf(result).details).toMatchObject({
      descendants: ["a/x/bad"],
    });
    expect(refusal(await s.run("move", "a/x/bad", "b", "--json")).kind).toBe(
      "malformed",
    );
  });

  it("refuses a source that holds the marker of an unfinished move", async () => {
    const s = await box({ tasks: { "a/x": {} } });
    await s.write(`.tasks/a/x/${MOVING_MARKER_FILENAME}`, "elsewhere/x\n");
    expect(refusal(await s.run("move", "a/x", "b/x", "--json")).kind).toBe(
      "interrupted-move",
    );
  });

  it("reads the destination as a new path of the source's tree", async () => {
    const s = await box({ tasks: { "a/x": {} } });
    await s.project("backend", "../backend", { tasks: { k: {} } });

    const cross = await s.run("move", "a/x", "backend:a/x", "--json");
    expect(cross.code).toBe(2);
    expect(errorOf(cross).code).toBe("USAGE");
    expect((await s.run("move", "a/x", "nope:a/x", "--json")).code).toBe(2);
    expect((await s.run("move", "a/x", "Not/Valid", "--json")).code).toBe(2);
    expect(await s.exists(".tasks/a/x/task.md")).toBe(true);
  });

  it("names a group by its full path only, and an archived source as archived", async () => {
    const s = await box({
      tasks: { "phase1/sub/t": {} },
      archived: { old: { status: "DONE" } },
    });
    const suffix = await s.run("move", "sub", "x", "--json");
    expect(refusal(suffix)).toEqual({
      code: 3,
      error: "NOT_FOUND",
      kind: undefined,
    });
    const archived = await s.run("move", "old", "x", "--json");
    expect(archived.code).toBe(3);
    expect(errorOf(archived).details).toMatchObject({ archived: true });
    expect((await s.run("move", "nothing", "x", "--json")).code).toBe(3);
  });

  it("needs the assignee of an assigned source, or --force", async () => {
    const s = await box({ tasks: { m: { assignee: "alice" } } });
    const refused = await s.run("move", "m", "n", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toMatchObject({
      id: "m",
      assignee: "alice",
    });

    await move(s, "m", "n", "--force");
    expect(await logTexts(s, "n")).toEqual(["move: m → n (forced)"]);
    expect(
      (await s.runWith({ env: { TASKS_ACTOR: "alice" } }, "move", "n", "o"))
        .code,
    ).toBe(0);
  });
});

describe("move: under a BACKLOG parent", () => {
  it("defers the moved subtree as defer would, keeping state.md and assignees", async () => {
    const s = await box({
      tasks: {
        later: { status: "BACKLOG" },
        m: { status: "PAUSED", state: true },
        "m/c": { assignee: "alice" },
        "m/d": { status: "DONE" },
        "m/e": { status: "BACKLOG" },
      },
    });

    const json = await move(s, "m", "later/m");
    expect(json.deferred).toEqual(["later/m", "later/m/c"]);
    expect((await frontmatterOf(s, "later/m")).status).toBe("BACKLOG");
    expect(await frontmatterOf(s, "later/m/c")).toMatchObject({
      status: "BACKLOG",
      assignee: "alice",
    });
    expect((await frontmatterOf(s, "later/m/d")).status).toBe("DONE");
    expect(await s.read(".tasks/later/m/state.md")).toBe(DEFAULT_STATE);

    expect(await logTexts(s, "later/m")).toEqual([
      "move: m → later/m\ndefer with later: PAUSED → BACKLOG",
    ]);
    expect(await logTexts(s, "later/m/c")).toEqual([
      "move: m/c → later/m/c\ndefer with later: TODO → BACKLOG",
    ]);
    expect(await logTexts(s, "later/m/d")).toEqual(["move: m/d → later/m/d"]);
    expect(await logTexts(s, "later/m/e")).toEqual(["move: m/e → later/m/e"]);

    const stamp = (await frontmatterOf(s, "later/m")).updated;
    expect(stamp).not.toBe(FIXTURE_TIME);
    expect((await frontmatterOf(s, "later/m/c")).updated).toBe(stamp);
    expect((await frontmatterOf(s, "later/m/d")).updated).toBe(FIXTURE_TIME);
    expect((await frontmatterOf(s, "later/m/e")).updated).toBe(FIXTURE_TIME);

    // `schedule` brings it back as it was paused.
    expect((await s.run("schedule", "later")).code).toBe(0);
    expect((await frontmatterOf(s, "later/m")).status).toBe("PAUSED");
  });

  it("clears the caller's own claim when the move defers it", async () => {
    const s = await box({
      tasks: {
        later: { status: "BACKLOG" },
        w: { status: "IN_PROGRESS", state: true },
      },
    });
    expect((await move(s, "w", "later/w")).deferred).toEqual(["later/w"]);
    expect(await frontmatterOf(s, "later/w")).toMatchObject({
      status: "BACKLOG",
      claimed_by: null,
      claimed_at: null,
      claimed_session: null,
    });
    expect(await logTexts(s, "later/w")).toEqual([
      "move: w → later/w\ndefer with later: IN_PROGRESS → BACKLOG",
    ]);
  });
});

describe("move: work in progress", () => {
  const claimedByAlice = {
    status: "IN_PROGRESS" as const,
    claimed_by: "alice",
    claimed_session: "s1",
  };

  it("refuses to carry someone's live claim, naming it", async () => {
    const s = await box({ tasks: { e: {}, "e/a": claimedByAlice, "e/b": {} } });
    await heartbeat(s, "s1");

    const result = await s.run("move", "e", "f", "--json");
    expect(refusal(result).kind).toBe("cascade-claim");
    expect(errorOf(result).details).toEqual({
      id: "e",
      to: "f",
      kind: "cascade-claim",
      claims: [
        { id: "e/a", claimant: "alice", session: "s1", liveness: "live" },
      ],
    });
    expect(await liveIds(s)).toEqual(["e", "e/a", "e/b"]);
    expect(await s.exists(".tasks/e/b/log.md")).toBe(false);
  });

  it("refuses a claim whose liveness is unknown", async () => {
    const s = await box({
      tasks: { a: { status: "IN_PROGRESS", claimed_by: "alice" } },
    });
    const result = await s.run("move", "a", "b", "--json");
    expect(errorOf(result).details).toMatchObject({
      claims: [
        { id: "a", claimant: "alice", session: null, liveness: "unknown" },
      ],
    });
  });

  it("lets the claimant move it from the claim's session, and mine finds it there", async () => {
    const s = await box({
      tasks: { e: {}, "e/a": { status: "IN_PROGRESS", claimed_session: "s1" } },
    });
    await heartbeat(s, "s1");
    // The same actor without the claim's session is not its claimant.
    expect((await s.run("move", "e", "f", "--json")).code).toBe(4);

    const result = await s.session("s1")("move", "e", "f", "--json");
    expect(result.code).toBe(0);
    expect(await frontmatterOf(s, "f/a")).toMatchObject({
      status: "IN_PROGRESS",
      claimed_by: "tester",
      claimed_session: "s1",
    });
    expect(await logTexts(s, "f/a")).toEqual(["move: e/a → f/a"]);
    const mine = (await s.session("s1")("mine", "--json")).json<
      CollectionJson<{ id: string }>
    >();
    expect(mine.tasks.map((task) => task.id)).toEqual(["f/a"]);
  });

  it("moves a live claim with --force and records what it overrode", async () => {
    const s = await box({ tasks: { e: {}, "e/a": claimedByAlice } });
    await heartbeat(s, "s1");

    const result = await s.run("move", "e", "f", "--force");
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toContain("✓ move e → f (forced)");
    expect((await frontmatterOf(s, "f/a")).claimed_by).toBe("alice");
    expect((await lastEntry(s, "f/a")).text).toMatch(
      /^move: e\/a → f\/a \(forced\)\nover the claim of alice s:s1 \(live, last seen \S+Z\)$/,
    );
    expect(await logTexts(s, "f")).toEqual(["move: e → f (forced)"]);
  });

  it("passes an orphaned claim and records the claim it went past", async () => {
    const s = await box({ tasks: { e: {}, "e/a": claimedByAlice } });
    await heartbeat(s, "s1", STALE);
    const seen = await lastSeen(s, "s1");

    const result = await s.run("move", "e", "f");
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toContain(
      `superseded alice s:s1 on f/a (orphaned, last seen ${seen})`,
    );
    expect(await logTexts(s, "f/a")).toEqual([
      `move: e/a → f/a\nover the claim of alice s:s1 (orphaned, last seen ${seen})`,
    ]);
    expect(await logTexts(s, "f")).toEqual(["move: e → f"]);
  });
});

describe("move: across filesystems", () => {
  const realRename = fs.rename;
  const realCopyFile = fs.copyFile;
  const realRm = fs.rm;

  function exdev(): Error {
    return Object.assign(new Error("EXDEV: cross-device link not permitted"), {
      code: "EXDEV",
    });
  }

  /** `fs.rename` of `dir` fails as across filesystems; every other works. */
  function crossDevice(dir: string): void {
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === dir) throw exdev();
      return realRename(from, to);
    });
  }

  async function prepared(): Promise<{
    s: Sandbox;
    source: string;
    marker: string;
  }> {
    const s = await box({
      tasks: {
        "a/x": { state: true },
        "a/x/c": {},
        y: { depends_on: ["a/x"] },
      },
    });
    await s.write(".tasks/a/x/notes/n.txt", "notes\n");
    await s.age(".tasks/a/x/state.md", 120);
    return {
      s,
      source: path.join(s.tasksDir, "a", "x"),
      marker: path.join(s.tasksDir, "b", "x", MOVING_MARKER_FILENAME),
    };
  }

  it("copies under a .moving marker, keeps mtimes, then drops the source and the marker", async () => {
    const { s, source, marker } = await prepared();
    const mtime = (await fs.stat(path.join(source, "state.md"))).mtimeMs;
    crossDevice(source);
    const markers: string[] = [];
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      markers.push(await fs.readFile(marker, "utf8"));
      return realCopyFile(from, to, mode);
    });

    const json = await move(s, "a/x", "b/x");
    expect(json.tasks).toEqual([
      { from: "a/x", to: "b/x" },
      { from: "a/x/c", to: "b/x/c" },
    ]);
    // Every file was copied while the marker named the source.
    expect(markers.length).toBe(4);
    expect(new Set(markers)).toEqual(new Set(["a/x\n"]));

    expect(await s.exists(`.tasks/b/x/${MOVING_MARKER_FILENAME}`)).toBe(false);
    expect(await s.exists(".tasks/a")).toBe(false);
    expect(await s.read(".tasks/b/x/notes/n.txt")).toBe("notes\n");
    expect((await fs.stat(path.join(s.tasksDir, "b/x/state.md"))).mtimeMs).toBe(
      mtime,
    );
    expect((await frontmatterOf(s, "y")).depends_on).toEqual(["b/x"]);
    expect(await logTexts(s, "b/x/c")).toEqual(["move: a/x/c → b/x/c"]);
    expect((await s.run("validate", "--json")).code).toBe(0);
  });

  it("undoes a copy that fails, leaving the source as the one copy", async () => {
    const { s, source } = await prepared();
    crossDevice(source);
    let calls = 0;
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      }
      return realCopyFile(from, to, mode);
    });

    const result = await s.run("move", "a/x", "b/x", "--json");
    expect(result.code).toBe(1);
    expect(errorOf(result).message).toContain("ENOSPC");
    // The partial copy and the group made for it are gone.
    expect(await s.exists(".tasks/b")).toBe(false);
    expect(await liveIds(s)).toEqual(["a/x", "a/x/c", "y"]);
    expect((await frontmatterOf(s, "y")).depends_on).toEqual(["a/x"]);
    vi.restoreAllMocks();
    expect((await s.run("validate", "--json")).code).toBe(0);
  });

  it("leaves the marker when the source cannot be removed, which validate reports as a duplicate", async () => {
    const { s, source } = await prepared();
    crossDevice(source);
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === source) {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      }
      return realRm(target, options);
    });

    const result = await s.run("move", "a/x", "b/x", "--json");
    expect(result.code).toBe(1);
    expect(await s.read(`.tasks/b/x/${MOVING_MARKER_FILENAME}`)).toBe("a/x\n");
    expect(await s.exists(".tasks/a/x/task.md")).toBe(true);
    expect(await s.exists(".tasks/b/x/c/task.md")).toBe(true);
    vi.restoreAllMocks();

    const validation = await s.run("validate", "--json");
    expect(validation.code).toBe(4);
    expect(validation.json<ValidationJson>().findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        kind: "duplicate-id",
        task: "b/x",
      }),
    );
  });
});

describe("a writable tree that cannot be written", () => {
  it("is reported as skipped with its references unrewritten; the move stands", async () => {
    const s = await box({ tasks: { l: { depends_on: ["../backend:x"] } } });
    await s.project("backend", "../backend", { tasks: { x: {} } });
    // Another process holds this tree's lock for longer than the wait.
    await s.write(
      ".tasks/.locks/tree.lock",
      JSON.stringify({ pid: 999999, hostname: "elsewhere", timestamp: "t" }),
    );
    const result = await s.run("move", "backend:x", "y", "--json");
    expect(result.code).toBe(0);
    const json = result.json<MoveJson>();
    expect(json.tasks).toEqual([{ from: "backend:x", to: "backend:y" }]);
    expect(json.skipped).toEqual([
      { project: null, reason: expect.stringContaining("locked") },
    ]);
    expect(json.unrewritten).toEqual([
      { project: null, task: "l", field: "depends_on", ref: "../backend:x" },
    ]);
    expect(result.stderr).toContain("index.md was not refreshed");
    expect(await s.exists("../backend/.tasks/y/task.md")).toBe(true);
  });
});
