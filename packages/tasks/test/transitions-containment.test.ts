import { afterEach, describe, expect, it } from "vitest";

import type { TransitionJson } from "../src/core/transitions.js";
import { DEFAULT_STATE } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";
import {
  derivedOf,
  errorOf,
  frontmatterOf,
  heartbeat,
  lastEntry,
  lastSeen,
  logTexts,
  plain,
  refusal,
} from "./transitions-support.js";

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

const STALE = 31;

describe("defer cascade", () => {
  it("defers every open descendant, keeping state.md and assignees", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": { assignee: "alice" },
        "epic/b": { status: "PAUSED", state: true },
        "epic/b/c": {},
        "epic/d": { status: "DONE" },
      },
    });
    const result = await sandbox.run(
      "defer",
      "epic",
      "-m",
      "after the release",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>().cascaded).toEqual([
      "epic/a",
      "epic/b",
      "epic/b/c",
    ]);

    for (const id of ["epic", "epic/a", "epic/b", "epic/b/c"]) {
      expect((await frontmatterOf(sandbox, id)).status).toBe("BACKLOG");
    }
    expect((await frontmatterOf(sandbox, "epic/a")).assignee).toBe("alice");
    expect(await sandbox.read(".tasks/epic/b/state.md")).toBe(DEFAULT_STATE);
    expect((await frontmatterOf(sandbox, "epic/d")).status).toBe("DONE");
    expect(await sandbox.exists(".tasks/epic/d/log.md")).toBe(false);

    expect(await logTexts(sandbox, "epic/a")).toEqual([
      "defer with epic: TODO → BACKLOG\nafter the release",
    ]);
    expect(await logTexts(sandbox, "epic/b")).toEqual([
      "defer with epic: PAUSED → BACKLOG\nafter the release",
    ]);
    expect(await logTexts(sandbox, "epic")).toEqual([
      "defer: TODO → BACKLOG\nreached: epic/a, epic/b, epic/b/c\nafter the release",
    ]);

    // One command, one instant: every file it wrote carries the same stamp.
    const stamp = (await frontmatterOf(sandbox, "epic")).updated;
    expect((await frontmatterOf(sandbox, "epic/b/c")).updated).toBe(stamp);
    expect((await lastEntry(sandbox, "epic/b/c")).time).toBe(stamp);
  });

  it("clears a cascaded orphaned claim and logs the takeover on it", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": {
          status: "IN_PROGRESS",
          claimed_by: "alice",
          claimed_session: "s1",
          state: true,
        },
      },
    });
    await heartbeat(sandbox, "s1", STALE);
    const seen = await lastSeen(sandbox, "s1");

    const result = await sandbox.run("defer", "epic", "-m", "parked");
    expect(result.code).toBe(0);
    expect(await frontmatterOf(sandbox, "epic/a")).toMatchObject({
      status: "BACKLOG",
      claimed_by: null,
      claimed_at: null,
      claimed_session: null,
    });
    // Kept, so that `schedule` later restores the task to PAUSED.
    expect(await sandbox.exists(".tasks/epic/a/state.md")).toBe(true);
    expect(await logTexts(sandbox, "epic/a")).toEqual([
      `defer with epic: IN_PROGRESS → BACKLOG\nsupersedes alice s:s1, last seen ${seen}\nparked`,
    ]);
    expect(plain(result.stdout)).toContain("superseded alice s:s1 on epic/a");
  });

  it("refuses to reach a live claim, naming it; --force overrides", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": {
          status: "IN_PROGRESS",
          claimed_by: "alice",
          claimed_session: "s1",
        },
        "epic/b": {},
      },
    });
    await heartbeat(sandbox, "s1");

    const refused = await sandbox.run("defer", "epic", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toEqual({
      id: "epic",
      kind: "cascade-claim",
      claims: [
        { id: "epic/a", claimant: "alice", session: "s1", liveness: "live" },
      ],
    });
    // Nothing of the cascade was written.
    expect((await frontmatterOf(sandbox, "epic/b")).status).toBe("TODO");
    expect((await frontmatterOf(sandbox, "epic")).status).toBe("TODO");

    const forced = await sandbox.run("defer", "epic", "--force");
    expect(forced.code).toBe(0);
    expect((await frontmatterOf(sandbox, "epic/a")).status).toBe("BACKLOG");
    expect((await lastEntry(sandbox, "epic/a")).text).toMatch(
      /^defer with epic: IN_PROGRESS → BACKLOG \(forced\)\nsupersedes alice s:s1, last seen \S+Z$/,
    );
    expect(await logTexts(sandbox, "epic")).toEqual([
      "defer: TODO → BACKLOG (forced)\nreached: epic/a, epic/b",
    ]);
  });

  it("refuses to reach a claim of unknown liveness", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": { status: "IN_PROGRESS", claimed_by: "alice" },
      },
    });
    const result = await sandbox.run("cancel", "epic", "-m", "x", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      claims: [
        { id: "epic/a", claimant: "alice", session: null, liveness: "unknown" },
      ],
    });
  });

  it("reaches the actor's own claim without force", async () => {
    sandbox = await treeSandbox({ tasks: { epic: {}, "epic/a": {} } });
    const s1 = sandbox.session("s1");
    expect((await s1("claim", "epic/a")).code).toBe(0);
    const result = await s1("cancel", "epic", "-m", "scope cut");
    expect(result.code).toBe(0);
    expect(await logTexts(sandbox, "epic/a")).toEqual([
      "claim: TODO → IN_PROGRESS",
      "cancel with epic: IN_PROGRESS → CANCELLED\nscope cut",
    ]);
  });
});

describe("schedule cascade", () => {
  it("brings every BACKLOG descendant back: PAUSED with a state.md, else TODO", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "BACKLOG", state: true },
        "epic/a": { status: "BACKLOG" },
        "epic/b": { status: "BACKLOG", state: true },
        "epic/b/c": { status: "BACKLOG" },
        "epic/d": { status: "CANCELLED" },
      },
    });
    const result = await sandbox.run("schedule", "epic", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "PAUSED",
      cascaded: ["epic/a", "epic/b", "epic/b/c"],
    });
    expect((await frontmatterOf(sandbox, "epic/a")).status).toBe("TODO");
    expect((await frontmatterOf(sandbox, "epic/b")).status).toBe("PAUSED");
    expect((await frontmatterOf(sandbox, "epic/b/c")).status).toBe("TODO");
    expect((await frontmatterOf(sandbox, "epic/d")).status).toBe("CANCELLED");
    expect(await logTexts(sandbox, "epic/b")).toEqual([
      "schedule with epic: BACKLOG → PAUSED",
    ]);
    expect(await logTexts(sandbox, "epic")).toEqual([
      "schedule: BACKLOG → PAUSED\nreached: epic/a, epic/b, epic/b/c",
    ]);
  });

  it("undoes a defer: the subtree returns as it was paused", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": { status: "PAUSED", state: true },
        "epic/b": {},
      },
    });
    expect((await sandbox.run("defer", "epic", "-m", "later")).code).toBe(0);
    expect((await sandbox.run("schedule", "epic", "-m", "now")).code).toBe(0);
    expect((await frontmatterOf(sandbox, "epic")).status).toBe("TODO");
    expect((await frontmatterOf(sandbox, "epic/a")).status).toBe("PAUSED");
    expect((await frontmatterOf(sandbox, "epic/b")).status).toBe("TODO");
  });

  it("refuses under a BACKLOG ancestor, naming the one to schedule, even forced", async () => {
    sandbox = await treeSandbox({
      tasks: {
        root: { status: "BACKLOG" },
        "root/mid": { status: "BACKLOG" },
        "root/mid/leaf": { status: "BACKLOG" },
      },
    });
    for (const extra of [[], ["--force"]]) {
      const result = await sandbox.run(
        "schedule",
        "root/mid/leaf",
        ...extra,
        "--json",
      );
      expect(result.code).toBe(4);
      const error = errorOf(result);
      // The topmost one: scheduling it is the single command that works.
      expect(error.details).toEqual({
        id: "root/mid/leaf",
        ancestor: "root",
        kind: "backlog-ancestor",
      });
      expect(error.message).toContain("tasks schedule root");
    }
  });
});

describe("cancel cascade", () => {
  it("cancels every open descendant and clears their claims", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": { status: "IN_PROGRESS", claimed_session: "s1" },
        "epic/b": { status: "BACKLOG" },
        "epic/c": { status: "DONE" },
      },
    });
    const result = await sandbox.session("s1")(
      "cancel",
      "epic",
      "-m",
      "scope cut",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "CANCELLED",
      cascaded: ["epic/a", "epic/b"],
      dependents: [],
    });
    expect(await frontmatterOf(sandbox, "epic/a")).toMatchObject({
      status: "CANCELLED",
      claimed_by: null,
      claimed_session: null,
    });
    expect((await frontmatterOf(sandbox, "epic/b")).status).toBe("CANCELLED");
    expect((await frontmatterOf(sandbox, "epic/c")).status).toBe("DONE");
    expect(await logTexts(sandbox, "epic/b")).toEqual([
      "cancel with epic: BACKLOG → CANCELLED\nscope cut",
    ]);
  });

  it("lists the dependents it strands, local and in a listed project, qualified", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": {},
        x: { depends_on: ["epic"] },
        y: { depends_on: ["epic/a"], status: "DONE" },
        "epic/sibling": { depends_on: ["epic/a"] },
      },
    });
    await sandbox.project("backend", "../backend", {
      tasks: { z: { depends_on: ["../repo:epic/a"] }, w: {} },
    });
    const result = await sandbox.run(
      "cancel",
      "epic",
      "-m",
      "dropped",
      "--json",
    );
    expect(result.code).toBe(0);
    // A task the command cancelled itself is no news to its decider, and a
    // resolved dependent has nothing left to decide.
    expect(result.json<TransitionJson>().dependents).toEqual([
      "x",
      "backend:z",
    ]);
    expect(
      plain((await sandbox.run("cancel", "w", "-m", "x")).stdout),
    ).not.toContain("stranded");
  });

  it("prints what it reached and what it stranded", async () => {
    sandbox = await treeSandbox({
      tasks: { epic: {}, "epic/a": {}, x: { depends_on: ["epic/a"] } },
    });
    const out = plain((await sandbox.run("cancel", "epic", "-m", "no")).stdout);
    expect(out).toContain("✓ cancel epic: TODO → CANCELLED");
    expect(out).toContain("cascaded to epic/a");
    expect(out).toContain("stranded dependents: x");
  });

  it("does not wait for finishes_after", async () => {
    sandbox = await treeSandbox({
      tasks: { other: {}, epic: { finishes_after: ["other"] } },
    });
    expect((await sandbox.run("cancel", "epic", "-m", "dropped")).code).toBe(0);
    expect((await frontmatterOf(sandbox, "other")).status).toBe("TODO");
  });

  it("supersedes an orphaned claim it reaches", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": { status: "IN_PROGRESS", claimed_session: "s1" },
      },
    });
    await heartbeat(sandbox, "s1", STALE);
    const result = await sandbox.session("s2")("cancel", "epic", "-m", "gone");
    expect(result.code).toBe(0);
    expect((await lastEntry(sandbox, "epic/a")).text).toMatch(
      /^cancel with epic: IN_PROGRESS → CANCELLED\nsupersedes tester s:s1, last seen \S+Z\ngone$/,
    );
  });
});

describe("dependencies after a cancel", () => {
  it("a reopened dependency unblocks its dependent without a write to it", async () => {
    sandbox = await treeSandbox({ tasks: { a: {}, b: { depends_on: ["a"] } } });
    const before = await sandbox.read(".tasks/b/task.md");

    const cancelled = await sandbox.run(
      "cancel",
      "a",
      "-m",
      "dead end",
      "--json",
    );
    expect(cancelled.json<TransitionJson>().dependents).toEqual(["b"]);
    expect((await derivedOf(sandbox, "b")).derived.blocked_by).toEqual([
      { ref: "a", reason: "cancelled", status: "CANCELLED" },
    ]);

    expect((await sandbox.run("reopen", "a", "-m", "back")).code).toBe(0);
    expect((await derivedOf(sandbox, "b")).derived.blocked_by).toEqual([
      { ref: "a", reason: "not-done", status: "TODO" },
    ]);

    expect((await sandbox.run("done", "a", "-m", "built")).code).toBe(0);
    expect((await derivedOf(sandbox, "b")).derived.ready).toBe(true);
    expect(await sandbox.read(".tasks/b/task.md")).toBe(before);
    expect(await sandbox.exists(".tasks/b/log.md")).toBe(false);
  });
});

describe("finish gate", () => {
  it("refuses done on a parent with an open child, then allows it once the child is done", async () => {
    sandbox = await treeSandbox({ tasks: { epic: {}, "epic/a": {} } });
    const refused = await sandbox.run("done", "epic", "-m", "x", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toEqual({
      id: "epic",
      kind: "finish-gate",
      open_children: ["epic/a"],
      finishes_after: [],
    });
    // done never cascades: the child is untouched.
    expect((await frontmatterOf(sandbox, "epic/a")).status).toBe("TODO");

    expect((await sandbox.run("done", "epic/a", "-m", "part")).code).toBe(0);
    expect((await sandbox.run("done", "epic", "-m", "whole")).code).toBe(0);
  });

  it("counts a cancelled child as resolved", async () => {
    sandbox = await treeSandbox({
      tasks: { epic: {}, "epic/a": { status: "CANCELLED" }, "epic/b": {} },
    });
    expect((await sandbox.run("cancel", "epic/b", "-m", "cut")).code).toBe(0);
    expect((await sandbox.run("done", "epic", "-m", "redefined")).code).toBe(0);
  });

  it("refuses done while a finishes_after task is open", async () => {
    sandbox = await treeSandbox({
      tasks: { other: {}, epic: { finishes_after: ["other"] } },
    });
    const refused = await sandbox.run("done", "epic", "-m", "x", "--json");
    expect(errorOf(refused).details).toEqual({
      id: "epic",
      kind: "finish-gate",
      open_children: [],
      finishes_after: [{ ref: "other", reason: "not-done", status: "TODO" }],
    });
    expect((await sandbox.run("cancel", "other", "-m", "x")).code).toBe(0);
    expect((await sandbox.run("done", "epic", "-m", "joined")).code).toBe(0);
  });

  it("counts a malformed child as open", async () => {
    sandbox = await treeSandbox({ tasks: { epic: {} } });
    await sandbox.write(".tasks/epic/broken/task.md", "not a manifest\n");
    const result = await sandbox.run("done", "epic", "-m", "x", "--json");
    expect(errorOf(result).details).toMatchObject({
      open_children: ["epic/broken"],
    });
  });
});

describe("hold", () => {
  it("refuses a claim under a claimed ancestor, naming it; --force overrides", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "IN_PROGRESS", claimed_by: "alice" },
        "epic/a": {},
      },
    });
    const refused = await sandbox.run("claim", "epic/a", "--json");
    expect(refused.code).toBe(4);
    const error = errorOf(refused);
    expect(error.details).toEqual({
      id: "epic/a",
      ancestor: "epic",
      kind: "held",
    });
    expect(error.message).toContain("claimed by alice");
    expect((await sandbox.run("claim", "epic/a", "--force")).code).toBe(0);
    expect((await lastEntry(sandbox, "epic/a")).text).toBe(
      "claim: TODO → IN_PROGRESS (forced)",
    );
  });

  it("refuses a claim under an assigned ancestor; --force overrides", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "PAUSED", state: true, assignee: "bob" },
        "epic/a": {},
      },
    });
    const refused = await sandbox.run("claim", "epic/a", "--json");
    expect(refusal(refused).kind).toBe("held");
    expect(errorOf(refused).message).toContain("assigned to bob");
    expect((await sandbox.run("claim", "epic/a", "--force")).code).toBe(0);
  });

  it("names the nearest holder", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { assignee: "bob" },
        "epic/mid": { assignee: "carol" },
        "epic/mid/leaf": {},
      },
    });
    const refused = await sandbox.run("claim", "epic/mid/leaf", "--json");
    expect(errorOf(refused).details).toMatchObject({ ancestor: "epic/mid" });
  });

  it("is released by unassign", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "PAUSED", state: true, assignee: "bob" },
        "epic/a": {},
      },
    });
    expect(
      (await sandbox.run("--as", "bob", "unassign", "epic", "-m", "APPLY"))
        .code,
    ).toBe(0);
    expect((await sandbox.run("claim", "epic/a")).code).toBe(0);
  });

  it("is reported as holds by claim and assign on a task with open descendants", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": {},
        "epic/a/deep": { status: "BACKLOG" },
        "epic/b": { status: "DONE" },
        other: {},
        "other/x": {},
      },
    });
    const claimed = await sandbox.run("claim", "epic", "--json");
    expect(claimed.json<TransitionJson>().holds).toBe(2);
    expect(
      plain((await sandbox.run("assign", "other", "alice")).stdout),
    ).toContain("now holds 1 task");
    const assigned = await sandbox.run(
      "--as",
      "alice",
      "assign",
      "other",
      "bob",
      "--json",
    );
    expect(assigned.json<TransitionJson>().holds).toBe(1);
  });

  it("omits holds on a task without open descendants", async () => {
    sandbox = await treeSandbox({
      tasks: { a: {}, "a/done": { status: "DONE" } },
    });
    const json = (
      await sandbox.run("claim", "a", "--json")
    ).json<TransitionJson>();
    expect(json).not.toHaveProperty("holds");
  });
});

describe("ancestors that block a claim or a reopen", () => {
  it("refuses a claim under a BACKLOG ancestor, naming it, even forced", async () => {
    sandbox = await treeSandbox({
      tasks: {
        later: { status: "BACKLOG" },
        "later/mid": { status: "BACKLOG" },
        "later/mid/leaf": { status: "BACKLOG" },
      },
    });
    for (const extra of [[], ["--force"]]) {
      const result = await sandbox.run(
        "claim",
        "later/mid/leaf",
        ...extra,
        "--json",
      );
      expect(result.code).toBe(4);
      const error = errorOf(result);
      expect(error.details).toEqual({
        id: "later/mid/leaf",
        ancestor: "later",
        kind: "backlog-ancestor",
      });
      expect(error.message).toContain("tasks schedule later");
    }
  });

  it("refuses a claim on a task whose parent is resolved, even forced", async () => {
    sandbox = await treeSandbox({
      tasks: { closed: { status: "DONE" }, "closed/a": {} },
    });
    for (const extra of [[], ["--force"]]) {
      const result = await sandbox.run("claim", "closed/a", ...extra, "--json");
      expect(result.code).toBe(4);
      expect(errorOf(result).details).toEqual({
        id: "closed/a",
        ancestor: "closed",
        kind: "resolved-ancestor",
        status: "DONE",
      });
    }
  });

  it("refuses to reopen a task before its resolved parent", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "CANCELLED" },
        "epic/a": { status: "CANCELLED" },
      },
    });
    const refused = await sandbox.run("reopen", "epic/a", "-m", "x", "--json");
    expect(errorOf(refused).details).toMatchObject({
      kind: "resolved-ancestor",
      ancestor: "epic",
      status: "CANCELLED",
    });
    // Reopening the parent reopens none of its children.
    expect((await sandbox.run("reopen", "epic", "-m", "back")).code).toBe(0);
    expect((await frontmatterOf(sandbox, "epic/a")).status).toBe("CANCELLED");
    expect((await sandbox.run("reopen", "epic/a", "-m", "back")).code).toBe(0);
  });

  it("lets done and cancel close a task under a BACKLOG ancestor", async () => {
    sandbox = await treeSandbox({
      tasks: {
        later: { status: "BACKLOG" },
        "later/a": { status: "BACKLOG" },
        "later/b": { status: "BACKLOG" },
      },
    });
    expect(
      (await sandbox.run("done", "later/a", "-m", "done elsewhere")).code,
    ).toBe(0);
    expect(
      (await sandbox.run("cancel", "later/b", "-m", "not needed")).code,
    ).toBe(0);
  });

  it("refuses a claim under a malformed ancestor", async () => {
    sandbox = await treeSandbox({ tasks: { "broken/a": {} } });
    await sandbox.write(".tasks/broken/task.md", "not a manifest\n");
    const result = await sandbox.run("claim", "broken/a", "--force", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      id: "broken/a",
      ancestor: "broken",
      kind: "malformed-ancestor",
    });
  });
});

describe("interrupted cascades", () => {
  it("a repeated cancel completes the cascade, skipping what is already cancelled", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": {},
        // What an interrupted run left: written, logged, parent not yet.
        "epic/b": {
          status: "CANCELLED",
          log: "## 2026-01-01T00:00:00Z tester\ncancel with epic: TODO → CANCELLED\n",
        },
      },
    });
    const before = await sandbox.read(".tasks/epic/b/task.md");
    const result = await sandbox.run("cancel", "epic", "-m", "again", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>().cascaded).toEqual(["epic/a"]);
    expect(await sandbox.read(".tasks/epic/b/task.md")).toBe(before);
    expect(await logTexts(sandbox, "epic/b")).toHaveLength(1);
    expect(await logTexts(sandbox, "epic")).toEqual([
      "cancel: TODO → CANCELLED\nreached: epic/a\nagain",
    ]);
  });

  it("a repeated defer skips the deeper descendants written first", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/mid": {},
        "epic/mid/leaf": { status: "BACKLOG" },
      },
    });
    const result = await sandbox.run("defer", "epic", "--json");
    expect(result.json<TransitionJson>().cascaded).toEqual(["epic/mid"]);
    expect(await sandbox.exists(".tasks/epic/mid/leaf/log.md")).toBe(false);
  });

  it("a repeated schedule completes the cascade the invariant waits for", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "BACKLOG" },
        "epic/a": {},
        "epic/b": { status: "BACKLOG" },
      },
    });
    const before = await sandbox.read(".tasks/epic/a/task.md");
    const result = await sandbox.run("schedule", "epic", "--json");
    expect(result.json<TransitionJson>().cascaded).toEqual(["epic/b"]);
    expect(await sandbox.read(".tasks/epic/a/task.md")).toBe(before);
    expect((await frontmatterOf(sandbox, "epic/b")).status).toBe("TODO");
  });
});

describe("malformed descendants", () => {
  it.each([
    [["defer", "epic"], "TODO"],
    [["cancel", "epic", "-m", "x"], "TODO"],
    [["schedule", "epic"], "BACKLOG"],
  ] as const)(
    "%j refuses to cascade over a manifest it cannot parse, even forced",
    async (argv, status) => {
      sandbox = await treeSandbox({
        tasks: { epic: { status }, "epic/ok": { status } },
      });
      await sandbox.write(".tasks/epic/broken/task.md", "not a manifest\n");
      const result = await sandbox.run(...argv, "--force", "--json");
      expect(result.code).toBe(4);
      expect(errorOf(result).details).toEqual({
        id: "epic",
        kind: "malformed-descendants",
        descendants: ["epic/broken"],
      });
      expect((await frontmatterOf(sandbox, "epic/ok")).status).toBe(status);
    },
  );
});
