import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openContext } from "../src/context.js";
import type { TransitionJson } from "../src/core/transitions.js";
import { claimNext } from "../src/core/transitions.js";
import { isTaskError } from "../src/errors.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";
import {
  errorOf,
  fakeCommand,
  frontmatterOf,
  heartbeat,
  logTexts,
} from "./transitions-support.js";

let sandbox: Sandbox;

afterEach(async () => {
  vi.unstubAllEnvs();
  await sandbox?.cleanup();
});

function at(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
}

async function next(...extra: string[]): Promise<string | number> {
  const result = await sandbox.run("claim", "--next", ...extra, "--json");
  return result.code === 0 ? result.json<TransitionJson>().id : result.code;
}

describe("claim --next", () => {
  it("claims in ready order: effective priority, PAUSED first, then oldest", async () => {
    sandbox = await treeSandbox({
      tasks: {
        low: { priority: "low", created: at(1) },
        old: { created: at(2) },
        newer: { created: at(3) },
        paused: { status: "PAUSED", state: true, created: at(4) },
        urgent: { priority: "urgent", created: at(5) },
        epic: { priority: "high", created: at(6) },
        "epic/part": { created: at(7) },
      },
    });
    const order: Array<string | number> = [];
    for (let i = 0; i < 6; i += 1) order.push(await next());
    expect(order).toEqual([
      "urgent",
      "epic/part",
      "paused",
      "old",
      "newer",
      "low",
    ]);
    // The epic stays held by its claimed part; nothing else is ready.
    expect(await next()).toBe(3);
  });

  it("claims for the caller, in its session, with the message", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.session("s1")(
      "--as",
      "alice",
      "claim",
      "--next",
      "-m",
      "picking up",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      id: "a",
      claimed_by: "alice",
      claimed_session: "s1",
    });
    expect(await logTexts(sandbox, "a")).toEqual([
      "claim: TODO → IN_PROGRESS\npicking up",
    ]);
  });

  it("skips tasks assigned to someone else and takes the caller's own", async () => {
    sandbox = await treeSandbox({
      tasks: {
        theirs: { assignee: "bob", created: at(1) },
        mine: { assignee: "tester", created: at(2) },
      },
    });
    expect(await next()).toBe("mine");
    expect(await next()).toBe(3);
  });

  it("never takes a task held by a claimed or assigned ancestor", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "PAUSED", state: true, assignee: "bob" },
        "epic/a": {},
        "epic/b": {},
      },
    });
    expect(await next()).toBe(3);
    expect((await frontmatterOf(sandbox, "epic/a")).status).toBe("TODO");
  });

  it("stays within --scope", async () => {
    sandbox = await treeSandbox({
      tasks: { "auth/a": { created: at(2) }, "billing/b": { created: at(1) } },
    });
    expect(await next("--scope", "auth")).toBe("auth/a");
    const result = await sandbox.run(
      "claim",
      "--next",
      "--scope",
      "auth",
      "--json",
    );
    expect(result.code).toBe(3);
    expect(errorOf(result).details).toEqual({ scope: "auth" });
  });

  it("uses the configured scope by default; --all lifts it", async () => {
    sandbox = await treeSandbox({
      scope: "auth",
      tasks: { "auth/a": { created: at(2) }, "billing/b": { created: at(1) } },
    });
    expect(await next()).toBe("auth/a");
    expect(await next()).toBe(3);
    expect(await next("--all")).toBe("billing/b");
  });

  it("spans listed projects in ready order; --local keeps to the local tree", async () => {
    sandbox = await treeSandbox({
      scope: "auth",
      tasks: { "auth/a": { created: at(3) } },
    });
    const backend = await sandbox.project("backend", "../backend", {
      tasks: { x: { created: at(1) }, "far/y": { created: at(2) } },
    });
    expect(await next("--local")).toBe("auth/a");

    const result = await sandbox.run("claim", "--next", "--json");
    expect(result.code).toBe(0);
    // The local scope never narrows another tree.
    expect(result.json<TransitionJson>()).toMatchObject({
      id: "backend:x",
      project: "backend",
      path: path.join(backend, ".tasks", "x"),
    });
    expect((await frontmatterOf(sandbox, "x", backend)).status).toBe(
      "IN_PROGRESS",
    );
    expect(await logTexts(sandbox, "x", backend)).toEqual([
      "claim: TODO → IN_PROGRESS",
    ]);
    expect(await next()).toBe("backend:far/y");
  });

  it("fails as not found when nothing is ready", async () => {
    sandbox = await treeSandbox({ tasks: { done: { status: "DONE" } } });
    const result = await sandbox.run("claim", "--next", "--json");
    expect(result.code).toBe(3);
    const error = errorOf(result);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.details).toEqual({ scope: null });
  });

  it("refuses a task together with --next, and the --next options without it", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    for (const argv of [
      ["claim", "a", "--next"],
      ["claim", "--scope", "a"],
      ["claim", "--local"],
      ["claim", "a", "--all"],
      ["claim"],
      ["claim", "--next", "--scope", "Not A Path"],
    ]) {
      const result = await sandbox.run(...argv, "--json");
      expect(result.code).toBe(2);
      expect(errorOf(result).code).toBe("USAGE");
    }
    expect(await sandbox.exists(".tasks/a/log.md")).toBe(false);
  });

  it("hands every agent of a crowd a different task", async () => {
    vi.stubEnv("TASKS_ACTOR", "tester");
    vi.stubEnv("TASKS_SESSION", "");
    sandbox = await treeSandbox({
      tasks: {
        a: { created: at(1) },
        b: { created: at(2) },
        c: { created: at(3) },
      },
    });
    const contexts = await Promise.all(
      ["s1", "s2", "s3", "s4"].map((session) =>
        openContext(fakeCommand({ dir: sandbox.dir, session })),
      ),
    );

    const settled = await Promise.allSettled(
      contexts.map((context) => claimNext(context)),
    );

    const taken = settled.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value.task.id] : [],
    );
    expect([...taken].sort()).toEqual(["a", "b", "c"]);
    const refused = settled.filter((outcome) => outcome.status === "rejected");
    expect(refused).toHaveLength(1);
    const reason = (refused[0] as PromiseRejectedResult).reason as unknown;
    expect(isTaskError(reason) && reason.code).toBe("NOT_FOUND");

    const sessions = await Promise.all(
      ["a", "b", "c"].map(
        async (id) => (await frontmatterOf(sandbox, id)).claimed_session,
      ),
    );
    expect(new Set(sessions).size).toBe(3);
    for (const id of ["a", "b", "c"]) {
      expect(await logTexts(sandbox, id)).toEqual([
        "claim: TODO → IN_PROGRESS",
      ]);
    }
  });
});

describe("transitions in a listed project", () => {
  it("write under that tree and qualify the id", async () => {
    sandbox = await treeSandbox({ tasks: { local: {} } });
    const backend = await sandbox.project("backend", "../backend", {
      tasks: { x: {} },
    });
    const result = await sandbox.session("s1")("claim", "backend:x", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      id: "backend:x",
      project: "backend",
      status: "IN_PROGRESS",
      claimed_session: "s1",
      liveness: "live",
    });
    expect((await frontmatterOf(sandbox, "x", backend)).claimed_by).toBe(
      "tester",
    );
    expect(await sandbox.exists("../backend/.tasks/.locks/tree.lock")).toBe(
      false,
    );
    expect(await sandbox.exists(".tasks/local/log.md")).toBe(false);
  });

  it("cascade inside that tree, logging the tree's own ids", async () => {
    sandbox = await treeSandbox({});
    const backend = await sandbox.project("backend", "../backend", {
      tasks: { epic: {}, "epic/a": {} },
    });
    const result = await sandbox.run(
      "cancel",
      "backend:epic",
      "-m",
      "cut",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TransitionJson>()).toMatchObject({
      id: "backend:epic",
      cascaded: ["backend:epic/a"],
    });
    expect(await logTexts(sandbox, "epic/a", backend)).toEqual([
      "cancel with epic: TODO → CANCELLED\ncut",
    ]);
    expect(await logTexts(sandbox, "epic", backend)).toEqual([
      "cancel: TODO → CANCELLED\nreached: epic/a\ncut",
    ]);
  });

  it("qualify the ids in refusals", async () => {
    sandbox = await treeSandbox({});
    await sandbox.project("backend", "../backend", {
      tasks: { epic: {}, "epic/a": {} },
    });
    const result = await sandbox.run(
      "done",
      "backend:epic",
      "-m",
      "x",
      "--json",
    );
    expect(errorOf(result).details).toEqual({
      id: "backend:epic",
      kind: "finish-gate",
      open_children: ["backend:epic/a"],
      finishes_after: [],
    });
  });

  it("are judged by heartbeats the listing tree writes there", async () => {
    sandbox = await treeSandbox({});
    const backend = await sandbox.project("backend", "../backend", {
      tasks: { x: {} },
    });
    expect((await sandbox.session("s1")("claim", "backend:x")).code).toBe(0);
    await heartbeat(sandbox, "s1", 31, backend);
    // Any command of s1 from the listing tree refreshes the listed registry.
    expect(
      (await sandbox.session("s1")("priority", "backend:x", "high")).code,
    ).toBe(0);
    const result = await sandbox.session("s2")("claim", "backend:x", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      id: "backend:x",
      liveness: "live",
    });
  });

  it("fail as not found when the project is not checked out", async () => {
    sandbox = await treeSandbox({ projects: { gone: "../gone" } });
    const result = await sandbox.run("claim", "gone:x", "--json");
    expect(result.code).toBe(3);
    expect(errorOf(result).details).toEqual({
      argument: "gone:x",
      project: "gone",
      reason: "not-checked-out",
    });
  });

  it("refuse an unknown alias as usage", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("claim", "nope:a")).code).toBe(2);
  });
});
