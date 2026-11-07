import { afterEach, describe, expect, it } from "vitest";

import type { TransitionJson } from "../src/core/transitions.js";
import { DEFAULT_STATE, FIXTURE_TIME } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";
import {
  errorOf,
  frontmatterOf,
  lastEntry,
  logTexts,
  plain,
  refusal,
} from "./transitions-support.js";

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

/** The stamp a write leaves: `updated` and the log heading share one time. */
async function expectStamped(id: string): Promise<string> {
  const fm = await frontmatterOf(sandbox, id);
  const entry = await lastEntry(sandbox, id);
  expect(fm.updated).not.toBe(FIXTURE_TIME);
  expect(entry.time).toBe(fm.updated);
  expect(entry.actor).toBe("tester");
  return fm.updated;
}

describe("schedule", () => {
  it("moves a BACKLOG task without state.md to TODO", async () => {
    sandbox = await treeSandbox({ tasks: { a: { status: "BACKLOG" } } });
    const result = await sandbox.run("schedule", "a", "--json");
    expect(result.code).toBe(0);
    const json = result.json<TransitionJson>();
    expect(json).toMatchObject({ id: "a", status: "TODO", situation: "ready" });
    expect(json.cascaded).toEqual([]);
    expect((await frontmatterOf(sandbox, "a")).status).toBe("TODO");
    await expectStamped("a");
    expect(await logTexts(sandbox, "a")).toEqual(["schedule: BACKLOG → TODO"]);
  });

  it("restores PAUSED when the task has a state.md, which it keeps", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "BACKLOG", state: "## Next\n\nresume\n" } },
    });
    const result = await sandbox.run("schedule", "a", "-m", "back on the plan");
    expect(result.code).toBe(0);
    expect((await frontmatterOf(sandbox, "a")).status).toBe("PAUSED");
    expect(await sandbox.read(".tasks/a/state.md")).toBe("## Next\n\nresume\n");
    expect(await logTexts(sandbox, "a")).toEqual([
      "schedule: BACKLOG → PAUSED\nback on the plan",
    ]);
  });
});

describe("defer", () => {
  it("moves a TODO task to BACKLOG", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("defer", "a", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>().status).toBe("BACKLOG");
    await expectStamped("a");
    expect(await logTexts(sandbox, "a")).toEqual(["defer: TODO → BACKLOG"]);
  });

  it("moves a PAUSED task to BACKLOG, keeping its state.md and assignee", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "PAUSED", state: true, assignee: "tester" } },
    });
    const result = await sandbox.run("defer", "a", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "BACKLOG",
      assignee: "tester",
      situation: "parked",
    });
    expect(await sandbox.read(".tasks/a/state.md")).toBe(DEFAULT_STATE);
  });
});

describe("claim", () => {
  it("claims a TODO task, setting the three claim fields together", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.session("s1")("claim", "a", "--json");
    expect(result.code).toBe(0);
    const fm = await frontmatterOf(sandbox, "a");
    expect(fm).toMatchObject({
      status: "IN_PROGRESS",
      claimed_by: "tester",
      claimed_session: "s1",
    });
    const stamp = await expectStamped("a");
    expect(fm.claimed_at).toBe(stamp);
    const entry = await lastEntry(sandbox, "a");
    expect(entry.session).toBe("s1");
    expect(entry.text).toBe("claim: TODO → IN_PROGRESS");
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "IN_PROGRESS",
      situation: "working",
      liveness: "live",
      claimed_session: "s1",
    });
  });

  it("records a null session for a claimant without one", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("claim", "a")).code).toBe(0);
    const fm = await frontmatterOf(sandbox, "a");
    expect(fm.claimed_by).toBe("tester");
    expect(fm.claimed_session).toBeNull();
    expect((await lastEntry(sandbox, "a")).session).toBeNull();
  });

  it("claims from PAUSED and from BACKLOG", async () => {
    sandbox = await treeSandbox({
      tasks: { p: { status: "PAUSED", state: true }, b: { status: "BACKLOG" } },
    });
    expect((await sandbox.run("claim", "p")).code).toBe(0);
    expect((await sandbox.run("claim", "b")).code).toBe(0);
    expect(await logTexts(sandbox, "p")).toEqual([
      "claim: PAUSED → IN_PROGRESS",
    ]);
    expect(await logTexts(sandbox, "b")).toEqual([
      "claim: BACKLOG → IN_PROGRESS",
    ]);
  });

  it("carries an optional message into the log entry", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.run("claim", "a", "-m", "starting with the schema");
    expect(await logTexts(sandbox, "a")).toEqual([
      "claim: TODO → IN_PROGRESS\nstarting with the schema",
    ]);
  });
});

describe("pause", () => {
  it("pauses a claimed task with a state.md and a message, clearing the claim", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", state: true } },
    });
    const result = await sandbox.run(
      "pause",
      "a",
      "-m",
      "tests green",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(await frontmatterOf(sandbox, "a")).toMatchObject({
      status: "PAUSED",
      claimed_by: null,
      claimed_at: null,
      claimed_session: null,
    });
    await expectStamped("a");
    expect(await logTexts(sandbox, "a")).toEqual([
      "pause: IN_PROGRESS → PAUSED\ntests green",
    ]);
  });

  it("refuses without a state.md as a conflict naming the missing file", async () => {
    sandbox = await treeSandbox({ tasks: { a: { status: "IN_PROGRESS" } } });
    const before = await sandbox.read(".tasks/a/task.md");
    const result = await sandbox.run("pause", "a", "-m", "stop", "--json");
    expect(result.code).toBe(4);
    const error = errorOf(result);
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("state.md");
    expect(error.details).toEqual({ id: "a", kind: "missing-state" });
    expect(await sandbox.read(".tasks/a/task.md")).toBe(before);
    expect(await sandbox.exists(".tasks/a/log.md")).toBe(false);
  });
});

describe("release", () => {
  it("returns a claim without a state.md to TODO, clearing the claim", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", claimed_session: "s1" } },
    });
    const result = await sandbox.session("s1")("release", "a");
    expect(result.code).toBe(0);
    expect(await frontmatterOf(sandbox, "a")).toMatchObject({
      status: "TODO",
      claimed_by: null,
      claimed_at: null,
      claimed_session: null,
    });
    expect(await logTexts(sandbox, "a")).toEqual([
      "release: IN_PROGRESS → TODO",
    ]);
  });

  it("refuses while a state.md exists: the claim produced work", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", state: true } },
    });
    const result = await sandbox.run("release", "a", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toEqual({ id: "a", kind: "present-state" });
    expect((await frontmatterOf(sandbox, "a")).status).toBe("IN_PROGRESS");
  });
});

describe("done", () => {
  it("closes a claimed task with a message, clearing the claim", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", assignee: "tester" } },
    });
    const result = await sandbox.run("done", "a", "-m", "shipped", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "DONE",
      situation: "done",
      assignee: "tester",
      claimed_by: null,
    });
    await expectStamped("a");
    expect(await logTexts(sandbox, "a")).toEqual([
      "done: IN_PROGRESS → DONE\nshipped",
    ]);
  });

  it("closes a task from BACKLOG, TODO and PAUSED", async () => {
    sandbox = await treeSandbox({
      tasks: {
        b: { status: "BACKLOG" },
        t: {},
        p: { status: "PAUSED", state: true },
      },
    });
    for (const id of ["b", "t", "p"]) {
      expect((await sandbox.run("done", id, "-m", "found done")).code).toBe(0);
      expect((await frontmatterOf(sandbox, id)).status).toBe("DONE");
    }
    expect(await logTexts(sandbox, "b")).toEqual([
      "done: BACKLOG → DONE\nfound done",
    ]);
  });
});

describe("cancel", () => {
  it("cancels an open task with a message, clearing the claim", async () => {
    sandbox = await treeSandbox({ tasks: { a: { status: "IN_PROGRESS" } } });
    const result = await sandbox.run("cancel", "a", "-m", "obsolete", "--json");
    expect(result.code).toBe(0);
    const json = result.json<TransitionJson>();
    expect(json).toMatchObject({ status: "CANCELLED", claimed_by: null });
    expect(json.cascaded).toEqual([]);
    expect(json.dependents).toEqual([]);
    expect(await logTexts(sandbox, "a")).toEqual([
      "cancel: IN_PROGRESS → CANCELLED\nobsolete",
    ]);
  });
});

describe("reopen", () => {
  it("reopens to TODO without a state.md, keeping the assignee", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "DONE", assignee: "tester" } },
    });
    const result = await sandbox.run(
      "reopen",
      "a",
      "-m",
      "regressed",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "TODO",
      assignee: "tester",
    });
    expect(await logTexts(sandbox, "a")).toEqual([
      "reopen: DONE → TODO\nregressed",
    ]);
  });

  it("reopens to PAUSED when a state.md exists", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "CANCELLED", state: true } },
    });
    expect(
      (await sandbox.run("reopen", "a", "-m", "needed after all")).code,
    ).toBe(0);
    expect((await frontmatterOf(sandbox, "a")).status).toBe("PAUSED");
  });

  it("reopens to BACKLOG under a BACKLOG ancestor", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "BACKLOG" },
        "epic/a": { status: "DONE", state: true },
      },
    });
    expect((await sandbox.run("reopen", "epic/a", "-m", "again")).code).toBe(0);
    expect((await frontmatterOf(sandbox, "epic/a")).status).toBe("BACKLOG");
    expect(await logTexts(sandbox, "epic/a")).toEqual([
      "reopen: DONE → BACKLOG\nagain",
    ]);
  });
});

describe("handoff", () => {
  it("pauses and assigns in one log entry", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", state: true } },
    });
    const result = await sandbox.run(
      "handoff",
      "a",
      "alice",
      "-m",
      "review the CLI rendering",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "PAUSED",
      assignee: "alice",
      claimed_by: null,
      situation: "waiting",
      waiting_for: "alice",
    });
    expect(await logTexts(sandbox, "a")).toEqual([
      "handoff alice: IN_PROGRESS → PAUSED\nreview the CLI rendering",
    ]);
  });

  it("refuses without a state.md, as pause does", async () => {
    sandbox = await treeSandbox({ tasks: { a: { status: "IN_PROGRESS" } } });
    const result = await sandbox.run(
      "handoff",
      "a",
      "alice",
      "-m",
      "x",
      "--json",
    );
    expect(refusal(result)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "missing-state",
    });
    expect((await frontmatterOf(sandbox, "a")).assignee).toBeNull();
  });
});

describe("assign, unassign and priority", () => {
  it("assign sets the assignee without a status change", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("assign", "a", "alice", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "TODO",
      assignee: "alice",
      situation: "assigned",
    });
    await expectStamped("a");
    expect(await logTexts(sandbox, "a")).toEqual(["assign: alice"]);
  });

  it("unassign clears the assignee and logs the word alone", async () => {
    sandbox = await treeSandbox({ tasks: { a: { assignee: "tester" } } });
    const result = await sandbox.run("unassign", "a", "-m", "APPLY");
    expect(result.code).toBe(0);
    expect((await frontmatterOf(sandbox, "a")).assignee).toBeNull();
    expect(await logTexts(sandbox, "a")).toEqual(["unassign\nAPPLY"]);
  });

  it("priority sets the level and logs it", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "PAUSED", state: true } },
    });
    const result = await sandbox.run("priority", "a", "urgent", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      status: "PAUSED",
      priority: "urgent",
      effective_priority: "urgent",
    });
    expect(await logTexts(sandbox, "a")).toEqual(["priority: urgent"]);
  });

  it("works on an IN_PROGRESS task for its claimant", async () => {
    sandbox = await treeSandbox({ tasks: { a: { status: "IN_PROGRESS" } } });
    expect((await sandbox.run("priority", "a", "high")).code).toBe(0);
    expect((await sandbox.run("assign", "a", "alice")).code).toBe(0);
    expect(await frontmatterOf(sandbox, "a")).toMatchObject({
      status: "IN_PROGRESS",
      claimed_by: "tester",
      priority: "high",
      assignee: "alice",
    });
  });

  it("refuses a level outside the four as a usage error", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("priority", "a", "HIGH", "--json");
    expect(result.code).toBe(2);
    expect(errorOf(result).code).toBe("USAGE");
  });

  it("refuses an actor that fails the pattern as a usage error", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", state: true } },
    });
    expect((await sandbox.run("assign", "a", "two words")).code).toBe(2);
    expect(
      (await sandbox.run("handoff", "a", "two words", "-m", "x")).code,
    ).toBe(2);
    expect(await sandbox.exists(".tasks/a/log.md")).toBe(false);
  });

  it("only logs an assign of the current assignee or a priority of the current level", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { assignee: "alice", priority: "high" } },
    });
    const before = await sandbox.read(".tasks/a/task.md");
    const assigned = await sandbox.run(
      "--as",
      "alice",
      "assign",
      "a",
      "alice",
      "-m",
      "still yours",
    );
    expect(assigned.code).toBe(0);
    const prioritized = await sandbox.run(
      "--as",
      "alice",
      "priority",
      "a",
      "high",
    );
    expect(prioritized.code).toBe(0);
    expect(await sandbox.read(".tasks/a/task.md")).toBe(before);
    expect(await logTexts(sandbox, "a")).toEqual([
      "assign: alice\nstill yours",
      "priority: high",
    ]);
    expect(plain(assigned.stdout)).toContain("already so");
  });

  it("refuses to unassign a task nobody is assigned to", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("unassign", "a", "--json");
    expect(refusal(result)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "not-assigned",
    });
    expect(await sandbox.exists(".tasks/a/log.md")).toBe(false);
  });

  it("refuses all three on a resolved task", async () => {
    sandbox = await treeSandbox({ tasks: { a: { status: "DONE" } } });
    for (const argv of [
      ["assign", "a", "alice"],
      ["unassign", "a"],
      ["priority", "a", "high"],
    ]) {
      const result = await sandbox.run(...argv, "--json");
      expect(result.code).toBe(4);
      expect(errorOf(result).details).toMatchObject({
        id: "a",
        kind: "illegal-transition",
        from: "DONE",
        to: "DONE",
        allowed: ["BACKLOG", "TODO", "IN_PROGRESS", "PAUSED"],
      });
    }
  });
});

describe("messages", () => {
  it.each([
    [["pause", "a"], { status: "IN_PROGRESS", state: true }],
    [["done", "a"], {}],
    [["cancel", "a"], {}],
    [["reopen", "a"], { status: "DONE" }],
    [["handoff", "a", "alice"], { status: "IN_PROGRESS", state: true }],
  ] as const)(
    "%j requires a message, as a usage error that writes nothing",
    async (argv, spec) => {
      sandbox = await treeSandbox({ tasks: { a: { ...spec } } });
      const before = await sandbox.read(".tasks/a/task.md");
      const result = await sandbox.run(...argv, "--json");
      expect(result.code).toBe(2);
      const error = errorOf(result);
      expect(error.code).toBe("USAGE");
      expect(error.message).toContain("-m");
      expect(await sandbox.read(".tasks/a/task.md")).toBe(before);
      expect(await sandbox.exists(".tasks/a/log.md")).toBe(false);
    },
  );

  it("counts an empty or blank message as missing", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("done", "a", "-m", "")).code).toBe(2);
    expect((await sandbox.run("done", "a", "-m", "  ")).code).toBe(2);
  });

  it("refuses a message line that would read as a log heading", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run(
      "done",
      "a",
      "-m",
      "fine\n## 2026-01-01T00:00:00Z mallory",
      "--json",
    );
    expect(result.code).toBe(2);
    expect((await frontmatterOf(sandbox, "a")).status).toBe("TODO");
  });

  it("keeps a multi-line message whole", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.run("done", "a", "-m", "first line\nsecond line");
    expect(await logTexts(sandbox, "a")).toEqual([
      "done: TODO → DONE\nfirst line\nsecond line",
    ]);
  });
});

describe("illegal transitions", () => {
  it.each([
    [["schedule", "a"], "TODO", "TODO", ["BACKLOG"]],
    [["defer", "a"], "BACKLOG", "BACKLOG", ["TODO", "PAUSED"]],
    [["defer", "a"], "IN_PROGRESS", "BACKLOG", ["TODO", "PAUSED"]],
    [["claim", "a"], "DONE", "IN_PROGRESS", ["BACKLOG", "TODO", "PAUSED"]],
    [["pause", "a", "-m", "x"], "TODO", "PAUSED", ["IN_PROGRESS"]],
    [["release", "a"], "PAUSED", "TODO", ["IN_PROGRESS"]],
    [
      ["done", "a", "-m", "x"],
      "DONE",
      "DONE",
      ["BACKLOG", "TODO", "IN_PROGRESS", "PAUSED"],
    ],
    [
      ["cancel", "a", "-m", "x"],
      "CANCELLED",
      "CANCELLED",
      ["BACKLOG", "TODO", "IN_PROGRESS", "PAUSED"],
    ],
    [["reopen", "a", "-m", "x"], "TODO", "TODO", ["DONE", "CANCELLED"]],
    [["handoff", "a", "alice", "-m", "x"], "PAUSED", "PAUSED", ["IN_PROGRESS"]],
  ] as const)(
    "%j from %s is a conflict naming from, to and allowed, even forced",
    async (argv, from, to, allowed) => {
      sandbox = await treeSandbox({
        tasks: { a: { status: from, state: from === "PAUSED" } },
      });
      for (const extra of [[], ["--force"]]) {
        const result = await sandbox.run(...argv, ...extra, "--json");
        expect(result.code).toBe(4);
        expect(errorOf(result).details).toEqual({
          id: "a",
          from,
          to,
          allowed,
          kind: "illegal-transition",
        });
      }
      expect(await sandbox.exists(".tasks/a/log.md")).toBe(false);
    },
  );
});

describe("addressing", () => {
  it("resolves an unambiguous suffix and refuses an ambiguous one", async () => {
    sandbox = await treeSandbox({
      tasks: { "auth/tests": {}, "billing/tests": {}, "auth/schema": {} },
    });
    const ok = await sandbox.run("claim", "schema", "--json");
    expect(ok.code).toBe(0);
    expect(ok.json<TransitionJson>().id).toBe("auth/schema");

    const ambiguous = await sandbox.run("claim", "tests", "--json");
    expect(ambiguous.code).toBe(2);
    expect(errorOf(ambiguous).details).toMatchObject({
      candidates: ["auth/tests", "billing/tests"],
    });
  });

  it("finds the tree from -C", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.runWith(
      { cwd: sandbox.root },
      "-C",
      sandbox.dir,
      "claim",
      "a",
    );
    expect(result.code).toBe(0);
    expect((await frontmatterOf(sandbox, "a")).status).toBe("IN_PROGRESS");
  });

  it("exits with the usage code on an unknown option", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("claim", "a", "--bogus")).code).toBe(2);
    expect((await sandbox.run("pause", "--bogus")).code).toBe(2);
    expect((await sandbox.run("handoff", "a")).code).toBe(2);
  });

  it("fails as not found for a task that does not exist", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("claim", "nope")).code).toBe(3);
  });

  it("fails as not found for an archived task", async () => {
    sandbox = await treeSandbox({ archived: { old: { status: "DONE" } } });
    const result = await sandbox.run("reopen", "old", "-m", "x", "--json");
    expect(result.code).toBe(3);
    expect(errorOf(result).details).toMatchObject({ archived: true });
  });

  it("refuses a malformed task as a conflict", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(".tasks/broken/task.md", "no frontmatter\n");
    const result = await sandbox.run("claim", "broken", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      id: "broken",
      kind: "malformed",
    });
  });
});

describe("after the write", () => {
  it("regenerates index.md when it exists", async () => {
    sandbox = await treeSandbox({ tasks: { a: { title: "Alpha" } } });
    await sandbox.write(".tasks/index.md", "stale\n");
    expect((await sandbox.run("claim", "a")).code).toBe(0);
    const index = await sandbox.read(".tasks/index.md");
    expect(index).not.toContain("stale");
    expect(index).toContain("Alpha");
  });

  it("never creates index.md", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("claim", "a")).code).toBe(0);
    expect(await sandbox.exists(".tasks/index.md")).toBe(false);
  });

  it("releases the tree lock, also after a refusal", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.run("pause", "a", "-m", "x");
    expect(await sandbox.exists(".tasks/.locks/tree.lock")).toBe(false);
    await sandbox.run("claim", "a");
    expect(await sandbox.exists(".tasks/.locks/tree.lock")).toBe(false);
  });

  it("returns the task object with its derived conditions", async () => {
    sandbox = await treeSandbox({ tasks: { a: { title: "Alpha" } } });
    const json = (await sandbox.run("claim", "a", "--json")).json<
      Record<string, unknown>
    >();
    for (const key of [
      "id",
      "name",
      "parent",
      "project",
      "title",
      "status",
      "path",
      "situation",
      "blocked_by",
      "ready",
      "effective_priority",
      "held_by",
      "started",
      "children",
      "active",
      "waiting_for",
      "liveness",
      "last_seen",
      "last_entry",
    ]) {
      expect(json).toHaveProperty(key);
    }
    expect(json.last_entry).toMatchObject({
      actor: "tester",
      text: "claim: TODO → IN_PROGRESS",
    });
    expect(json).not.toHaveProperty("cascaded");
    expect(json).not.toHaveProperty("dependents");
    expect(json).not.toHaveProperty("holds");
  });

  it("prints one human line naming the transition", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("claim", "a");
    expect(plain(result.stdout)).toBe("✓ claim a: TODO → IN_PROGRESS\n");
  });
});
