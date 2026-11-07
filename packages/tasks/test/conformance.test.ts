import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HeartbeatJson } from "../src/commands/heartbeat.js";
import type { ShowJson } from "../src/commands/show.js";
import type { CommandContext } from "../src/context.js";
import { openContext } from "../src/context.js";
import type { MoveJson } from "../src/core/relocate.js";
import type {
  TransitionJson,
  TransitionResult,
} from "../src/core/transitions.js";
import { applyTransition, claimNext } from "../src/core/transitions.js";
import type {
  BlockedByJson,
  CollectionJson,
  SessionCheckJson,
  SessionEndJson,
  Situation,
  TaskWithDerivedJson,
  ValidationJson,
} from "../src/core/types.js";
import { SITUATIONS } from "../src/core/types.js";
import { isTaskError } from "../src/errors.js";
import type { TreeSpec } from "./fixtures.js";
import { DEFAULT_STATE, FIXTURE_TIME, writeTree } from "./fixtures.js";
import type { CliResult, Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";
import {
  endSession,
  errorOf,
  fakeCommand,
  frontmatterOf,
  heartbeat,
  lastEntry,
  lastSeen,
  logTexts,
  plain,
  refusal,
} from "./transitions-support.js";

/**
 * The specification's Conformance → Self-checking list, one test per clause,
 * each named with the clause's own words and run end to end through the CLI
 * as a user (or a harness) would run it. Only where several agents must act
 * at the same instant does a test call the engine directly, each agent with
 * a context of its own: one in-process CLI run at a time is all the sandbox
 * can do. The unit suites beside each module test the parts; this file ties
 * every clause to the behaviour it promises, and its first test ties the
 * clause names to the published text of the specification.
 */

let sandbox: Sandbox | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await sandbox?.cleanup();
  sandbox = undefined;
});

/** Minutes past the default 30-minute session timeout. */
const STALE = 31;

function day(n: number): string {
  return `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`;
}

async function box(spec: TreeSpec = {}): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

/** The JSON document of a run that succeeded. */
function success<T>(result: CliResult): T {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return result.json<T>();
}

function ids(collection: CollectionJson): string[] {
  return collection.tasks.map((task) => task.id);
}

/** What the next `tasks state` reads as its standard input. */
function feedStdin(text: string): void {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from([
      Buffer.from(text, "utf8"),
    ]) as unknown as typeof process.stdin,
  );
}

/**
 * One agent of several acting at once: a context of its own, as a process of
 * its own would open it. The environment is pinned so that no identity of
 * the machine the suite runs on leaks in.
 */
function agentContext(
  s: Sandbox,
  session: string,
  as?: string,
): Promise<CommandContext> {
  vi.stubEnv("TASKS_ACTOR", "tester");
  vi.stubEnv("TASKS_SESSION", "");
  return openContext(fakeCommand({ dir: s.dir, session, as }));
}

function settledResults(outcomes: PromiseSettledResult<TransitionResult>[]): {
  won: TransitionResult[];
  lost: unknown[];
} {
  return {
    won: outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : [])),
    lost: outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason] : [])),
  };
}

/* ------------------------------------------------------------------------ */
/* The clauses, as the specification words them                             */
/* ------------------------------------------------------------------------ */

const SPEC_PAGE = fileURLToPath(
  new URL(
    "../../../apps/docs/content/docs/spec/conformance.mdx",
    import.meta.url,
  ),
);

/** The Self-checking paragraph of the published specification, plain. */
async function selfCheckingText(): Promise<string> {
  const page = await fs.readFile(SPEC_PAGE, "utf8");
  const heading = "## Self-checking";
  const start = page.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const rest = page.slice(start + heading.length);
  const next = rest.search(/^#{1,6} /m);
  return (next === -1 ? rest : rest.slice(0, next))
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words that join the clauses in the paragraph, and nothing else. */
const GLUE = new Set([
  "Beyond",
  "v1's",
  "and",
  "a",
  "v2",
  "implementation",
  "SHOULD",
  "test",
  "that",
]);

const CLAUSES: string[] = [];

/** One test per clause of the list, named with the clause's words. */
function clause(name: string, fn: () => Promise<void>): void {
  CLAUSES.push(name);
  it(name, fn);
}

describe("Self-checking", () => {
  it("has one test named after every clause of the list, and no other", async () => {
    const text = await selfCheckingText();
    let rest = text;
    for (const name of [...CLAUSES].sort((a, b) => b.length - a.length)) {
      expect(text).toContain(name);
      rest = rest.replace(name, "|");
    }
    expect(new Set(CLAUSES).size).toBe(CLAUSES.length);
    // What is left of the paragraph only joins clauses: none goes untested.
    const leftover = rest
      .split(/[\s,;.:|]+/)
      .filter((word) => word !== "" && !GLUE.has(word));
    expect(leftover).toEqual([]);
  });

  /* ---------------------------------------------------------------------- */

  /** The manifest of the specification's Task file section, byte for byte. */
  const SPEC_EXAMPLE = [
    "---",
    "status: PAUSED",
    "priority: normal",
    "depends_on: [auth-rework/audit-claims]",
    "finishes_after: []",
    "assignee: alice",
    "claimed_by: null",
    "claimed_at: null",
    "claimed_session: null",
    'created: "2026-09-21T09:14:00Z"',
    'updated: "2026-09-21T16:40:12Z"',
    "---",
    "",
    "# Design the token schema",
    "",
    "## Description",
    "",
    "## Acceptance criteria",
    "",
    "- [ ]",
    "",
    "## Notes",
    "",
  ].join("\n");

  /** A body to carry verbatim: a rule like a delimiter, a fence, odd text. */
  const BODY = [
    "# Rotate the signing keys",
    "",
    "Keys rotate every 90 days.  ",
    "",
    "---",
    "",
    "```yaml",
    "status: DONE",
    "```",
    "",
    "## Notes",
    "",
    "- 2026-09-21, alice: keep the legacy route — «as agreed»",
    "",
  ].join("\n");

  clause("round-trip stability", async () => {
    const s = await box({
      tasks: { "auth-rework/audit-claims": {}, keys: { body: BODY } },
    });
    const example = ".tasks/auth-rework/token-schema/task.md";
    await s.write(example, SPEC_EXAMPLE);

    // Read, then written with nothing changed: the same bytes. Setting the
    // priority a task already has is such a write.
    expect(
      (await s.run("--as", "alice", "priority", "token-schema", "normal")).code,
    ).toBe(0);
    expect(await s.read(example)).toBe(SPEC_EXAMPLE);

    // Two commands that undo each other: the same bytes, `updated` aside.
    expect(
      (await s.run("--as", "alice", "unassign", "token-schema")).code,
    ).toBe(0);
    expect(await s.read(example)).not.toBe(SPEC_EXAMPLE);
    expect((await s.run("assign", "token-schema", "alice")).code).toBe(0);
    const stamp = (await frontmatterOf(s, "auth-rework/token-schema")).updated;
    expect(stamp).not.toBe("2026-09-21T16:40:12Z");
    expect(await s.read(example)).toBe(
      SPEC_EXAMPLE.replace(
        'updated: "2026-09-21T16:40:12Z"',
        `updated: "${stamp}"`,
      ),
    );

    // And the other way round, on a task whose body must travel untouched.
    const keys = ".tasks/keys/task.md";
    const original = await s.read(keys);
    expect(original).toContain(BODY);
    expect((await s.run("assign", "keys", "alice")).code).toBe(0);
    expect((await s.run("--as", "alice", "unassign", "keys")).code).toBe(0);
    const keysStamp = (await frontmatterOf(s, "keys")).updated;
    expect(await s.read(keys)).toBe(
      original.replace(`updated: "${FIXTURE_TIME}"`, `updated: "${keysStamp}"`),
    );
  });

  /* ---------------------------------------------------------------------- */

  /**
   * One tree with a task in every row of the situation table, the rows of
   * the agent protocol's Stored / Shown table among them, and the claims,
   * gates and heartbeats real: nothing is derived from overrides.
   */
  const AGREEMENT: TreeSpec = {
    tasks: {
      shipped: { status: "DONE" },
      dropped: { status: "CANCELLED", state: true },
      worked: {
        status: "IN_PROGRESS",
        claimed_by: "agent",
        claimed_session: "s-live",
        state: true,
      },
      "worked/sub": {},
      crashed: {
        status: "IN_PROGRESS",
        claimed_by: "agent",
        claimed_session: "s-gone",
        state: true,
      },
      quit: {
        status: "IN_PROGRESS",
        claimed_by: "agent",
        claimed_session: "s-quit",
        state: true,
      },
      terminal: { status: "IN_PROGRESS", claimed_by: "alice" },
      remote: {
        status: "IN_PROGRESS",
        claimed_by: "agent",
        claimed_session: "s-remote",
        state: true,
      },
      "set-aside": { status: "BACKLOG", state: true },
      unscheduled: { status: "BACKLOG" },
      shelf: { status: "BACKLOG" },
      "shelf/begun": { status: "BACKLOG", state: true },
      "shelf/fresh": { status: "BACKLOG" },
      planned: { status: "PAUSED", state: true, assignee: "alice" },
      "planned/part": {},
      "planned/grp/deep": {},
      // Beneath a holder, the rows above `held` still come first, and the
      // rows below it give way.
      "planned/working": {
        status: "IN_PROGRESS",
        claimed_by: "agent",
        claimed_session: "s-live",
        state: true,
      },
      "planned/shelved": { status: "BACKLOG", state: true },
      "planned/backlogged": { status: "BACKLOG" },
      "planned/review": { status: "PAUSED", state: true, assignee: "bob" },
      review: { status: "PAUSED", state: true, assignee: "alice" },
      "review-blocked": {
        status: "PAUSED",
        state: true,
        assignee: "alice",
        depends_on: ["free"],
      },
      deploy: { assignee: "alice" },
      "my-deploy": { assignee: "tester", created: day(2) },
      "assigned-blocked": { assignee: "alice", depends_on: ["free"] },
      waits: { depends_on: ["free"] },
      stranded: { depends_on: ["dropped"] },
      "paused-waits": { status: "PAUSED", state: true, depends_on: ["waits"] },
      "blocked-epic": { depends_on: ["free"] },
      "blocked-epic/part": { created: day(11) },
      "blocked-closable": { depends_on: ["free"] },
      "blocked-closable/a": { status: "DONE" },
      wrapped: { created: day(10) },
      "wrapped/a": { status: "DONE" },
      "wrapped/b": { status: "CANCELLED" },
      epic: {},
      "epic/a": { status: "DONE" },
      "epic/b": { status: "DONE" },
      "epic/c": {
        status: "IN_PROGRESS",
        claimed_by: "agent",
        claimed_session: "s-live",
        state: true,
      },
      "epic/d": { created: day(5) },
      "epic/e": { created: day(6) },
      hot: { priority: "high" },
      "hot/part": { created: day(8) },
      free: { created: day(3) },
      paused: { status: "PAUSED", state: true, created: day(7) },
      urgent: { priority: "urgent", created: day(9) },
      later: { priority: "low", created: day(1) },
    },
  };

  clause(
    "cross-implementation agreement on the ready set and on situations",
    async () => {
      const s = await box(AGREEMENT);
      await heartbeat(s, "s-live");
      await heartbeat(s, "s-gone", STALE);
      await endSession(s, "s-quit");
      const live = await lastSeen(s, "s-live");
      const gone = await lastSeen(s, "s-gone");
      const quit = await lastSeen(s, "s-quit");

      // Hand-computed from the specification's tables for the actor tester:
      // the first row of the situation table that holds, and the derived
      // conditions the task object carries.
      const none = { open: 0, resolved: 0 };
      const base: Partial<TaskWithDerivedJson> = {
        blocked_by: [],
        held_by: null,
        waiting_for: null,
        effective_priority: "normal",
        children: none,
        active: false,
        closable: false,
        ready: false,
        started: false,
        liveness: null,
        last_seen: null,
      };
      const notDone = (ref: string): BlockedByJson[] => [
        { ref, reason: "not-done", status: "TODO" },
      ];
      const expected: Record<string, Partial<TaskWithDerivedJson>> = {
        shipped: { situation: "done" },
        dropped: { situation: "cancelled", started: true },
        worked: {
          situation: "working",
          liveness: "live",
          last_seen: live,
          children: { open: 1, resolved: 0 },
          started: true,
        },
        "worked/sub": { situation: "held", held_by: "worked" },
        crashed: {
          situation: "working",
          liveness: "orphaned",
          last_seen: gone,
          started: true,
        },
        quit: {
          situation: "working",
          liveness: "orphaned",
          last_seen: quit,
          started: true,
        },
        terminal: { situation: "working", liveness: "unknown" },
        remote: { situation: "working", liveness: "unknown", started: true },
        "set-aside": { situation: "parked", started: true },
        unscheduled: { situation: "backlog" },
        shelf: {
          situation: "parked",
          started: true,
          children: { open: 2, resolved: 0 },
        },
        "shelf/begun": { situation: "parked", started: true },
        "shelf/fresh": { situation: "backlog" },
        planned: {
          situation: "waiting",
          waiting_for: "alice",
          started: true,
          active: true,
          children: { open: 6, resolved: 0 },
        },
        "planned/part": { situation: "held", held_by: "planned" },
        "planned/grp/deep": { situation: "held", held_by: "planned" },
        "planned/working": {
          situation: "working",
          held_by: "planned",
          liveness: "live",
          last_seen: live,
          started: true,
        },
        "planned/shelved": {
          situation: "parked",
          held_by: "planned",
          started: true,
        },
        "planned/backlogged": { situation: "backlog", held_by: "planned" },
        "planned/review": {
          situation: "held",
          held_by: "planned",
          waiting_for: "bob",
          started: true,
        },
        review: { situation: "waiting", waiting_for: "alice", started: true },
        "review-blocked": {
          situation: "waiting",
          waiting_for: "alice",
          started: true,
          blocked_by: notDone("free"),
        },
        deploy: { situation: "assigned", assignee: "alice" },
        "my-deploy": { situation: "assigned", assignee: "tester", ready: true },
        "assigned-blocked": {
          situation: "assigned",
          assignee: "alice",
          blocked_by: notDone("free"),
        },
        waits: { situation: "blocked", blocked_by: notDone("free") },
        stranded: {
          situation: "blocked",
          blocked_by: [
            { ref: "dropped", reason: "cancelled", status: "CANCELLED" },
          ],
        },
        "paused-waits": {
          situation: "blocked",
          blocked_by: notDone("waits"),
          started: true,
        },
        "blocked-epic": {
          situation: "blocked",
          blocked_by: notDone("free"),
          children: { open: 1, resolved: 0 },
        },
        "blocked-epic/part": { situation: "ready", ready: true },
        "blocked-closable": {
          situation: "blocked",
          blocked_by: notDone("free"),
          closable: true,
          children: { open: 0, resolved: 1 },
        },
        "blocked-closable/a": { situation: "done" },
        wrapped: {
          situation: "closable",
          closable: true,
          children: { open: 0, resolved: 2 },
          ready: true,
        },
        "wrapped/a": { situation: "done" },
        "wrapped/b": { situation: "cancelled" },
        epic: {
          situation: "open",
          children: { open: 3, resolved: 2 },
          active: true,
          started: true,
        },
        "epic/a": { situation: "done" },
        "epic/b": { situation: "done" },
        "epic/c": {
          situation: "working",
          liveness: "live",
          last_seen: live,
          started: true,
        },
        "epic/d": { situation: "ready", ready: true },
        "epic/e": { situation: "ready", ready: true },
        hot: {
          situation: "open",
          children: { open: 1, resolved: 0 },
          effective_priority: "high",
        },
        "hot/part": {
          situation: "ready",
          priority: "normal",
          effective_priority: "high",
          ready: true,
        },
        free: { situation: "ready", ready: true },
        paused: { situation: "ready", ready: true, started: true },
        urgent: {
          situation: "ready",
          effective_priority: "urgent",
          ready: true,
        },
        later: { situation: "ready", effective_priority: "low", ready: true },
      };
      // Effective priority first, PAUSED before TODO, then oldest first.
      const readyOrder = [
        "urgent",
        "hot/part",
        "paused",
        "my-deploy",
        "free",
        "epic/d",
        "epic/e",
        "wrapped",
        "blocked-epic/part",
        "later",
      ];

      const all = success<CollectionJson>(
        await s.run("tree", "--resolved", "--json"),
      );
      expect(all.count).toBe(all.tasks.length);
      expect([...ids(all)].sort()).toEqual(Object.keys(expected).sort());
      for (const task of all.tasks) {
        // The received object carries its id, so a failure names the task.
        expect(task).toMatchObject({ ...base, ...expected[task.id] });
      }

      const ready = success<CollectionJson>(await s.run("ready", "--json"));
      expect(ids(ready)).toEqual(readyOrder);
      expect(ready.count).toBe(readyOrder.length);

      // Every situation filter selects exactly its row.
      for (const word of SITUATIONS) {
        const rows = success<CollectionJson>(
          await s.run("list", `--${word}`, "--json"),
        );
        const want = Object.entries(expected)
          .filter(([, task]) => task.situation === word)
          .map(([id]) => id);
        expect({ word, ids: [...ids(rows)].sort() }).toEqual({
          word,
          ids: want.sort(),
        });
      }

      // A person reads the same words, with the object of each situation
      // and the secondary labels the specification requires.
      const human = await s.run(
        "list",
        ...SITUATIONS.map((word) => `--${word}`),
      );
      expect(human.code).toBe(0);
      const lines = plain(human.stdout).split("\n");
      const lineOf = (id: string): string => {
        // Ids are segments and slashes: nothing in them a pattern reads.
        const pattern = new RegExp(`^\\s*${id}\\s`);
        const found = lines.filter((line) => pattern.test(line));
        expect({ id, rows: found.length }).toEqual({ id, rows: 1 });
        return found[0]!;
      };
      const words: Record<string, string> = {
        "worked/sub": "held by worked",
        "planned/part": "held by planned",
        "planned/grp/deep": "held by planned",
        "planned/review": "held by planned",
        planned: "waiting for alice",
        review: "waiting for alice",
        "review-blocked": "waiting for alice",
        deploy: "assigned alice",
        "my-deploy": "assigned tester",
        "assigned-blocked": "assigned alice",
        waits: "blocked by free",
        stranded: "blocked by dropped (cancelled)",
        "paused-waits": "blocked by waits",
        "blocked-epic": "blocked by free",
        "blocked-closable": "blocked by free",
        epic: "open 2/5",
        hot: "open 0/1",
      };
      const labels: Record<string, string[]> = {
        worked: ["live"],
        "epic/c": ["live"],
        crashed: [`orphaned since ${gone}`],
        quit: [`orphaned since ${quit}`],
        remote: ["unknown"],
        paused: ["started"],
        "paused-waits": ["started"],
        "review-blocked": ["blocked by free"],
        "assigned-blocked": ["blocked by free"],
        "planned/working": ["live", "held by planned"],
        "planned/review": ["bob"],
        "blocked-closable": ["closable"],
        planned: ["active"],
        epic: ["active"],
        hot: ["high"],
        "hot/part": ["high"],
        urgent: ["urgent"],
        later: ["low"],
      };
      for (const [id, task] of Object.entries(expected)) {
        const line = lineOf(id);
        expect({ id, line }).toEqual({
          id,
          line: expect.stringContaining(
            words[id] ?? (task.situation as Situation),
          ),
        });
        for (const label of labels[id] ?? []) {
          expect({ id, line }).toEqual({
            id,
            line: expect.stringContaining(label),
          });
        }
      }
      // A claim without a session carries no liveness label.
      expect(lineOf("terminal")).not.toMatch(/live|orphaned|unknown/);
    },
  );

  /* ---------------------------------------------------------------------- */

  clause("fail-safe under damaged references", async () => {
    const s = await box({
      tasks: {
        "on-broken": { depends_on: ["broken"] },
        "on-missing": { depends_on: ["nowhere"] },
        "on-archived": { depends_on: ["old"] },
        "on-garbage": { depends_on: ["Not A Ref"] },
        "joins-missing": { finishes_after: ["nowhere"], created: day(2) },
        fine: { created: day(1) },
      },
      archived: { old: { status: "DONE" } },
    });
    await s.write(".tasks/broken/task.md", "no frontmatter here\n");
    // The reason each dependent is blocked with; a reference that does not
    // parse is reported as missing, as the specification recommends.
    const damaged: Record<string, string> = {
      "on-broken": "malformed",
      "on-missing": "missing",
      "on-archived": "archived",
      "on-garbage": "missing",
    };

    // A query that spans the damage completes and names what it could not
    // read instead of skipping it.
    const listed = success<CollectionJson>(await s.run("list", "--json"));
    expect(listed.malformed).toEqual([
      {
        path: path.join(s.tasksDir, "broken", "task.md"),
        message: expect.any(String),
      },
    ]);
    expect(ids(listed)).toEqual(expect.arrayContaining(Object.keys(damaged)));

    // Never ready: a gate is satisfied only on positive evidence.
    expect(
      ids(success<CollectionJson>(await s.run("ready", "--json"))),
    ).toEqual(["fine", "joins-missing"]);

    for (const [id, reason] of Object.entries(damaged)) {
      const shown = success<ShowJson>(await s.run("show", id, "--json"));
      expect(shown).toMatchObject({
        id,
        situation: "blocked",
        ready: false,
        blocked_by: [{ reason }],
      });
      for (const argv of [
        ["claim", id],
        ["done", id, "-m", "finished elsewhere"],
      ]) {
        const refused = await s.run(...argv, "--json");
        expect({ argv, ...refusal(refused) }).toEqual({
          argv,
          code: 4,
          error: "CONFLICT",
          kind: "start-gate",
        });
        expect(errorOf(refused).details).toMatchObject({
          blocked_by: [{ reason }],
        });
      }
      expect((await frontmatterOf(s, id)).status).toBe("TODO");
    }

    // A finish-gate reference that cannot be resolved blocks done as well.
    const join = await s.run("done", "joins-missing", "-m", "x", "--json");
    expect(refusal(join)).toEqual({
      code: 4,
      error: "CONFLICT",
      kind: "finish-gate",
    });
    expect(errorOf(join).details).toMatchObject({
      finishes_after: [{ ref: "nowhere", reason: "missing" }],
    });

    // claim --next takes what is ready and nothing else.
    for (const id of ["fine", "joins-missing"]) {
      expect(
        success<TransitionJson>(await s.run("claim", "--next", "--json")).id,
      ).toBe(id);
    }
    expect(refusal(await s.run("claim", "--next", "--json"))).toMatchObject({
      code: 3,
      error: "NOT_FOUND",
    });

    // validate reports every kind of damage.
    const validation = await s.run("validate", "--json");
    expect(validation.code).toBe(4);
    const result = validation.json<ValidationJson>();
    expect(result.ok).toBe(false);
    expect(
      result.findings.map(({ severity, kind, task }) => ({
        severity,
        kind,
        task,
      })),
    ).toEqual(
      expect.arrayContaining([
        { severity: "error", kind: "malformed", task: "broken" },
        { severity: "error", kind: "malformed-ref", task: "on-garbage" },
        { severity: "warning", kind: "unsatisfiable-ref", task: "on-missing" },
        { severity: "warning", kind: "unsatisfiable-ref", task: "on-archived" },
      ]),
    );
  });

  /* ---------------------------------------------------------------------- */

  clause("concurrent-claim exclusivity", async () => {
    const s = await box({
      tasks: {
        a: { created: day(1) },
        b: { created: day(2) },
        contested: { created: day(3) },
      },
    });

    // Four sessions claim one task at the same instant: one gets it.
    const four = await Promise.all(
      ["s1", "s2", "s3", "s4"].map((session) => agentContext(s, session)),
    );
    const { won, lost } = settledResults(
      await Promise.allSettled(
        four.map((context) =>
          applyTransition(context, { command: "claim", task: "contested" }),
        ),
      ),
    );
    expect(won).toHaveLength(1);
    const winner = won[0]!.task.claimed_session;
    expect(lost).toHaveLength(3);
    for (const reason of lost) {
      expect(isTaskError(reason) && reason.code).toBe("CONFLICT");
      expect(isTaskError(reason) && reason.details).toMatchObject({
        id: "contested",
        kind: "authorization",
        claimed_session: winner,
        liveness: "live",
      });
    }
    expect(await frontmatterOf(s, "contested")).toMatchObject({
      status: "IN_PROGRESS",
      claimed_session: winner,
    });
    expect(await logTexts(s, "contested")).toEqual([
      "claim: TODO → IN_PROGRESS",
    ]);

    // Two sessions take the next task at the same instant: two tasks.
    const two = await Promise.all(
      ["s5", "s6"].map((session) => agentContext(s, session)),
    );
    const taken = await Promise.all(two.map((context) => claimNext(context)));
    expect(taken.map((result) => result.task.id).sort()).toEqual(["a", "b"]);
    expect(taken.map((result) => result.task.claimed_session)).toEqual([
      "s5",
      "s6",
    ]);
    for (const id of ["a", "b"]) {
      expect(await logTexts(s, id)).toEqual(["claim: TODO → IN_PROGRESS"]);
    }
  });

  /* ---------------------------------------------------------------------- */

  clause(
    "done on a parent with an open child is refused and succeeds once the child is resolved",
    async () => {
      const s = await box({
        tasks: {
          epic: {},
          "epic/part": {},
          "epic/dropped": { status: "CANCELLED" },
        },
      });

      const refused = await s.run("done", "epic", "-m", "all in", "--json");
      expect(refused.code).toBe(4);
      expect(errorOf(refused).details).toEqual({
        id: "epic",
        kind: "finish-gate",
        open_children: ["epic/part"],
        finishes_after: [],
      });
      expect((await frontmatterOf(s, "epic")).status).toBe("TODO");
      expect(await s.exists(".tasks/epic/log.md")).toBe(false);

      expect((await s.run("done", "epic/part", "-m", "built")).code).toBe(0);
      expect(
        success<ShowJson>(await s.run("show", "epic", "--json")),
      ).toMatchObject({
        situation: "closable",
        closable: true,
        children: { open: 0, resolved: 2 },
      });

      const done = success<TransitionJson>(
        await s.run("done", "epic", "-m", "all in", "--json"),
      );
      expect(done).toMatchObject({ status: "DONE", situation: "done" });
      expect(await logTexts(s, "epic")).toEqual(["done: TODO → DONE\nall in"]);
    },
  );

  clause("cancel on a parent cancels its open children", async () => {
    const s = await box({
      tasks: {
        epic: {},
        "epic/todo": {},
        "epic/paused": { status: "PAUSED", state: true },
        "epic/later": { status: "BACKLOG" },
        "epic/grp/deep": {},
        "epic/shipped": { status: "DONE" },
      },
    });
    const s1 = s.session("s1");
    // The caller's own claim: the cascade reaches it, and clears it.
    expect((await s1("claim", "epic/todo")).code).toBe(0);

    const result = success<TransitionJson>(
      await s1("cancel", "epic", "-m", "scope cut", "--json"),
    );
    expect(result).toMatchObject({
      status: "CANCELLED",
      situation: "cancelled",
    });
    const reached = ["epic/grp/deep", "epic/later", "epic/paused", "epic/todo"];
    expect([...(result.cascaded ?? [])].sort()).toEqual(reached);

    const from: Record<string, string> = {
      "epic/grp/deep": "TODO",
      "epic/later": "BACKLOG",
      "epic/paused": "PAUSED",
      "epic/todo": "IN_PROGRESS",
    };
    for (const id of reached) {
      expect(await frontmatterOf(s, id)).toMatchObject({
        status: "CANCELLED",
        claimed_by: null,
        claimed_at: null,
        claimed_session: null,
      });
      expect((await lastEntry(s, id)).text).toBe(
        `cancel with epic: ${from[id]} → CANCELLED\nscope cut`,
      );
    }
    // A resolved child keeps its own decision, and no state.md is lost.
    expect((await frontmatterOf(s, "epic/shipped")).status).toBe("DONE");
    expect(await s.exists(".tasks/epic/shipped/log.md")).toBe(false);
    expect(await s.read(".tasks/epic/paused/state.md")).toBe(DEFAULT_STATE);
    // The parent's entry names the cascade's reach.
    const entry = (await lastEntry(s, "epic")).text;
    expect(entry.split("\n")[0]).toBe("cancel: TODO → CANCELLED");
    for (const id of reached) expect(entry).toContain(id);
    expect(entry.endsWith("\nscope cut")).toBe(true);
  });

  clause("defer parks them", async () => {
    const s = await box({
      tasks: {
        epic: { status: "PAUSED", state: true },
        "epic/begun": { status: "PAUSED", state: true, assignee: "alice" },
        "epic/fresh": {},
        "epic/grp/deep": { status: "PAUSED", state: true },
        "epic/shipped": { status: "DONE" },
      },
    });

    const result = success<TransitionJson>(
      await s.run("defer", "epic", "-m", "after the release", "--json"),
    );
    expect(result).toMatchObject({ status: "BACKLOG", situation: "parked" });
    expect([...(result.cascaded ?? [])].sort()).toEqual([
      "epic/begun",
      "epic/fresh",
      "epic/grp/deep",
    ]);

    const tree = success<CollectionJson>(
      await s.run("tree", "--resolved", "--json"),
    );
    const byId = new Map(tree.tasks.map((task) => [task.id, task]));
    // Unscheduled, every one; the begun ones read as parked, their resume
    // point and their assignee kept for the day they come back.
    expect(byId.get("epic/begun")).toMatchObject({
      status: "BACKLOG",
      situation: "parked",
      assignee: "alice",
    });
    expect(byId.get("epic/grp/deep")).toMatchObject({
      status: "BACKLOG",
      situation: "parked",
    });
    expect(byId.get("epic/fresh")).toMatchObject({
      status: "BACKLOG",
      situation: "backlog",
    });
    expect(byId.get("epic/shipped")).toMatchObject({ status: "DONE" });
    for (const id of ["epic", "epic/begun", "epic/grp/deep"]) {
      expect(await s.read(`.tasks/${id}/state.md`)).toBe(DEFAULT_STATE);
    }
    expect(await logTexts(s, "epic/begun")).toEqual([
      "defer with epic: PAUSED → BACKLOG\nafter the release",
    ]);

    // In nobody's queue, and found by list --parked.
    expect(
      ids(success<CollectionJson>(await s.run("ready", "--json"))),
    ).toEqual([]);
    expect(
      ids(success<CollectionJson>(await s.run("list", "--parked", "--json"))),
    ).toEqual(["epic", "epic/begun", "epic/grp/deep"]);
  });

  clause(
    "schedule brings them back to PAUSED where a state.md exists",
    async () => {
      const s = await box({
        tasks: {
          epic: { status: "BACKLOG", state: true },
          "epic/begun": { status: "BACKLOG", state: true, created: day(2) },
          "epic/fresh": { status: "BACKLOG", created: day(1) },
          "epic/shipped": { status: "DONE" },
        },
      });

      const result = success<TransitionJson>(
        await s.run("schedule", "epic", "--json"),
      );
      expect(result).toMatchObject({ status: "PAUSED" });
      expect([...(result.cascaded ?? [])].sort()).toEqual([
        "epic/begun",
        "epic/fresh",
      ]);
      expect((await frontmatterOf(s, "epic/begun")).status).toBe("PAUSED");
      expect((await frontmatterOf(s, "epic/fresh")).status).toBe("TODO");
      expect((await frontmatterOf(s, "epic/shipped")).status).toBe("DONE");
      expect(await logTexts(s, "epic/begun")).toEqual([
        "schedule with epic: BACKLOG → PAUSED",
      ]);
      expect(await logTexts(s, "epic/fresh")).toEqual([
        "schedule with epic: BACKLOG → TODO",
      ]);
      expect(await s.read(".tasks/epic/begun/state.md")).toBe(DEFAULT_STATE);

      // Started work comes first: finishing beats starting.
      expect(
        ids(success<CollectionJson>(await s.run("ready", "--json"))),
      ).toEqual(["epic/begun", "epic/fresh"]);
    },
  );

  clause(
    "a cascade over a live claim is refused and one over an orphaned claim supersedes it",
    async () => {
      const s = await box({
        tasks: {
          epic: {},
          "epic/worked": {
            status: "IN_PROGRESS",
            claimed_by: "agent",
            claimed_session: "s1",
            state: true,
          },
          "epic/todo": {},
        },
      });
      await heartbeat(s, "s1");
      const before = await s.read(".tasks/epic/todo/task.md");

      const refused = await s.run("cancel", "epic", "-m", "cut", "--json");
      expect(refused.code).toBe(4);
      expect(errorOf(refused).details).toEqual({
        id: "epic",
        kind: "cascade-claim",
        claims: [
          {
            id: "epic/worked",
            claimant: "agent",
            session: "s1",
            liveness: "live",
          },
        ],
      });
      // Refused as a whole: not even the free child was written.
      expect(await s.read(".tasks/epic/todo/task.md")).toBe(before);
      expect(await s.exists(".tasks/epic/log.md")).toBe(false);

      // The session goes quiet past the timeout: its claim protects nothing.
      await s.age(".tasks/.locks/sessions/s1", STALE);
      const seen = await lastSeen(s, "s1");
      const result = success<TransitionJson>(
        await s.run("cancel", "epic", "-m", "cut", "--json"),
      );
      expect([...(result.cascaded ?? [])].sort()).toEqual([
        "epic/todo",
        "epic/worked",
      ]);
      expect(await frontmatterOf(s, "epic/worked")).toMatchObject({
        status: "CANCELLED",
        claimed_by: null,
        claimed_at: null,
        claimed_session: null,
      });
      // Recorded as a takeover would be: which session, last seen when.
      const [first, ...rest] = (await lastEntry(s, "epic/worked")).text.split(
        "\n",
      );
      expect(first).toBe("cancel with epic: IN_PROGRESS → CANCELLED");
      expect(rest.join("\n")).toContain("s:s1");
      expect(rest.join("\n")).toContain(seen);

      // The superseded session finds out at its next command.
      const late = await s.run(
        "--as",
        "agent",
        "pause",
        "epic/worked",
        "-m",
        "my half",
        "--session",
        "s1",
        "--json",
      );
      expect(refusal(late)).toMatchObject({ code: 4, error: "CONFLICT" });
    },
  );

  clause(
    "a pause without state.md and a release with one are refused",
    async () => {
      const s = await box({
        tasks: {
          bare: { status: "IN_PROGRESS", claimed_session: "s1" },
          worked: { status: "IN_PROGRESS", claimed_session: "s1", state: true },
        },
      });
      const s1 = s.session("s1");
      const manifests = async () => [
        await s.read(".tasks/bare/task.md"),
        await s.read(".tasks/worked/task.md"),
      ];
      const before = await manifests();

      // Nothing overrides the state.md rules, --force included.
      for (const force of [[], ["--force"]]) {
        const pause = await s1(
          "pause",
          "bare",
          "-m",
          "stop",
          ...force,
          "--json",
        );
        expect(refusal(pause)).toEqual({
          code: 4,
          error: "CONFLICT",
          kind: "missing-state",
        });
        expect(errorOf(pause).message).toContain("state.md");
        const release = await s1("release", "worked", ...force, "--json");
        expect(refusal(release)).toEqual({
          code: 4,
          error: "CONFLICT",
          kind: "present-state",
        });
      }
      expect(await manifests()).toEqual(before);
      expect(await s.exists(".tasks/bare/log.md")).toBe(false);
      expect(await s.exists(".tasks/worked/log.md")).toBe(false);

      // The remedies: a resume point makes the pause legal, and work that
      // produced something is paused rather than released.
      feedStdin("## Done\n\nThe parser.\n\n## Next\n\nThe serializer.\n");
      expect((await s1("state", "bare")).code).toBe(0);
      for (const id of ["bare", "worked"]) {
        expect(
          success<TransitionJson>(
            await s1("pause", id, "-m", "stop", "--json"),
          ),
        ).toMatchObject({ status: "PAUSED", claimed_by: null });
      }
    },
  );

  clause(
    "a takeover succeeds only on an orphaned claim and the superseded session's next transition conflicts",
    async () => {
      const s = await box({
        tasks: {
          a: { state: true },
          // Unknown liveness: a claim without a session, and a session whose
          // heartbeat never reached this tree.
          unknown: { status: "IN_PROGRESS", claimed_by: "alice" },
          remote: {
            status: "IN_PROGRESS",
            claimed_by: "alice",
            claimed_session: "elsewhere",
          },
        },
      });
      const s1 = s.session("s1");
      const s2 = s.session("s2");
      expect((await s1("claim", "a")).code).toBe(0);

      const live = await s2("claim", "a", "--json");
      expect(refusal(live)).toEqual({
        code: 4,
        error: "CONFLICT",
        kind: "authorization",
      });
      expect(errorOf(live).details).toMatchObject({
        claimed_session: "s1",
        liveness: "live",
      });
      for (const id of ["unknown", "remote"]) {
        const refused = await s2("claim", id, "--json");
        expect(refusal(refused)).toEqual({
          code: 4,
          error: "CONFLICT",
          kind: "authorization",
        });
        expect(errorOf(refused).details).toMatchObject({ liveness: "unknown" });
      }

      await s.age(".tasks/.locks/sessions/s1", STALE);
      const seen = await lastSeen(s, "s1");
      const taken = success<TransitionJson>(await s2("claim", "a", "--json"));
      expect(taken).toMatchObject({
        status: "IN_PROGRESS",
        claimed_by: "tester",
        claimed_session: "s2",
        liveness: "live",
      });
      const entry = await lastEntry(s, "a");
      expect(entry.session).toBe("s2");
      const [first, ...rest] = entry.text.split("\n");
      expect(first).toBe("claim: IN_PROGRESS → IN_PROGRESS");
      expect(rest.join("\n")).toContain("s:s1");
      expect(rest.join("\n")).toContain(seen);

      const late = await s1("pause", "a", "-m", "my half", "--json");
      expect(refusal(late)).toEqual({
        code: 4,
        error: "CONFLICT",
        kind: "authorization",
      });
      expect(errorOf(late).details).toMatchObject({
        claimed_session: "s2",
        liveness: "live",
      });
      expect(await frontmatterOf(s, "a")).toMatchObject({
        status: "IN_PROGRESS",
        claimed_session: "s2",
      });
    },
  );

  clause(
    "session-check passes for a claim taken from PAUSED without a new write and fails for one taken from TODO",
    async () => {
      const s = await box({
        tasks: { resumed: { status: "PAUSED", state: true }, fresh: {} },
      });
      // Written by an earlier session, an hour ago.
      await s.age(".tasks/resumed/state.md", 60);
      const resumePoint = await s.read(".tasks/resumed/state.md");

      const s1 = s.session("s1");
      expect((await s1("claim", "resumed")).code).toBe(0);
      const passed = success<SessionCheckJson>(
        await s1("session-check", "--json"),
      );
      expect(passed).toMatchObject({ ok: true, session: "s1", violations: [] });
      // The age of the resume point is advice, never a violation.
      expect(passed.warnings.map((warning) => warning.kind)).toContain(
        "state-older-than-claim",
      );
      expect(await s.read(".tasks/resumed/state.md")).toBe(resumePoint);

      const s2 = s.session("s2");
      expect((await s2("claim", "fresh")).code).toBe(0);
      const failed = await s2("session-check", "--json");
      expect(failed.code).toBe(4);
      expect(failed.json<SessionCheckJson>()).toMatchObject({
        ok: false,
        session: "s2",
        violations: [{ id: "fresh", kind: "missing-state" }],
      });

      // A resume point written through the fence settles it.
      feedStdin("## Done\n\n## Next\n\nWire the flag.\n");
      expect((await s2("state", "fresh")).code).toBe(0);
      expect(
        success<SessionCheckJson>(await s2("session-check", "--json")),
      ).toMatchObject({ ok: true, violations: [] });
    },
  );

  clause(
    "session-end makes a fresh claim orphaned and a takeover of it succeeds at once",
    async () => {
      const s = await box({ tasks: { a: {} } });
      const s1 = s.session("s1");
      expect((await s1("claim", "a")).code).toBe(0);
      expect(
        success<ShowJson>(await s.run("show", "a", "--json")).liveness,
      ).toBe("live");

      const ended = success<SessionEndJson>(await s1("session-end", "--json"));
      expect(ended).toMatchObject({ session: "s1", claims: ["a"] });
      expect(ended.ended).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(
        success<ShowJson>(await s.run("show", "a", "--json")).liveness,
      ).toBe("orphaned");

      // No waiting for the timeout.
      const taken = success<TransitionJson>(
        await s.session("s2")("claim", "a", "--json"),
      );
      expect(taken).toMatchObject({ claimed_session: "s2", liveness: "live" });
      const [first, ...rest] = (await lastEntry(s, "a")).text.split("\n");
      expect(first).toBe("claim: IN_PROGRESS → IN_PROGRESS");
      expect(rest.join("\n")).toContain("s:s1");
    },
  );

  clause(
    "a parent with an open child and a child of a BACKLOG epic are both absent from ready",
    async () => {
      const s = await box({
        tasks: {
          epic: {},
          "epic/part": {},
          shelf: { status: "BACKLOG" },
          "shelf/part": { status: "BACKLOG" },
          // Edited by hand past the BACKLOG invariant: still never offered.
          broken: { status: "BACKLOG" },
          "broken/part": {},
        },
      });
      const ready = async () =>
        ids(success<CollectionJson>(await s.run("ready", "--json")));

      expect(await ready()).toEqual(["epic/part"]);
      for (const id of ["epic", "shelf/part", "broken/part"]) {
        expect(success<ShowJson>(await s.run("show", id, "--json")).ready).toBe(
          false,
        );
      }
      for (const id of ["shelf/part", "broken/part"]) {
        expect(refusal(await s.run("claim", id, "--json"))).toEqual({
          code: 4,
          error: "CONFLICT",
          kind: "backlog-ancestor",
        });
      }

      // The parent comes up by itself once its child is resolved.
      expect((await s.run("done", "epic/part", "-m", "built")).code).toBe(0);
      expect(await ready()).toEqual(["epic"]);
    },
  );

  clause(
    "a child of a claimed or assigned ancestor is absent from ready and its claim is refused",
    async () => {
      const s = await box({
        tasks: {
          drafting: {
            status: "IN_PROGRESS",
            claimed_by: "agent",
            claimed_session: "s1",
            state: true,
          },
          "drafting/step": {},
          planned: { status: "PAUSED", state: true, assignee: "alice" },
          "planned/grp/part": {},
          free: {},
        },
      });
      await heartbeat(s, "s1");
      const ready = async () =>
        ids(success<CollectionJson>(await s.run("ready", "--json")));

      expect(await ready()).toEqual(["free"]);
      for (const [id, ancestor] of [
        ["drafting/step", "drafting"],
        ["planned/grp/part", "planned"],
      ] as const) {
        const refused = await s.run("claim", id, "--json");
        expect(refusal(refused)).toEqual({
          code: 4,
          error: "CONFLICT",
          kind: "held",
        });
        expect(errorOf(refused).details).toMatchObject({ id, ancestor });
        expect((await frontmatterOf(s, id)).status).toBe("TODO");
      }

      // The approver's unassign releases the hold.
      expect(
        (await s.run("--as", "alice", "unassign", "planned", "-m", "APPLY"))
          .code,
      ).toBe(0);
      expect([...(await ready())].sort()).toEqual(["free", "planned/grp/part"]);
      expect(
        success<TransitionJson>(
          await s.run("claim", "planned/grp/part", "--json"),
        ).status,
      ).toBe("IN_PROGRESS");
    },
  );

  clause(
    "claim --next under contention hands every agent a different task",
    async () => {
      const s = await box({
        tasks: {
          a: { created: day(1) },
          b: { created: day(2) },
          c: { created: day(3) },
          blocked: { depends_on: ["a"] },
          held: { assignee: "alice" },
          "held/part": {},
          later: { status: "BACKLOG" },
        },
      });
      await s.project("backend", "../backend", {
        tasks: { x: { created: day(4) }, y: { created: day(5) } },
      });
      const agents = ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"];
      const contexts = await Promise.all(
        agents.map((agent, index) => agentContext(s, `s${index + 1}`, agent)),
      );

      const results = await Promise.all(
        contexts.map((context) => claimNext(context)),
      );
      expect(results.map((result) => result.task.id).sort()).toEqual([
        "a",
        "b",
        "backend:x",
        "backend:y",
        "c",
      ]);
      results.forEach((result, index) => {
        expect(result.task).toMatchObject({
          status: "IN_PROGRESS",
          claimed_by: agents[index],
          claimed_session: `s${index + 1}`,
        });
      });

      // Nothing is left for a sixth.
      expect(
        refusal(await s.run("--as", "agent-6", "claim", "--next", "--json")),
      ).toMatchObject({ code: 3, error: "NOT_FOUND" });
    },
  );

  clause("a state write by a superseded session is refused", async () => {
    const s = await box({ tasks: { a: {} } });
    const s1 = s.session("s1");
    const s2 = s.session("s2");
    expect((await s1("claim", "a")).code).toBe(0);
    feedStdin("## Done\n\nThe first half.\n");
    expect((await s1("state", "a")).code).toBe(0);

    await s.age(".tasks/.locks/sessions/s1", STALE);
    expect((await s2("claim", "a")).code).toBe(0);
    const theirs = "## Done\n\nThe first half, checked.\n";
    feedStdin(theirs);
    expect((await s2("state", "a")).code).toBe(0);

    feedStdin("## Done\n\nA stale overwrite.\n");
    const late = await s1("state", "a", "--json");
    expect(late.code).toBe(4);
    expect(errorOf(late)).toMatchObject({
      code: "CONFLICT",
      details: { id: "a", claimed_session: "s2", liveness: "live" },
    });
    expect(await s.read(".tasks/a/state.md")).toBe(theirs);

    // The takeover lands while the claimant's own write is under way, after
    // any check made before the lock: the fence inside the lock refuses it.
    const s3 = s.session("s3");
    expect((await s.session("s2")("session-end")).code).toBe(0);
    expect((await s3("claim", "a")).code).toBe(0);
    async function* takenOverMeanwhile(): AsyncGenerator<Buffer> {
      await s.age(".tasks/.locks/sessions/s3", STALE);
      const s4 = await openContext(fakeCommand({ dir: s.dir, session: "s4" }));
      await applyTransition(s4, { command: "claim", task: "a" });
      yield Buffer.from("## Done\n\nWritten over a takeover.\n", "utf8");
    }
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      Readable.from(takenOverMeanwhile()) as unknown as typeof process.stdin,
    );
    const raced = await s3("state", "a", "--json");
    expect(raced.code).toBe(4);
    expect(errorOf(raced)).toMatchObject({
      code: "CONFLICT",
      details: { id: "a", claimed_session: "s4" },
    });
    expect(await s.read(".tasks/a/state.md")).toBe(theirs);
    expect((await frontmatterOf(s, "a")).claimed_session).toBe("s4");
  });

  clause(
    "a heartbeat written in a listing tree keeps a claim in a listed tree live",
    async () => {
      const s = await box({});
      const backend = await s.project("backend", "../backend", {
        tasks: { x: {} },
      });
      expect((await s.session("s1")("claim", "backend:x")).code).toBe(0);

      // Judged by the registry of the tree that holds the task.
      await s.age("../backend/.tasks/.locks/sessions/s1", STALE);
      const show = async () =>
        success<ShowJson>(await s.run("show", "backend:x", "--json"));
      expect(await show()).toMatchObject({
        id: "backend:x",
        liveness: "orphaned",
      });

      const beat = success<HeartbeatJson>(
        await s.run("heartbeat", "--session", "s1", "--json"),
      );
      expect(beat.touched).toEqual([s.tasksDir, path.join(backend, ".tasks")]);
      expect(await show()).toMatchObject({ id: "backend:x", liveness: "live" });
      expect(
        refusal(await s.session("s2")("claim", "backend:x", "--json")),
      ).toEqual({ code: 4, error: "CONFLICT", kind: "authorization" });
    },
  );

  clause("cancel lists the dependents it stranded", async () => {
    const s = await box({
      tasks: {
        epic: {},
        "epic/api": {},
        "uses-epic": { depends_on: ["epic"] },
        "uses-api": { depends_on: ["epic/api"] },
        // A join is not a dependency: cancel neither waits for it nor
        // strands it.
        "joins-epic": { finishes_after: ["epic"] },
        unrelated: {},
      },
    });
    await s.project("backend", "../backend", {
      tasks: { client: { depends_on: ["../repo:epic/api"] }, other: {} },
    });

    const result = success<TransitionJson>(
      await s.run("cancel", "epic", "-m", "dropped upstream", "--json"),
    );
    expect(result.cascaded).toEqual(["epic/api"]);
    expect([...(result.dependents ?? [])].sort()).toEqual([
      "backend:client",
      "uses-api",
      "uses-epic",
    ]);

    // Stranded, not cancelled: the decision about them is a person's.
    expect((await frontmatterOf(s, "uses-epic")).status).toBe("TODO");
    expect(
      success<ShowJson>(await s.run("show", "uses-api", "--json")).blocked_by,
    ).toEqual([{ ref: "epic/api", reason: "cancelled", status: "CANCELLED" }]);
    expect(
      success<ShowJson>(await s.run("show", "backend:client", "--json"))
        .blocked_by,
    ).toEqual([
      { ref: "../repo:epic/api", reason: "cancelled", status: "CANCELLED" },
    ]);
  });

  clause("an unknown frontmatter key survives a round trip", async () => {
    const s = await box({
      tasks: {
        a: {
          extra: {
            estimate: 3,
            labels: ["ui", "api"],
            reviewer: "alice",
            meta: { owner: "team-a", note: "keep: quoted" },
          },
        },
      },
    });
    const file = ".tasks/a/task.md";
    /** The frontmatter lines after the ten fields. */
    const extraLines = (text: string): string[] => {
      const lines = text.split("\n");
      const start = lines.findIndex((line) => line.startsWith("updated:")) + 1;
      return lines.slice(start, lines.indexOf("---", 1));
    };
    const before = extraLines(await s.read(file));
    expect(before.map((line) => line.split(":")[0])).toEqual([
      "estimate",
      "labels",
      "reviewer",
      "meta",
    ]);

    // Every transition rewrites the frontmatter; the keys ride along.
    const s1 = s.session("s1");
    expect((await s1("claim", "a")).code).toBe(0);
    expect(extraLines(await s.read(file))).toEqual(before);
    feedStdin("## Done\n\nThe estimate holds.\n");
    expect((await s1("state", "a")).code).toBe(0);
    expect((await s1("pause", "a", "-m", "estimate checked")).code).toBe(0);
    expect((await s.run("priority", "a", "high")).code).toBe(0);
    expect(extraLines(await s.read(file))).toEqual(before);
    expect(await frontmatterOf(s, "a")).toMatchObject({
      status: "PAUSED",
      priority: "high",
    });

    // Reported, as keys this revision does not define, but never an error.
    const validation = success<ValidationJson>(
      await s.run("validate", "--json"),
    );
    expect(validation.ok).toBe(true);
    expect(
      validation.findings
        .filter((finding) => finding.kind === "unknown-key")
        .map((finding) => [finding.severity, finding.task]),
    ).toEqual([
      ["warning", "a"],
      ["warning", "a"],
      ["warning", "a"],
      ["warning", "a"],
    ]);
  });

  clause(
    "a move rewrites every reference in the local tree and in listed trees and reports the ones in trees it cannot write",
    async () => {
      const s = await box({
        tasks: {
          "auth/tokens": {},
          "auth/tokens/schema": {},
          "uses-tokens": { depends_on: ["auth/tokens"] },
          "joins-schema": { finishes_after: ["auth/tokens/schema"] },
          // A bare relative path: that tree is read here, never written.
          "reads-bare": { depends_on: ["../bare:q"] },
        },
      });
      const backend = await s.project("backend", "../backend", {
        tasks: {
          client: {
            depends_on: ["../repo:auth/tokens"],
            finishes_after: ["../repo:auth/tokens/schema"],
          },
        },
      });
      const bare = path.join(s.root, "bare", ".tasks");
      await writeTree(bare, {
        tasks: { q: { depends_on: ["../repo:auth/tokens/schema"] } },
      });
      const bareManifest = path.join(bare, "q", "task.md");
      const bareBefore = await fs.readFile(bareManifest, "utf8");

      const moved = success<MoveJson>(
        await s.run("move", "auth/tokens", "identity/tokens", "--json"),
      );
      expect(moved.tasks).toEqual([
        { from: "auth/tokens", to: "identity/tokens" },
        { from: "auth/tokens/schema", to: "identity/tokens/schema" },
      ]);
      const byField = (project: string | null, task: string, field: string) =>
        moved.rewritten.find(
          (entry) =>
            entry.project === project &&
            entry.task === task &&
            entry.field === field,
        );
      expect(moved.rewritten).toHaveLength(4);
      expect(byField(null, "uses-tokens", "depends_on")).toMatchObject({
        from: "auth/tokens",
        to: "identity/tokens",
      });
      expect(byField(null, "joins-schema", "finishes_after")).toMatchObject({
        from: "auth/tokens/schema",
        to: "identity/tokens/schema",
      });
      expect(byField("backend", "client", "depends_on")).toMatchObject({
        from: "../repo:auth/tokens",
        to: "../repo:identity/tokens",
      });
      expect(byField("backend", "client", "finishes_after")).toMatchObject({
        from: "../repo:auth/tokens/schema",
        to: "../repo:identity/tokens/schema",
      });
      expect(moved.unrewritten).toEqual([
        {
          project: "../bare",
          task: "q",
          field: "depends_on",
          ref: "../repo:auth/tokens/schema",
        },
      ]);

      // The files say so, and the tree it could not write is untouched.
      expect((await frontmatterOf(s, "uses-tokens")).depends_on).toEqual([
        "identity/tokens",
      ]);
      expect((await frontmatterOf(s, "joins-schema")).finishes_after).toEqual([
        "identity/tokens/schema",
      ]);
      expect(await frontmatterOf(s, "client", backend)).toMatchObject({
        depends_on: ["../repo:identity/tokens"],
        finishes_after: ["../repo:identity/tokens/schema"],
      });
      expect(await fs.readFile(bareManifest, "utf8")).toBe(bareBefore);

      // Every rewritten reference still finds its task: waiting, not lost.
      expect(
        success<ShowJson>(await s.run("show", "uses-tokens", "--json"))
          .blocked_by,
      ).toEqual([
        { ref: "identity/tokens", reason: "not-done", status: "TODO" },
      ]);
      expect(
        success<ShowJson>(await s.run("show", "backend:client", "--json"))
          .blocked_by,
      ).toEqual([
        {
          ref: "../repo:identity/tokens",
          reason: "not-done",
          status: "TODO",
        },
      ]);
    },
  );
});

/* ------------------------------------------------------------------------ */
/* Edge cases of the implementation plan without a test of their own        */
/* ------------------------------------------------------------------------ */

describe("edge cases", () => {
  it("-C from a secondary worktree addresses the main checkout's tree", async () => {
    const s = await box({ tasks: { a: {} } });
    // A second worktree carries the committed tree as a copy of its own.
    const worktree = path.join(s.root, "wt");
    await writeTree(path.join(worktree, ".tasks"), { tasks: { a: {} } });
    const there = { cwd: worktree };

    const claimed = success<TransitionJson>(
      await s.runWith(there, "-C", "../repo", "claim", "a", "--json"),
    );
    expect(claimed.path).toBe(path.join(s.tasksDir, "a"));
    expect((await frontmatterOf(s, "a")).status).toBe("IN_PROGRESS");
    expect((await frontmatterOf(s, "a", worktree)).status).toBe("TODO");

    // Without -C the nearest tree wins: the worktree's own copy.
    const local = success<ShowJson>(
      await s.runWith(there, "show", "a", "--json"),
    );
    expect(local).toMatchObject({
      status: "TODO",
      path: path.join(worktree, ".tasks", "a"),
    });
  });

  it("the tree lock is reclaimed once it is older than 10 seconds", async () => {
    const s = await box({ tasks: { a: {} } });
    const lock = ".tasks/.locks/tree.lock";
    await s.write(
      lock,
      JSON.stringify({ pid: 999999, hostname: "elsewhere", timestamp: day(1) }),
    );

    // Five seconds old: a holder at work, waited for, then a conflict.
    await s.age(lock, 5 / 60);
    const busy = await s.run("claim", "a", "--json");
    expect(refusal(busy)).toMatchObject({ code: 4, error: "CONFLICT" });
    expect((await frontmatterOf(s, "a")).status).toBe("TODO");

    // Past the threshold it belongs to a process that died: reclaimed.
    await s.age(lock, 11 / 60);
    expect((await s.run("claim", "a")).code).toBe(0);
    expect((await frontmatterOf(s, "a")).status).toBe("IN_PROGRESS");
    expect(await s.exists(lock)).toBe(false);
  });

  it("a projects: alias that resolves to the local tree is a usage error", async () => {
    const s = await box({ tasks: { a: {} } });
    await s.write(".tasks/config.yml", "version: 2\nprojects:\n  me: .\n");
    const manifest = await s.read(".tasks/a/task.md");
    for (const argv of [["list"], ["show", "a"], ["claim", "a"]]) {
      const result = await s.run(...argv, "--json");
      expect({ argv, code: result.code }).toEqual({ argv, code: 2 });
      expect(errorOf(result)).toMatchObject({
        code: "USAGE",
        details: { alias: "me" },
      });
    }
    expect(await s.read(".tasks/a/task.md")).toBe(manifest);
    expect(await s.exists(".tasks/a/log.md")).toBe(false);
  });
});
