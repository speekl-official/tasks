import { afterEach, describe, expect, it } from "vitest";

import type { TransitionJson } from "../src/core/transitions.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";
import {
  endSession,
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

/** Older than the default 30-minute timeout. */
const STALE = 31;

describe("authorization", () => {
  it("lets only the claimant's session transition a live claim", async () => {
    sandbox = await treeSandbox({ tasks: { a: { state: true } } });
    expect((await sandbox.session("s1")("claim", "a")).code).toBe(0);

    for (const run of [sandbox.session("s2"), sandbox.run]) {
      const result = await run("pause", "a", "-m", "x", "--json");
      expect(result.code).toBe(4);
      expect(errorOf(result).details).toEqual({
        id: "a",
        kind: "authorization",
        claimed_by: "tester",
        claimed_session: "s1",
        assignee: null,
        liveness: "live",
      });
    }
    expect((await sandbox.session("s1")("pause", "a", "-m", "x")).code).toBe(0);
  });

  it("refuses another actor on a live claim, even in the claimant's session", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.session("s1")("claim", "a");
    const result = await sandbox.session("s1")(
      "--as",
      "alice",
      "done",
      "a",
      "-m",
      "x",
      "--json",
    );
    expect(refusal(result)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "authorization",
    });
  });

  it("lets the claimant of a claim without a session act from any session", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", state: true } },
    });
    expect((await sandbox.session("s9")("pause", "a", "-m", "x")).code).toBe(0);
  });

  it("lets only the assignee or an ancestor's assignee act on an assigned task", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { assignee: "bob" },
        "epic/a": { assignee: "alice" },
        "epic/b": { assignee: "alice" },
      },
    });
    const refused = await sandbox.run("priority", "epic/a", "high", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toEqual({
      id: "epic/a",
      kind: "authorization",
      claimed_by: null,
      claimed_session: null,
      assignee: "alice",
      liveness: null,
    });
    expect(
      (await sandbox.run("--as", "alice", "priority", "epic/a", "high")).code,
    ).toBe(0);
    // Authority flows down the tree: the epic's assignee acts on its parts.
    expect(
      (await sandbox.run("--as", "bob", "priority", "epic/b", "high")).code,
    ).toBe(0);
  });

  it("lets anyone transition a task that is neither claimed nor assigned", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("--as", "zed", "defer", "a")).code).toBe(0);
  });

  it("refuses a claim the assignee rule does not allow like a claim on a claimed task", async () => {
    sandbox = await treeSandbox({ tasks: { a: { assignee: "alice" } } });
    const result = await sandbox.run("claim", "a", "--json");
    expect(refusal(result)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "authorization",
    });
    expect((await sandbox.run("--as", "alice", "claim", "a")).code).toBe(0);
  });

  it("--as acts for the principal and records the operator", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("--as", "alice", "claim", "a", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>().claimed_by).toBe("alice");
    const entry = await lastEntry(sandbox, "a");
    expect(entry.actor).toBe("alice");
    expect(entry.via).toBe("tester");
    expect(await sandbox.read(".tasks/a/log.md")).toMatch(
      /^## \S+ alice via tester\n/,
    );
    // The claim is alice's: the operator alone is not its claimant.
    expect((await sandbox.run("release", "a")).code).toBe(4);
    // Global options are accepted after the command as well.
    expect((await sandbox.run("release", "a", "--as", "alice")).code).toBe(0);
  });

  it("authorizes a cascade on the named task only", async () => {
    sandbox = await treeSandbox({
      tasks: { epic: {}, "epic/a": { assignee: "alice" } },
    });
    const result = await sandbox.run(
      "cancel",
      "epic",
      "-m",
      "dropped",
      "--json",
    );
    expect(result.code).toBe(0);
    expect((await frontmatterOf(sandbox, "epic/a")).status).toBe("CANCELLED");
  });
});

describe("claims across sessions", () => {
  it("refuses a claim by the session that holds it, even forced", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.session("s1")("claim", "a");
    for (const extra of [[], ["--force"]]) {
      const result = await sandbox.session("s1")(
        "claim",
        "a",
        ...extra,
        "--json",
      );
      expect(refusal(result)).toEqual({
        code: 4,
        error: "CONFLICT",
        kind: "already-claimed",
      });
    }
    expect(await logTexts(sandbox, "a")).toHaveLength(1);
  });

  it("refuses a claim without a session on the actor's own sessionless claim", async () => {
    sandbox = await treeSandbox({ tasks: { a: { status: "IN_PROGRESS" } } });
    const result = await sandbox.run("claim", "a", "--json");
    expect(refusal(result).kind).toBe("already-claimed");
  });

  it("refuses a claim on a live claim from another session", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.session("s1")("claim", "a");
    const result = await sandbox.session("s2")("claim", "a", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      kind: "authorization",
      claimed_session: "s1",
      liveness: "live",
    });
  });

  it("refuses a claim on an unknown claim: a claim without a session", async () => {
    sandbox = await treeSandbox({ tasks: { a: { status: "IN_PROGRESS" } } });
    // The same actor from a session cannot tell the claim is not live work.
    const result = await sandbox.session("s2")("claim", "a", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      kind: "authorization",
      claimed_session: null,
      liveness: "unknown",
    });
  });

  it("refuses a claim on an unknown claim: a session with no heartbeat here", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", claimed_session: "elsewhere" } },
    });
    const result = await sandbox.session("s2")("claim", "a", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      claimed_session: "elsewhere",
      liveness: "unknown",
    });
  });

  it("takes over a live claim with --force, recording the superseded session", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.session("s1")("claim", "a");
    const seen = await lastSeen(sandbox, "s1");
    const result = await sandbox.session("s2")(
      "claim",
      "a",
      "--force",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>().claimed_session).toBe("s2");
    expect((await lastEntry(sandbox, "a")).text).toBe(
      `claim: IN_PROGRESS → IN_PROGRESS (forced)\nsupersedes tester s:s1, last seen ${seen}`,
    );
  });

  it("recovers a claim without a session only with --force", async () => {
    // A migrated claim carries no session: its liveness is unknown for good.
    sandbox = await treeSandbox({ tasks: { a: { status: "IN_PROGRESS" } } });
    expect((await sandbox.session("s2")("claim", "a")).code).toBe(4);
    const result = await sandbox.session("s2")("claim", "a", "--force");
    expect(result.code).toBe(0);
    expect((await frontmatterOf(sandbox, "a")).claimed_session).toBe("s2");
    expect((await lastEntry(sandbox, "a")).text).toBe(
      "claim: IN_PROGRESS → IN_PROGRESS (forced)\nsupersedes tester, last seen unknown",
    );
  });

  it("takes over an orphaned claim without force, logging who was superseded and when", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.session("s1")("claim", "a");
    await sandbox.age(".tasks/.locks/sessions/s1", STALE);
    const seen = await lastSeen(sandbox, "s1");

    const result = await sandbox.session("s2")("claim", "a", "--json");
    expect(result.code).toBe(0);
    const fm = await frontmatterOf(sandbox, "a");
    expect(fm).toMatchObject({
      status: "IN_PROGRESS",
      claimed_by: "tester",
      claimed_session: "s2",
    });
    const entry = await lastEntry(sandbox, "a");
    expect(entry.session).toBe("s2");
    expect(entry.text).toBe(
      `claim: IN_PROGRESS → IN_PROGRESS\nsupersedes tester s:s1, last seen ${seen}`,
    );
    expect(fm.claimed_at).toBe(entry.time);
  });

  it("answers the superseded session's next transition with a conflict", async () => {
    sandbox = await treeSandbox({ tasks: { a: { state: true } } });
    await sandbox.session("s1")("claim", "a");
    await sandbox.age(".tasks/.locks/sessions/s1", STALE);
    expect((await sandbox.session("s2")("claim", "a")).code).toBe(0);

    const result = await sandbox.session("s1")(
      "pause",
      "a",
      "-m",
      "mine",
      "--json",
    );
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      kind: "authorization",
      claimed_session: "s2",
      liveness: "live",
    });
    expect((await frontmatterOf(sandbox, "a")).claimed_session).toBe("s2");
  });

  it("orphans a claim at once when its session ended", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.session("s1")("claim", "a");
    await endSession(sandbox, "s1");
    const result = await sandbox.session("s2")("claim", "a", "--json");
    expect(result.code).toBe(0);
    expect((await lastEntry(sandbox, "a")).text).toMatch(
      /^claim: IN_PROGRESS → IN_PROGRESS\nsupersedes tester s:s1, last seen \S+Z$/,
    );
  });

  it("lets another actor take over an orphaned claim without force", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", claimed_session: "s1" } },
    });
    await heartbeat(sandbox, "s1", STALE);
    const result = await sandbox.session("s2")(
      "--as",
      "alice",
      "claim",
      "a",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      claimed_by: "alice",
      claimed_session: "s2",
    });
  });

  it("keeps the assignee rule for a takeover; force lifts it", async () => {
    sandbox = await treeSandbox({
      tasks: {
        a: {
          status: "IN_PROGRESS",
          assignee: "alice",
          claimed_by: "alice",
          claimed_session: "s1",
        },
      },
    });
    await heartbeat(sandbox, "s1", STALE);
    const refused = await sandbox.session("s2")("claim", "a", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toMatchObject({
      kind: "authorization",
      assignee: "alice",
      liveness: "orphaned",
    });
    const forced = await sandbox.session("s2")("claim", "a", "--force");
    expect(forced.code).toBe(0);
    expect((await frontmatterOf(sandbox, "a")).claimed_by).toBe("tester");
  });

  it("records the takeover on any transition over an orphaned claim", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.session("s1")("claim", "a");
    await sandbox.age(".tasks/.locks/sessions/s1", STALE);
    const seen = await lastSeen(sandbox, "s1");
    const result = await sandbox.run(
      "--as",
      "alice",
      "cancel",
      "a",
      "-m",
      "stale",
    );
    expect(result.code).toBe(0);
    expect((await lastEntry(sandbox, "a")).text).toBe(
      `cancel: IN_PROGRESS → CANCELLED\nsupersedes tester s:s1, last seen ${seen}\nstale`,
    );
    expect(plain(result.stdout)).toContain("superseded tester s:s1 on a");
  });

  it("does not need the heartbeat of a session that is not the claim's", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.session("s1")("claim", "a");
    // Another session's activity says nothing about s1's claim.
    await heartbeat(sandbox, "s2");
    const result = await sandbox.session("s2")("claim", "a");
    expect(result.code).toBe(4);
  });
});

describe("force", () => {
  it("overrides the start gate on claim and on done, and marks the entry", async () => {
    sandbox = await treeSandbox({
      tasks: {
        dep: {},
        a: { depends_on: ["dep"] },
        b: { depends_on: ["dep"] },
      },
    });
    const refused = await sandbox.run("claim", "a", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toEqual({
      id: "a",
      kind: "start-gate",
      blocked_by: [{ ref: "dep", reason: "not-done", status: "TODO" }],
    });
    expect((await sandbox.run("claim", "a", "--force")).code).toBe(0);
    expect((await lastEntry(sandbox, "a")).text).toBe(
      "claim: TODO → IN_PROGRESS (forced)",
    );

    const notDone = await sandbox.run("done", "b", "-m", "x", "--json");
    expect(refusal(notDone).kind).toBe("start-gate");
    expect((await sandbox.run("done", "b", "-m", "x", "--force")).code).toBe(0);
    expect((await lastEntry(sandbox, "b")).text).toBe(
      "done: TODO → DONE (forced)\nx",
    );
  });

  it("overrides the assignee rule", async () => {
    sandbox = await treeSandbox({ tasks: { a: { assignee: "alice" } } });
    expect((await sandbox.run("defer", "a", "--force")).code).toBe(0);
    expect((await lastEntry(sandbox, "a")).text).toBe(
      "defer: TODO → BACKLOG (forced)",
    );
  });

  it("does not override the finish gate", async () => {
    sandbox = await treeSandbox({ tasks: { epic: {}, "epic/a": {} } });
    const result = await sandbox.run(
      "done",
      "epic",
      "-m",
      "x",
      "--force",
      "--json",
    );
    expect(refusal(result).kind).toBe("finish-gate");
  });

  it("does not override the state.md rules of pause, handoff and release", async () => {
    sandbox = await treeSandbox({
      tasks: {
        bare: { status: "IN_PROGRESS" },
        worked: { status: "IN_PROGRESS", state: true },
      },
    });
    const pause = await sandbox.run(
      "pause",
      "bare",
      "-m",
      "x",
      "--force",
      "--json",
    );
    expect(refusal(pause).kind).toBe("missing-state");
    const handoff = await sandbox.run(
      "handoff",
      "bare",
      "alice",
      "-m",
      "x",
      "--force",
      "--json",
    );
    expect(refusal(handoff).kind).toBe("missing-state");
    const release = await sandbox.run("release", "worked", "--force", "--json");
    expect(refusal(release).kind).toBe("present-state");
  });

  it("does not override a resolved parent or a BACKLOG ancestor", async () => {
    sandbox = await treeSandbox({
      tasks: {
        closed: { status: "DONE" },
        "closed/a": { status: "DONE" },
        later: { status: "BACKLOG" },
        "later/b": { status: "BACKLOG" },
      },
    });
    const reopen = await sandbox.run(
      "reopen",
      "closed/a",
      "-m",
      "x",
      "--force",
      "--json",
    );
    expect(refusal(reopen).kind).toBe("resolved-ancestor");
    const claim = await sandbox.run("claim", "later/b", "--force", "--json");
    expect(refusal(claim).kind).toBe("backlog-ancestor");
    const schedule = await sandbox.run(
      "schedule",
      "later/b",
      "--force",
      "--json",
    );
    expect(refusal(schedule).kind).toBe("backlog-ancestor");
  });

  it("is not recorded when nothing needed forcing", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("claim", "a", "--force");
    expect(result.code).toBe(0);
    expect((await lastEntry(sandbox, "a")).text).toBe(
      "claim: TODO → IN_PROGRESS",
    );
    expect(plain(result.stdout)).not.toContain("forced");
  });
});
