import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { formatIso } from "../src/core/time.js";
import type { ResolvedRef, TaskWithDerivedJson } from "../src/core/types.js";
import { readLog } from "../src/core/workspace.js";
import type { TreeSpec } from "./fixtures.js";
import { FIXTURE_TIME } from "./fixtures.js";
import type { CliResult, Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface DepListJson {
  id: string;
  field: string;
  refs: ResolvedRef[];
}

function errorOf(result: CliResult): ErrorJson["error"] {
  return result.json<ErrorJson>().error;
}

const TREE: TreeSpec = {
  tasks: {
    "x/a": {},
    "y/b": {},
    "y/done": { status: "DONE" },
    epic: {},
    "epic/child": {},
  },
};

async function box(spec: TreeSpec = TREE): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

async function logOf(s: Sandbox, id: string) {
  return readLog(path.join(s.tasksDir, ...id.split("/")));
}

describe("dep add", () => {
  it("stores the full id of a local suffix, logs once and stamps updated", async () => {
    const s = await box();
    const result = await s.run("dep", "add", "a", "b", "--json");
    expect(result.code).toBe(0);

    const json = result.json<TaskWithDerivedJson>();
    expect(json).toMatchObject({
      id: "x/a",
      depends_on: ["y/b"],
      situation: "blocked",
      blocked_by: [{ ref: "y/b", reason: "not-done", status: "TODO" }],
    });
    expect(json.updated).not.toBe(FIXTURE_TIME);
    expect(json.created).toBe(FIXTURE_TIME);

    const entries = await logOf(s, "x/a");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      time: json.updated,
      actor: "tester",
      text: "dep add: y/b",
    });
    expect(json.last_entry?.text).toBe("dep add: y/b");
  });

  it("keeps unknown frontmatter keys, in the order read, and the body", async () => {
    const s = await box({
      tasks: {
        a: {
          extra: { zeta: "kept", alpha: [1, "two"], nested: { k: "v" } },
          body: "# A\n\nThe author's words.\n",
        },
        b: {},
      },
    });
    expect((await s.run("dep", "add", "a", "b")).code).toBe(0);
    const manifest = await s.read(".tasks/a/task.md");
    expect(manifest).toMatch(
      /\nupdated: "[^"]+"\nzeta: kept\nalpha: \[1, two\]\nnested: \{k: v\}\n---\n\n# A\n\nThe author's words\.\n$/,
    );
    expect(manifest).toContain("depends_on: [b]\n");
  });

  it("adds several references in one entry", async () => {
    const s = await box();
    const result = await s.run("dep", "add", "a", "b", "y/done", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>().depends_on).toEqual([
      "y/b",
      "y/done",
    ]);
    const entries = await logOf(s, "x/a");
    expect(entries.map((entry) => entry.text)).toEqual([
      "dep add: y/b, y/done",
    ]);
  });

  it("stores alias:suffix as the configured project path", async () => {
    const s = await box();
    await s.project("backend", "../backend", {
      tasks: { "kernel/tests": {} },
    });
    const result = await s.run("dep", "add", "a", "backend:tests", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>()).toMatchObject({
      depends_on: ["../backend:kernel/tests"],
      blocked_by: [
        { ref: "../backend:kernel/tests", reason: "not-done", status: "TODO" },
      ],
    });
  });

  it("edits a task of a listed project, storing references from its tree", async () => {
    const s = await box();
    const backend = await s.project("backend", "../backend", {
      tasks: { "kernel/x": {}, "kernel/y": {} },
    });
    const same = await s.run("dep", "add", "backend:x", "backend:y", "--json");
    expect(same.code).toBe(0);
    expect(same.json<TaskWithDerivedJson>()).toMatchObject({
      id: "backend:kernel/x",
      project: "backend",
      depends_on: ["kernel/y"],
    });

    // A bare reference names the local tree, stored relative to backend.
    const back = await s.run("dep", "add", "backend:x", "a", "--json");
    expect(back.code).toBe(0);
    expect(back.json<TaskWithDerivedJson>().depends_on).toEqual([
      "kernel/y",
      "../repo:x/a",
    ]);
    const entries = await readLog(path.join(backend, ".tasks", "kernel", "x"));
    expect(entries.map((entry) => entry.text)).toEqual([
      "dep add: kernel/y",
      "dep add: ../repo:x/a",
    ]);
  });

  it("is idempotent: a reference already present writes nothing", async () => {
    const s = await box();
    expect((await s.run("dep", "add", "a", "b")).code).toBe(0);
    const manifest = await s.read(".tasks/x/a/task.md");

    const again = await s.run("dep", "add", "a", "b");
    expect(again.code).toBe(0);
    expect(stripVTControlCharacters(again.stdout)).toContain(
      "already depends on y/b",
    );
    expect(await s.read(".tasks/x/a/task.md")).toBe(manifest);
    expect(await logOf(s, "x/a")).toHaveLength(1);

    const mixed = await s.run(
      "dep",
      "add",
      "a",
      "y/b",
      "done",
      "done",
      "--json",
    );
    expect(mixed.code).toBe(0);
    expect(mixed.json<TaskWithDerivedJson>().depends_on).toEqual([
      "y/b",
      "y/done",
    ]);
    expect((await logOf(s, "x/a")).map((entry) => entry.text)).toEqual([
      "dep add: y/b",
      "dep add: y/done",
    ]);
  });

  it("refuses a self-reference, a missing task, an ancestor and a cycle", async () => {
    const s = await box();

    const self = await s.run("dep", "add", "a", "x/a", "--json");
    expect(self.code).toBe(2);

    const missing = await s.run("dep", "add", "a", "nope", "--json");
    expect(missing.code).toBe(3);

    const ancestor = await s.run("dep", "add", "child", "epic", "--json");
    expect(ancestor.code).toBe(4);
    expect(errorOf(ancestor).details).toMatchObject({
      kind: "ancestor",
      ancestor: "epic",
    });

    expect((await s.run("dep", "add", "a", "b")).code).toBe(0);
    const cycle = await s.run("dep", "add", "b", "a", "--json");
    expect(cycle.code).toBe(4);
    expect(errorOf(cycle).details).toMatchObject({ kind: "cycle" });

    // Nothing was written by any refusal.
    expect(
      (await s.loadTree()).byId.get("y/b")?.frontmatter.depends_on,
    ).toEqual([]);
    expect(await logOf(s, "epic/child")).toEqual([]);
  });

  it("refuses an ambiguous suffix and an archived target", async () => {
    const s = await box({
      tasks: { a: {}, "p/z": {}, "q/z": {} },
      archived: { "old/t": { status: "DONE" } },
    });
    const ambiguous = await s.run("dep", "add", "a", "z", "--json");
    expect(ambiguous.code).toBe(2);
    expect(errorOf(ambiguous).details).toMatchObject({
      candidates: ["p/z", "q/z"],
    });

    const archived = await s.run("dep", "add", "a", "old/t", "--json");
    expect(archived.code).toBe(3);
    expect(errorOf(archived).details).toMatchObject({ archived: true });
  });

  it("needs at least one reference", async () => {
    const s = await box();
    expect((await s.run("dep", "add", "a")).code).toBe(2);
    expect((await s.run("dep", "rm", "a")).code).toBe(2);
  });
});

describe("dep rm", () => {
  it("removes a reference named like a task, logging it", async () => {
    const s = await box();
    expect((await s.run("dep", "add", "a", "b", "done")).code).toBe(0);
    const result = await s.run("dep", "rm", "a", "b", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>().depends_on).toEqual(["y/done"]);
    expect((await logOf(s, "x/a")).map((entry) => entry.text)).toEqual([
      "dep add: y/b, y/done",
      "dep rm: y/b",
    ]);
  });

  it("refuses a reference that is not there as not found", async () => {
    const s = await box();
    const result = await s.run("dep", "rm", "a", "b", "--json");
    expect(result.code).toBe(3);
    expect(errorOf(result).details).toMatchObject({
      id: "x/a",
      field: "depends_on",
      ref: "b",
    });
    expect(await logOf(s, "x/a")).toEqual([]);
  });

  it("removes a reference whose target is gone, named as stored or in full", async () => {
    const s = await box({
      tasks: {
        a: {
          depends_on: ["gone/task", "old/t", "../elsewhere:x"],
        },
      },
      archived: { "old/t": { status: "DONE" } },
    });
    expect((await s.run("dep", "rm", "a", "gone/task")).code).toBe(0);
    // The suffix of an archived task resolves to its full id.
    expect((await s.run("dep", "rm", "a", "t")).code).toBe(0);
    expect((await s.run("dep", "rm", "a", "../elsewhere:x")).code).toBe(0);
    expect((await s.loadTree()).byId.get("a")?.frontmatter.depends_on).toEqual(
      [],
    );
  });
});

describe("dep list", () => {
  it("lists every reference with its satisfaction and reason", async () => {
    const s = await box({
      tasks: {
        a: {
          depends_on: ["done", "open", "dropped", "gone/task", "old/t"],
        },
        done: { status: "DONE" },
        open: { status: "PAUSED" },
        dropped: { status: "CANCELLED" },
      },
      archived: { "old/t": { status: "DONE" } },
    });
    const result = await s.run("dep", "list", "a", "--json");
    expect(result.code).toBe(0);
    const json = result.json<DepListJson>();
    expect(json.id).toBe("a");
    expect(json.field).toBe("depends_on");
    expect(
      json.refs.map(({ ref, satisfied, reason, status }) => ({
        ref,
        satisfied,
        reason,
        status,
      })),
    ).toEqual([
      { ref: "done", satisfied: true, reason: null, status: "DONE" },
      { ref: "open", satisfied: false, reason: "not-done", status: "PAUSED" },
      {
        ref: "dropped",
        satisfied: false,
        reason: "cancelled",
        status: "CANCELLED",
      },
      { ref: "gone/task", satisfied: false, reason: "missing", status: null },
      { ref: "old/t", satisfied: false, reason: "archived", status: null },
    ]);

    const human = await s.run("dep", "list", "a");
    expect(human.code).toBe(0);
    const text = stripVTControlCharacters(human.stdout);
    expect(text).toContain("REFERENCE");
    expect(text).toContain("cancelled (CANCELLED)");
  });

  it("qualifies a task of a listed project", async () => {
    const s = await box();
    await s.project("backend", "../backend", {
      tasks: { k: { depends_on: ["j"] }, j: { status: "DONE" } },
    });
    const result = await s.run("dep", "list", "backend:k", "--json");
    expect(result.code).toBe(0);
    expect(result.json<DepListJson>()).toMatchObject({
      id: "backend:k",
      refs: [{ ref: "j", project: "backend", satisfied: true }],
    });
  });
});

describe("after", () => {
  it("adds, lists with finish-gate semantics, and removes finishes_after", async () => {
    const s = await box({
      tasks: {
        epic: {},
        part: {},
        dropped: { status: "CANCELLED" },
      },
    });
    const added = await s.run(
      "after",
      "add",
      "epic",
      "part",
      "dropped",
      "--json",
    );
    expect(added.code).toBe(0);
    expect(added.json<TaskWithDerivedJson>()).toMatchObject({
      finishes_after: ["part", "dropped"],
      depends_on: [],
      // A finish edge does not block the start.
      blocked_by: [],
    });

    const list = await s.run("after", "list", "epic", "--json");
    expect(list.code).toBe(0);
    const json = list.json<DepListJson>();
    expect(json.field).toBe("finishes_after");
    // CANCELLED satisfies a finish gate, never a start gate.
    expect(
      json.refs.map(({ ref, satisfied, reason }) => ({
        ref,
        satisfied,
        reason,
      })),
    ).toEqual([
      { ref: "part", satisfied: false, reason: "not-done" },
      { ref: "dropped", satisfied: true, reason: null },
    ]);

    const removed = await s.run("after", "rm", "epic", "part", "--json");
    expect(removed.code).toBe(0);
    expect(removed.json<TaskWithDerivedJson>().finishes_after).toEqual([
      "dropped",
    ]);
    expect((await logOf(s, "epic")).map((entry) => entry.text)).toEqual([
      "after add: part, dropped",
      "after rm: part",
    ]);
  });

  it("applies the same refusals as dep", async () => {
    const s = await box();
    expect((await s.run("after", "add", "child", "epic")).code).toBe(4);
    expect((await s.run("after", "add", "a", "a")).code).toBe(2);
    expect((await s.run("after", "rm", "a", "b")).code).toBe(3);
  });
});

describe("authorization of dependency edits", () => {
  it("admits only the claimant session of a live claim, unless forced", async () => {
    const s = await box({
      tasks: {
        w: { status: "IN_PROGRESS", claimed_session: "s2" },
        b: {},
      },
    });
    await s.write(".tasks/.locks/sessions/s2", "");

    const other = await s.session("s1")("dep", "add", "w", "b", "--json");
    expect(other.code).toBe(4);
    expect(errorOf(other).details).toEqual({
      kind: "authorization",
      id: "w",
      claimed_by: "tester",
      claimed_session: "s2",
      assignee: null,
      liveness: "live",
    });
    expect(await logOf(s, "w")).toEqual([]);

    const forced = await s.session("s1")("dep", "add", "w", "b", "--force");
    expect(forced.code).toBe(0);
    const [entry] = await logOf(s, "w");
    expect(entry).toMatchObject({ session: "s1" });
    expect(entry?.text).toMatch(
      /^dep add: b \(forced\)\nover the claim of tester s:s2 \(live, last seen \S+Z\)$/,
    );

    const own = await s.session("s2")("dep", "rm", "w", "b");
    expect(own.code).toBe(0);
    expect((await logOf(s, "w"))[1]?.text).toBe("dep rm: b");
  });

  it("protects a claim without a session from other actors", async () => {
    const s = await box({
      tasks: { w: { status: "IN_PROGRESS", claimed_by: "bob" }, b: {} },
    });
    const result = await s.run("dep", "add", "w", "b", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({ liveness: "unknown" });
    expect((await s.run("dep", "add", "w", "b", "--as", "bob")).code).toBe(0);
  });

  it("passes over an orphaned claim and records it", async () => {
    const s = await box({
      tasks: {
        w: { status: "IN_PROGRESS", claimed_by: "bob", claimed_session: "s9" },
        b: {},
      },
    });
    await s.write(".tasks/.locks/sessions/s9", "");
    await s.age(".tasks/.locks/sessions/s9", 120);
    const { mtime } = await fs.stat(
      path.join(s.tasksDir, ".locks", "sessions", "s9"),
    );

    const result = await s.run("dep", "add", "w", "b");
    expect(result.code).toBe(0);
    const [entry] = await logOf(s, "w");
    expect(entry?.text).toBe(
      `dep add: b\nover the claim of bob s:s9 (orphaned, last seen ${formatIso(mtime)})`,
    );
  });

  it("admits the assignee and an ancestor's assignee of an assigned task", async () => {
    const s = await box({
      tasks: {
        boss: { assignee: "carol" },
        "boss/part": { assignee: "dave" },
        b: {},
      },
    });
    const refused = await s.run("dep", "add", "part", "b", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toMatchObject({
      assignee: "dave",
      liveness: null,
    });

    expect((await s.run("dep", "add", "part", "b", "--as", "dave")).code).toBe(
      0,
    );
    expect((await s.run("dep", "rm", "part", "b", "--as", "carol")).code).toBe(
      0,
    );
    const entries = await logOf(s, "boss/part");
    expect(entries.map((entry) => [entry.actor, entry.via])).toEqual([
      ["dave", "tester"],
      ["carol", "tester"],
    ]);
  });
});
