import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findTask } from "../src/core/tree.js";
import type { LogEntry } from "../src/core/workspace.js";
import {
  appendLogEntry,
  assertLogText,
  cascadeLine,
  creationLine,
  fieldLine,
  formatLogEntry,
  formatLogHeading,
  handoffLine,
  hasConflictMarkers,
  lastLogEntry,
  logEntryFor,
  parseLog,
  parseLogHeading,
  reachedLine,
  readLog,
  readState,
  stateMtime,
  takeoverLine,
  toLogEntryJson,
  transitionLine,
  unassignLine,
  workspaceFiles,
  workspacePresence,
  writeState,
} from "../src/core/workspace.js";
import type { TaskError } from "../src/errors.js";
import { isTaskError } from "../src/errors.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

async function withTask(
  spec: Parameters<typeof treeSandbox>[0] = { tasks: { a: {} } },
): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

function caught(fn: () => unknown): TaskError {
  try {
    fn();
  } catch (err) {
    if (isTaskError(err)) return err;
    throw err;
  }
  throw new Error("expected a TaskError");
}

async function caughtAsync(promise: Promise<unknown>): Promise<TaskError> {
  try {
    await promise;
  } catch (err) {
    if (isTaskError(err)) return err;
    throw err;
  }
  throw new Error("expected a TaskError");
}

const T1 = "2026-09-21T16:40:12Z";
const T2 = "2026-09-22T08:02:41Z";
const T3 = "2026-09-23T10:00:00Z";

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    time: T1,
    actor: "agent",
    via: null,
    session: null,
    text: "pause: IN_PROGRESS → PAUSED",
    ...overrides,
  };
}

describe("workspace presence", () => {
  it("reports the vocabulary files that exist as files", async () => {
    const box = await withTask({
      tasks: { a: { state: true, log: "## x\n" } },
    });
    // A directory named like a vocabulary file is workspace content.
    await fs.mkdir(path.join(box.tasksDir, "a", "plan.md"));

    const presence = await workspacePresence(path.join(box.tasksDir, "a"));
    expect(presence).toEqual({
      state: true,
      design: false,
      plan: false,
      log: true,
    });
    expect(presence).toEqual(findTask(await box.loadTree(), "a").workspace);
  });

  it("lists a task's files in reading order", async () => {
    const box = await withTask({
      tasks: {
        all: { state: true, design: true, plan: true, log: "" },
        some: { design: true, log: "" },
        none: {},
      },
    });
    const tree = await box.loadTree();
    expect(workspaceFiles(findTask(tree, "all"))).toEqual([
      "state.md",
      "design.md",
      "plan.md",
      "log.md",
    ]);
    expect(workspaceFiles(findTask(tree, "some"))).toEqual([
      "design.md",
      "log.md",
    ]);
    expect(workspaceFiles(findTask(tree, "none"))).toEqual([]);
  });
});

describe("state.md", () => {
  it("reads the resume point, or null without one", async () => {
    const box = await withTask({
      tasks: { a: { state: "## Next\n\nwire the CLI\n" }, b: {} },
    });
    expect(await readState(path.join(box.tasksDir, "a"))).toBe(
      "## Next\n\nwire the CLI\n",
    );
    expect(await readState(path.join(box.tasksDir, "b"))).toBeNull();
  });

  it("writes exactly the content given, atomically", async () => {
    const box = await withTask({ tasks: { a: { state: true } } });
    const dir = path.join(box.tasksDir, "a");

    for (const content of [
      "no newline at the end",
      "\n\n  spaced  \n\n\n",
      "",
    ]) {
      await writeState(dir, content);
      expect(await box.read(".tasks/a/state.md")).toBe(content);
    }
    expect((await fs.readdir(dir)).sort()).toEqual(["state.md", "task.md"]);
  });

  it("refuses a task directory that does not exist, creating nothing", async () => {
    const box = await withTask();
    const dir = path.join(box.tasksDir, "ghost");
    const err = await caughtAsync(writeState(dir, "x"));
    expect(err.code).toBe("NOT_FOUND");
    expect(await box.exists(".tasks/ghost")).toBe(false);
  });

  it("reports when the resume point was written", async () => {
    const box = await withTask({ tasks: { a: { state: true }, b: {} } });
    await box.age(".tasks/a/state.md", 90);

    const written = await stateMtime(path.join(box.tasksDir, "a"));
    expect(written).toBeInstanceOf(Date);
    const ageMinutes = (Date.now() - written!.getTime()) / 60_000;
    expect(ageMinutes).toBeGreaterThan(89);
    expect(ageMinutes).toBeLessThan(91);

    expect(await stateMtime(path.join(box.tasksDir, "b"))).toBeNull();
    await fs.mkdir(path.join(box.tasksDir, "b", "state.md"));
    expect(await stateMtime(path.join(box.tasksDir, "b"))).toBeNull();
  });
});

describe("log headings", () => {
  const forms: Array<[string, Omit<LogEntry, "text">]> = [
    [`## ${T1} agent`, { time: T1, actor: "agent", via: null, session: null }],
    [
      `## ${T1} alice via agent`,
      { time: T1, actor: "alice", via: "agent", session: null },
    ],
    [
      `## ${T1} agent s:7f3a`,
      { time: T1, actor: "agent", via: null, session: "7f3a" },
    ],
    [
      `## ${T1} alice via agent s:7f3a`,
      { time: T1, actor: "alice", via: "agent", session: "7f3a" },
    ],
    [
      `## ${T1} ada@example.com s:a.b_c+d-e`,
      { time: T1, actor: "ada@example.com", via: null, session: "a.b_c+d-e" },
    ],
  ];

  it("formats every optional part in grammar order", () => {
    for (const [line, heading] of forms) {
      expect(formatLogHeading(heading)).toBe(line);
    }
  });

  it("parses what it formats", () => {
    for (const [line, heading] of forms) {
      expect(parseLogHeading(line)).toEqual(heading);
    }
  });

  it("tolerates trailing whitespace and a carriage return", () => {
    expect(parseLogHeading(`## ${T1} agent s:7f3a  \r`)).toEqual({
      time: T1,
      actor: "agent",
      via: null,
      session: "7f3a",
    });
  });

  it("keeps positions fixed, so an actor may be named via", () => {
    expect(parseLogHeading(`## ${T1} via`)).toEqual({
      time: T1,
      actor: "via",
      via: null,
      session: null,
    });
    expect(parseLogHeading(`## ${T1} via via via`)).toEqual({
      time: T1,
      actor: "via",
      via: "via",
      session: null,
    });
  });

  it("rejects lines outside the grammar", () => {
    for (const line of [
      "## Findings",
      `## ${T1}`,
      "## 2026-09-21 agent",
      "## 2026-09-21T16:40:12+00:00 agent",
      "## 2026-09-21T16:40:12.000Z agent",
      "## 2026-02-30T00:00:00Z agent",
      `##  ${T1} agent`,
      `### ${T1} agent`,
      ` ## ${T1} agent`,
      `## ${T1}  agent`,
      `## ${T1} Ada L`,
      `## ${T1} -alice`,
      `## ${T1} alice via`,
      `## ${T1} alice via Ada L`,
      `## ${T1} alice s:7f3a via agent`,
      `## ${T1} alice s:`,
      `## ${T1} alice s:7f3a extra`,
      `## ${T1} alice session:7f3a`,
      "",
    ]) {
      expect(parseLogHeading(line), line).toBeNull();
    }
  });

  it("refuses to write a heading no reader could parse", () => {
    const base = { time: T1, actor: "agent", via: null, session: null };
    for (const bad of [
      { ...base, time: "yesterday" },
      { ...base, actor: "Ada L" },
      { ...base, via: "the operator" },
      { ...base, session: "a b" },
    ]) {
      expect(caught(() => formatLogHeading(bad)).code).toBe("INTERNAL");
    }
  });
});

describe("log entries", () => {
  it("is the heading, the text and one trailing newline", () => {
    expect(formatLogEntry(entry({ text: "claim: TODO → IN_PROGRESS" }))).toBe(
      `## ${T1} agent\nclaim: TODO → IN_PROGRESS\n`,
    );
    expect(
      formatLogEntry(
        entry({ session: "7f3a", text: "done: PAUSED → DONE\nAPPLY.\n\n  " }),
      ),
    ).toBe(`## ${T1} agent s:7f3a\ndone: PAUSED → DONE\nAPPLY.\n`);
  });

  it("normalizes line ends and leading blank lines, never indentation", () => {
    expect(
      formatLogEntry(entry({ text: "\n  \n    indented\r\nnext\r\n" })),
    ).toBe(`## ${T1} agent\n    indented\nnext\n`);
    expect(formatLogEntry(entry({ text: "  \n" }))).toBe(`## ${T1} agent\n`);
  });

  it("allows a level-two heading that is not an entry heading", () => {
    expect(() => assertLogText("## Findings\nnothing odd")).not.toThrow();
  });

  it("refuses text that would split the entry or read as a conflict", () => {
    for (const [text, line] of [
      [`first\n## ${T2} alice`, 2],
      [`## ${T2} alice via agent s:x`, 1],
      ["ok\n<<<<<<< HEAD", 2],
      ["=======", 1],
      ["a\nb\r\n>>>>>>> theirs", 3],
      ["||||||| base", 1],
    ] as const) {
      const err = caught(() => assertLogText(text));
      expect(err.code, text).toBe("USAGE");
      expect(err.details?.line).toBe(line);
      expect(caught(() => formatLogEntry(entry({ text }))).code).toBe("USAGE");
    }
  });
});

describe("appendLogEntry", () => {
  it("creates a missing log.md with exactly the entry", async () => {
    const box = await withTask();
    await appendLogEntry(path.join(box.tasksDir, "a"), entry());
    expect(await box.read(".tasks/a/log.md")).toBe(
      `## ${T1} agent\npause: IN_PROGRESS → PAUSED\n`,
    );
  });

  it("separates entries by exactly one blank line", async () => {
    const box = await withTask();
    const dir = path.join(box.tasksDir, "a");
    await appendLogEntry(dir, entry());
    await appendLogEntry(dir, entry({ time: T2, actor: "alice", text: "b" }));
    expect(await box.read(".tasks/a/log.md")).toBe(
      `## ${T1} agent\npause: IN_PROGRESS → PAUSED\n\n## ${T2} alice\nb\n`,
    );
  });

  it("completes the blank line after a file without a trailing newline", async () => {
    const box = await withTask({ tasks: { a: { log: `## ${T1} agent\nx` } } });
    await appendLogEntry(
      path.join(box.tasksDir, "a"),
      entry({ time: T2, text: "y" }),
    );
    expect(await box.read(".tasks/a/log.md")).toBe(
      `## ${T1} agent\nx\n\n## ${T2} agent\ny\n`,
    );
  });

  it("adds nothing after an existing blank line, CRLF included", async () => {
    const box = await withTask({
      tasks: {
        lf: { log: `## ${T1} agent\nx\n\n\n` },
        crlf: { log: `## ${T1} agent\r\nx\r\n\r\n` },
      },
    });
    await appendLogEntry(path.join(box.tasksDir, "lf"), entry({ text: "y" }));
    await appendLogEntry(path.join(box.tasksDir, "crlf"), entry({ text: "y" }));
    expect(await box.read(".tasks/lf/log.md")).toBe(
      `## ${T1} agent\nx\n\n\n## ${T1} agent\ny\n`,
    );
    expect(await box.read(".tasks/crlf/log.md")).toBe(
      `## ${T1} agent\r\nx\r\n\r\n## ${T1} agent\ny\n`,
    );
  });

  it("never rewrites what is already there", async () => {
    const original = "# Log of a\r\nfree text, ünïcödé\t \n## not a heading";
    const box = await withTask({ tasks: { a: { log: original } } });
    await appendLogEntry(path.join(box.tasksDir, "a"), entry());
    const after = await box.read(".tasks/a/log.md");
    expect(after.startsWith(original)).toBe(true);
    expect(after.slice(original.length)).toBe(
      `\n\n## ${T1} agent\npause: IN_PROGRESS → PAUSED\n`,
    );
  });

  it("leaves the file untouched when the entry is refused", async () => {
    const box = await withTask({ tasks: { a: { log: "kept\n" }, b: {} } });
    for (const id of ["a", "b"]) {
      const err = await caughtAsync(
        appendLogEntry(
          path.join(box.tasksDir, id),
          entry({ text: `## ${T2} alice` }),
        ),
      );
      expect(err.code).toBe("USAGE");
    }
    expect(await box.read(".tasks/a/log.md")).toBe("kept\n");
    expect(await box.exists(".tasks/b/log.md")).toBe(false);
  });
});

describe("parseLog", () => {
  it("round-trips appended entries, via and session forms included", async () => {
    const box = await withTask();
    const dir = path.join(box.tasksDir, "a");
    const entries: LogEntry[] = [
      entry({ session: "7f3a" }),
      entry({
        time: T2,
        actor: "alice",
        via: "agent",
        text: "done: PAUSED → DONE\nAPPLY. Committed as abc123.",
      }),
      entry({
        time: T3,
        actor: "alice",
        via: "agent",
        session: "s-2",
        text: "notes\n\n## Findings\n- one\n    code",
      }),
    ];
    for (const item of entries) await appendLogEntry(dir, item);

    expect(await readLog(dir)).toEqual(entries);
    expect(parseLog(entries.map(formatLogEntry).join("\n"))).toEqual(entries);
  });

  it("reads the specification's example", () => {
    const source = [
      "## 2026-09-21T16:40:12Z agent s:7f3a",
      "pause: IN_PROGRESS → PAUSED",
      "Kernel tests green (623/0); docs updated; awaiting review of the CLI rendering.",
      "",
      "## 2026-09-22T08:02:41Z alice via agent",
      "done: PAUSED → DONE",
      "APPLY. Committed as abc123.",
      "",
    ].join("\n");
    expect(parseLog(source)).toEqual([
      {
        time: "2026-09-21T16:40:12Z",
        actor: "agent",
        via: null,
        session: "7f3a",
        text: "pause: IN_PROGRESS → PAUSED\nKernel tests green (623/0); docs updated; awaiting review of the CLI rendering.",
      },
      {
        time: "2026-09-22T08:02:41Z",
        actor: "alice",
        via: "agent",
        session: null,
        text: "done: PAUSED → DONE\nAPPLY. Committed as abc123.",
      },
    ]);
  });

  it("keeps a non-grammar level-two line in the entry's text", () => {
    const source = `## ${T1} agent\nfirst\n## Findings\n## ${T1} Ada L\nlast\n`;
    expect(parseLog(source)).toEqual([
      {
        time: T1,
        actor: "agent",
        via: null,
        session: null,
        text: `first\n## Findings\n## ${T1} Ada L\nlast`,
      },
    ]);
  });

  it("ignores text before the first heading", () => {
    const source = `# Log\n\nwritten by hand\n\n## ${T1} agent\nx\n`;
    expect(parseLog(source)).toEqual([
      { time: T1, actor: "agent", via: null, session: null, text: "x" },
    ]);
  });

  it("reads CRLF line ends and a byte-order mark", () => {
    const source = `\uFEFF## ${T1} agent\r\nx\r\ny\r\n\r\n## ${T2} alice\r\nz\r\n`;
    expect(parseLog(source)).toEqual([
      { time: T1, actor: "agent", via: null, session: null, text: "x\ny" },
      { time: T2, actor: "alice", via: null, session: null, text: "z" },
    ]);
  });

  it("finds nothing in an empty log or one without headings", async () => {
    expect(parseLog("")).toEqual([]);
    expect(parseLog("just notes\n## Findings\n")).toEqual([]);
    const box = await withTask();
    expect(await readLog(path.join(box.tasksDir, "a"))).toEqual([]);
  });
});

describe("lastLogEntry", () => {
  it("is null without a log or without an entry", async () => {
    const box = await withTask({ tasks: { a: {}, b: { log: "# Log\n" } } });
    expect(await lastLogEntry(path.join(box.tasksDir, "a"))).toBeNull();
    expect(await lastLogEntry(path.join(box.tasksDir, "b"))).toBeNull();
  });

  it("is the most recent entry, wherever a merge left it", async () => {
    const log = [
      `## ${T1} agent s:7f3a`,
      "claim: TODO → IN_PROGRESS",
      "",
      `## ${T3} alice via agent`,
      "done: PAUSED → DONE",
      "APPLY.",
      "",
      `## ${T2} agent`,
      "pause: IN_PROGRESS → PAUSED",
      "",
    ].join("\n");
    const box = await withTask({ tasks: { a: { log } } });
    const last = await lastLogEntry(path.join(box.tasksDir, "a"));
    expect(last).toEqual({
      time: T3,
      actor: "alice",
      via: "agent",
      session: null,
      text: "done: PAUSED → DONE\nAPPLY.",
    });
    expect(Object.keys(last!)).toEqual([
      "time",
      "actor",
      "via",
      "session",
      "text",
    ]);
  });

  it("takes the later entry of two in the same second", async () => {
    const log = `## ${T1} agent\nfirst\n\n## ${T1} alice\nsecond\n`;
    const box = await withTask({ tasks: { a: { log } } });
    expect((await lastLogEntry(path.join(box.tasksDir, "a")))?.text).toBe(
      "second",
    );
  });

  it("gains the task in the log-entries shape", () => {
    const json = toLogEntryJson(entry({ via: "x" }), "backend:a/b");
    expect(json).toEqual({
      task: "backend:a/b",
      time: T1,
      actor: "agent",
      via: "x",
      session: null,
      text: "pause: IN_PROGRESS → PAUSED",
    });
    expect(Object.keys(json)[0]).toBe("task");
  });
});

describe("hasConflictMarkers", () => {
  it("finds each of git's markers at a line start", () => {
    for (const marker of [
      "<<<<<<< HEAD",
      "<<<<<<<",
      "=======",
      "=======  ",
      ">>>>>>> feature/x",
      "||||||| merged common ancestors",
      "=======\r",
    ]) {
      expect(
        hasConflictMarkers(`## ${T1} agent\nx\n${marker}\ny\n`),
        marker,
      ).toBe(true);
    }
  });

  it("ignores lookalikes", () => {
    for (const text of [
      "========",
      "<<<<<<<<",
      "<<<<<<<HEAD",
      ">>>>>>>>> x",
      "=======x",
      " =======",
      "== =====",
      "text with ======= inside",
      "> <<<<<<< quoted",
    ]) {
      expect(hasConflictMarkers(`a\n${text}\nb`), text).toBe(false);
    }
  });
});

describe("first lines", () => {
  it("names a transition, marking a forced one", () => {
    expect(transitionLine("claim", "TODO", "IN_PROGRESS")).toBe(
      "claim: TODO → IN_PROGRESS",
    );
    expect(
      transitionLine("done", "IN_PROGRESS", "DONE", { forced: true }),
    ).toBe("done: IN_PROGRESS → DONE (forced)");
    expect(
      transitionLine("pause", "IN_PROGRESS", "PAUSED", { forced: false }),
    ).toBe("pause: IN_PROGRESS → PAUSED");
  });

  it("names the parent on a task a cascade reached", () => {
    expect(cascadeLine("cancel", "epic", "TODO", "CANCELLED")).toBe(
      "cancel with epic: TODO → CANCELLED",
    );
    expect(
      cascadeLine("defer", "auth/rework", "IN_PROGRESS", "BACKLOG", {
        forced: true,
      }),
    ).toBe("defer with auth/rework: IN_PROGRESS → BACKLOG (forced)");
    expect(reachedLine(["epic/a", "epic/b/c"])).toBe(
      "reached: epic/a, epic/b/c",
    );
  });

  it("writes handoff, field changes and creation", () => {
    expect(handoffLine("alice")).toBe("handoff alice: IN_PROGRESS → PAUSED");
    expect(handoffLine("alice", { forced: true })).toBe(
      "handoff alice: IN_PROGRESS → PAUSED (forced)",
    );
    expect(fieldLine("assign", "alice")).toBe("assign: alice");
    expect(fieldLine("priority", "high", { forced: true })).toBe(
      "priority: high (forced)",
    );
    expect(unassignLine()).toBe("unassign");
    expect(unassignLine({ forced: true })).toBe("unassign (forced)");
    expect(creationLine("TODO")).toBe("new: TODO");
    expect(creationLine("BACKLOG")).toBe("new: BACKLOG");
  });

  it("records the claim a takeover superseded", () => {
    expect(takeoverLine("agent", "7f3a", T1)).toBe(
      `supersedes agent s:7f3a, last seen ${T1}`,
    );
    expect(takeoverLine("alice", null, null)).toBe(
      "supersedes alice, last seen unknown",
    );
  });
});

describe("logEntryFor", () => {
  it("stamps the identity and joins the lines it is given", async () => {
    const identity = { actor: "alice", via: "agent", session: "7f3a" };
    const made = logEntryFor(identity, T2, [
      transitionLine("done", "PAUSED", "DONE"),
      null,
      takeoverLine("bob", null, null),
      undefined,
      "APPLY.",
    ]);
    expect(made).toEqual({
      time: T2,
      actor: "alice",
      via: "agent",
      session: "7f3a",
      text: "done: PAUSED → DONE\nsupersedes bob, last seen unknown\nAPPLY.",
    });

    const box = await withTask();
    await appendLogEntry(path.join(box.tasksDir, "a"), made);
    expect(await box.read(".tasks/a/log.md")).toBe(
      `## ${T2} alice via agent s:7f3a\ndone: PAUSED → DONE\nsupersedes bob, last seen unknown\nAPPLY.\n`,
    );
  });
});
