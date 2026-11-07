import { describe, expect, it } from "vitest";

import type { Verdict } from "../src/core/authorization.js";
import { judgeAuthorization } from "../src/core/authorization.js";
import type { Task } from "../src/core/task.js";
import { makeTask } from "../src/core/task.js";
import type { ClaimLiveness, Identity } from "../src/core/types.js";
import type { TaskSpec } from "./fixtures.js";
import { specFrontmatter } from "./fixtures.js";

function task(id: string, spec: TaskSpec = {}): Task {
  const slash = id.lastIndexOf("/");
  return makeTask({
    id,
    dir: `/repo/.tasks/${id}`,
    archived: false,
    parent: slash === -1 ? null : id.slice(0, slash),
    frontmatter: specFrontmatter(spec),
    body: `# ${id}\n`,
  });
}

const alice: Identity = { actor: "alice", via: null, session: "s1" };
const bob: Identity = { actor: "bob", via: null, session: "s2" };
const LIVE: ClaimLiveness = {
  liveness: "live",
  last_seen: "2026-01-01T00:00:00Z",
};
const ORPHANED: ClaimLiveness = {
  liveness: "orphaned",
  last_seen: "2026-01-01T00:00:00Z",
};
const UNKNOWN: ClaimLiveness = { liveness: "unknown", last_seen: null };

interface Case {
  identity?: Identity;
  claimed?: ClaimLiveness | null;
  ancestors?: Task[];
  command?: string;
}

function judge(subject: Task, options: Case = {}): Verdict {
  return judgeAuthorization({
    task: subject,
    ancestors: options.ancestors ?? [],
    identity: options.identity ?? alice,
    claimed: options.claimed ?? null,
    shown: subject.id,
    command: options.command ?? "pause",
  });
}

function refused(verdict: Verdict) {
  expect(verdict.admitted).toBe(false);
  if (verdict.admitted) throw new Error("unreachable");
  return verdict;
}

describe("judgeAuthorization", () => {
  it("admits anyone to a task nobody claims or holds", () => {
    expect(judge(task("x"))).toEqual({ admitted: true, superseded: null });
  });

  it("admits the assignee and an ancestor's assignee, refuses others", () => {
    const held = task("epic/part", { assignee: "bob" });
    expect(judge(held, { identity: bob }).admitted).toBe(true);
    expect(
      judge(held, { ancestors: [task("epic", { assignee: "alice" })] })
        .admitted,
    ).toBe(true);

    const verdict = refused(judge(held, { command: "edit" }));
    expect(verdict.superseded).toBeNull();
    expect(verdict.refusal.exitCode).toBe(4);
    expect(verdict.refusal.message).toContain("only bob or the assignee");
    expect(verdict.refusal.message).toContain("may edit it");
    expect(verdict.refusal.details).toEqual({
      id: "epic/part",
      kind: "authorization",
      claimed_by: null,
      claimed_session: null,
      assignee: "bob",
      liveness: null,
    });
  });

  it("admits the claimant from the claim's session and nobody else while the claim is live", () => {
    const claimed = task("x", {
      status: "IN_PROGRESS",
      claimed_by: "alice",
      claimed_session: "s1",
      assignee: "bob",
    });
    expect(judge(claimed, { claimed: LIVE })).toEqual({
      admitted: true,
      superseded: null,
    });

    const other = { ...alice, session: "s9" };
    for (const [identity, liveness] of [
      [other, LIVE],
      [bob, LIVE],
      [bob, UNKNOWN],
    ] as const) {
      const verdict = refused(
        judge(claimed, { identity, claimed: liveness, command: "move" }),
      );
      expect(verdict.refusal.message).toContain(
        "only its claimant may move it",
      );
      expect(verdict.refusal.details).toMatchObject({
        kind: "authorization",
        claimed_by: "alice",
        claimed_session: "s1",
        liveness: liveness.liveness,
      });
      // What a forced write records: the claim it went past.
      expect(verdict.superseded).toEqual({
        id: "x",
        claimant: "alice",
        session: "s1",
        liveness: liveness.liveness,
        last_seen: liveness.last_seen,
      });
    }
  });

  it("never lets `claim` pass as the claimant: another claim is a takeover or a refusal", () => {
    const claimed = task("x", {
      status: "IN_PROGRESS",
      claimed_by: "alice",
      claimed_session: null,
    });
    const verdict = refused(
      judge(claimed, { claimed: UNKNOWN, command: "claim" }),
    );
    expect(verdict.refusal.message).toContain(
      "a claim whose liveness cannot be judged is refused",
    );
    expect(
      judge(claimed, { claimed: ORPHANED, command: "claim" }).admitted,
    ).toBe(true);
  });

  it("passes an orphaned claim, records it, and still applies the assignee rule", () => {
    const orphaned = task("x", {
      status: "IN_PROGRESS",
      claimed_by: "bob",
      claimed_session: "s2",
      assignee: "bob",
    });
    const passed = {
      id: "x",
      claimant: "bob",
      session: "s2",
      liveness: "orphaned",
      last_seen: ORPHANED.last_seen,
    };
    const verdict = refused(judge(orphaned, { claimed: ORPHANED }));
    expect(verdict.refusal.message).toContain("is assigned to bob");
    expect(verdict.superseded).toEqual(passed);

    const free = task("x", {
      status: "IN_PROGRESS",
      claimed_by: "bob",
      claimed_session: "s2",
    });
    expect(judge(free, { claimed: ORPHANED })).toEqual({
      admitted: true,
      superseded: passed,
    });
  });

  it("records nobody when the claim fields name nobody", () => {
    const odd = task("x", { status: "IN_PROGRESS", claimed_by: null });
    expect(judge(odd, { claimed: ORPHANED })).toEqual({
      admitted: true,
      superseded: null,
    });
  });
});
