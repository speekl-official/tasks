import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { formatIso } from "../src/core/time.js";
import type { LogEntriesJson, LogEntryJson } from "../src/core/types.js";
import { readLog } from "../src/core/workspace.js";
import type { TreeSpec } from "./fixtures.js";
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

function errorOf(result: CliResult): ErrorJson["error"] {
  return result.json<ErrorJson>().error;
}

async function box(spec: TreeSpec): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

const MINUTE = 60_000;
const DAY = 24 * 60;

function ago(minutes: number): string {
  return formatIso(new Date(Date.now() - minutes * MINUTE));
}

/** One entry of `log.md` in the heading grammar. */
function entry(time: string, actor: string, text: string): string {
  return `## ${time} ${actor}\n${text}\n`;
}

describe("log <task> <text>", () => {
  it("appends a narrative entry without touching the manifest", async () => {
    const s = await box({ tasks: { "x/a": {} } });
    const manifest = await s.read(".tasks/x/a/task.md");

    const result = await s.run("log", "a", "Found the cause: a stale cache.");
    expect(result.code).toBe(0);
    expect(stripVTControlCharacters(result.stdout)).toContain("✓ log x/a:");

    expect(await s.read(".tasks/x/a/task.md")).toBe(manifest);
    const entries = await readLog(path.join(s.tasksDir, "x", "a"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "tester",
      via: null,
      session: null,
      text: "Found the cause: a stale cache.",
    });
    const log = await s.read(".tasks/x/a/log.md");
    expect(log).toBe(
      `## ${entries[0]!.time} tester\nFound the cause: a stale cache.\n`,
    );
  });

  it("returns the entry as written, with the session and the operator", async () => {
    const s = await box({ tasks: { a: { log: entry(ago(5), "bob", "x") } } });
    const result = await s.session("s1")(
      "log",
      "a",
      "Second note",
      "--as",
      "alice",
      "--json",
    );
    expect(result.code).toBe(0);
    const json = result.json<LogEntryJson>();
    expect(json).toMatchObject({
      task: "a",
      actor: "alice",
      via: "tester",
      session: "s1",
      text: "Second note",
    });
    expect(await s.read(".tasks/a/log.md")).toContain(
      `## ${json.time} alice via tester s:s1\nSecond note\n`,
    );
  });

  it("joins unquoted words and keeps multi-line text", async () => {
    const s = await box({ tasks: { a: {} } });
    expect((await s.run("log", "a", "two", "words")).code).toBe(0);
    expect((await s.run("log", "a", "line one\nline two")).code).toBe(0);
    const entries = await readLog(path.join(s.tasksDir, "a"));
    expect(entries.map((e) => e.text)).toEqual([
      "two words",
      "line one\nline two",
    ]);
  });

  it("lets anyone append, even to a task another session holds", async () => {
    const s = await box({
      tasks: { w: { status: "IN_PROGRESS", claimed_session: "s2" } },
    });
    await s.write(".tasks/.locks/sessions/s2", "");
    const result = await s.session("s1")("log", "w", "Observed from outside");
    expect(result.code).toBe(0);
  });

  it("appends to a task of a listed project", async () => {
    const s = await box({});
    const backend = await s.project("backend", "../backend", {
      tasks: { "kernel/x": {} },
    });
    const result = await s.run("log", "backend:x", "Remote note", "--json");
    expect(result.code).toBe(0);
    expect(result.json<LogEntryJson>().task).toBe("backend:kernel/x");
    const entries = await readLog(path.join(backend, ".tasks", "kernel", "x"));
    expect(entries.map((e) => e.text)).toEqual(["Remote note"]);
  });

  it("refuses text that would corrupt the log, and invocations that make no sense", async () => {
    const s = await box({ tasks: { a: {} } });
    const heading = await s.run(
      "log",
      "a",
      "ok\n## 2026-01-01T00:00:00Z mallory",
      "--json",
    );
    expect(heading.code).toBe(2);
    expect(errorOf(heading).details).toMatchObject({ line: 2 });

    expect((await s.run("log", "a", "<<<<<<< HEAD")).code).toBe(2);
    expect((await s.run("log", "a", "   ")).code).toBe(2);
    expect((await s.run("log", "a")).code).toBe(2);
    expect((await s.run("log")).code).toBe(2);
    expect((await s.run("log", "a", "x", "--since", "1d")).code).toBe(2);
    expect((await s.run("log", "a", "x", "--local")).code).toBe(2);
    expect(await s.exists(".tasks/a/log.md")).toBe(false);

    expect((await s.run("log", "nope", "text")).code).toBe(3);
  });
});

describe("log --since", () => {
  /** Entries spread over time in the local tree and in a listed project. */
  async function history(): Promise<{ s: Sandbox; hour: string }> {
    const hour = ago(60);
    const s = await box({
      tasks: {
        a: {
          log: [
            entry(ago(2 * DAY), "alice", "a two days ago"),
            entry(hour, "alice", "a an hour ago"),
          ].join("\n"),
        },
        b: { log: entry(hour, "bob", "b an hour ago") },
        c: { log: entry(ago(10 * DAY), "carol", "c too old") },
        quiet: {},
      },
    });
    await s.project("backend", "../backend", {
      tasks: {
        x: {
          log: [
            entry(ago(3 * DAY), "dave", "x three days ago"),
            entry(hour, "dave", "x an hour ago"),
          ].join("\n"),
        },
      },
    });
    return { s, hour };
  }

  it("lists entries across trees, oldest first, foreign tasks qualified", async () => {
    const { s, hour } = await history();
    const result = await s.run("log", "--since", "7d", "--json");
    expect(result.code).toBe(0);
    const json = result.json<LogEntriesJson>();
    expect(json.count).toBe(json.entries.length);
    // Equal times: the local tree first, then by task id.
    expect(json.entries.map((e) => [e.task, e.text])).toEqual([
      ["backend:x", "x three days ago"],
      ["a", "a two days ago"],
      ["a", "a an hour ago"],
      ["b", "b an hour ago"],
      ["backend:x", "x an hour ago"],
    ]);
    expect(json.entries[2]).toEqual({
      task: "a",
      time: hour,
      actor: "alice",
      via: null,
      session: null,
      text: "a an hour ago",
    });
  });

  it("takes a timestamp as the lower bound, inclusive", async () => {
    const { s, hour } = await history();
    const result = await s.run("log", "--since", hour, "--json");
    expect(result.code).toBe(0);
    expect(result.json<LogEntriesJson>().entries.map((e) => e.text)).toEqual([
      "a an hour ago",
      "b an hour ago",
      "x an hour ago",
    ]);
  });

  it("restricts to the local tree with --local", async () => {
    const { s } = await history();
    const result = await s.run("log", "--since", "7d", "--local", "--json");
    expect(result.code).toBe(0);
    expect(result.json<LogEntriesJson>().entries.map((e) => e.task)).toEqual([
      "a",
      "a",
      "b",
    ]);
  });

  it("renders the entries for a person and reports an empty window", async () => {
    const { s } = await history();
    const human = await s.run("log", "--since", "7d");
    expect(human.code).toBe(0);
    const text = stripVTControlCharacters(human.stdout);
    expect(text).toContain("backend:x");
    expect(text).toContain("a two days ago");
    expect(text).not.toContain("c too old");

    const empty = await s.run("log", "--since", "1m", "--json");
    expect(empty.code).toBe(0);
    expect(empty.json<LogEntriesJson>()).toEqual({ count: 0, entries: [] });
  });

  it("refuses a --since it cannot read", async () => {
    const { s } = await history();
    const result = await s.run("log", "--since", "yesterday", "--json");
    expect(result.code).toBe(2);
    expect(errorOf(result).details).toMatchObject({ since: "yesterday" });
  });
});
