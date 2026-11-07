import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { renderTaskFile } from "../src/core/frontmatter.js";
import { taskBodyTemplate } from "../src/core/templates.js";
import { isIsoTimestamp } from "../src/core/time.js";
import type { TaskWithDerivedJson } from "../src/core/types.js";
import { readLog } from "../src/core/workspace.js";
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

describe("new", () => {
  it("creates a TODO task: canonical manifest, body scaffold, creation entry", async () => {
    sandbox = await treeSandbox({});
    const result = await sandbox.run(
      "new",
      "auth-rework/token-schema",
      "Design",
      "the",
      "token",
      "schema",
      "--json",
    );
    expect(result.code).toBe(0);

    const json = result.json<TaskWithDerivedJson>();
    expect(json).toMatchObject({
      id: "auth-rework/token-schema",
      name: "token-schema",
      parent: null,
      project: null,
      title: "Design the token schema",
      status: "TODO",
      priority: "normal",
      depends_on: [],
      finishes_after: [],
      assignee: null,
      claimed_by: null,
      claimed_at: null,
      claimed_session: null,
      path: path.join(sandbox.tasksDir, "auth-rework", "token-schema"),
      situation: "ready",
      ready: true,
      started: false,
      held_by: null,
      blocked_by: [],
      children: { open: 0, resolved: 0 },
      effective_priority: "normal",
    });
    expect(isIsoTimestamp(json.created)).toBe(true);
    expect(json.updated).toBe(json.created);
    expect(json.last_entry).toEqual({
      time: json.created,
      actor: "tester",
      via: null,
      session: null,
      text: "new: TODO",
    });

    const manifest = await sandbox.read(
      ".tasks/auth-rework/token-schema/task.md",
    );
    expect(manifest).toBe(
      renderTaskFile(
        {
          status: "TODO",
          priority: "normal",
          depends_on: [],
          finishes_after: [],
          assignee: null,
          claimed_by: null,
          claimed_at: null,
          claimed_session: null,
          created: json.created,
          updated: json.created,
        },
        [],
        taskBodyTemplate("Design the token schema"),
      ),
    );
    expect(manifest).toContain(
      "# Design the token schema\n\n## Description\n\n## Acceptance criteria\n\n- [ ]\n\n## Notes\n",
    );
    expect(await sandbox.read(".tasks/auth-rework/token-schema/log.md")).toBe(
      `## ${json.created} tester\nnew: TODO\n`,
    );

    // The group was created on demand and stays a group.
    const tree = await sandbox.loadTree();
    expect(tree.groups.has("auth-rework")).toBe(true);
    expect(tree.byId.get("auth-rework/token-schema")?.parent).toBeNull();
  });

  it("prints one line for the creation without --json", async () => {
    sandbox = await treeSandbox({});
    const result = await sandbox.run("new", "a", "First", "task");
    expect(result.code).toBe(0);
    expect(stripVTControlCharacters(result.stdout)).toContain("✓ new a");
    expect(result.stderr).toBe("");
  });

  it("records the session in the creation entry's heading", async () => {
    sandbox = await treeSandbox({});
    const result = await sandbox.session("s1")("new", "a", "Task", "--json");
    expect(result.code).toBe(0);
    const json = result.json<TaskWithDerivedJson>();
    expect(await sandbox.read(".tasks/a/log.md")).toBe(
      `## ${json.created} tester s:s1\nnew: TODO\n`,
    );
  });

  it("creates in BACKLOG on request", async () => {
    sandbox = await treeSandbox({});
    const result = await sandbox.run(
      "new",
      "later",
      "Later",
      "--backlog",
      "--json",
    );
    expect(result.code).toBe(0);
    const json = result.json<TaskWithDerivedJson>();
    expect(json.status).toBe("BACKLOG");
    expect(json.situation).toBe("backlog");
    const [entry] = await readLog(path.join(sandbox.tasksDir, "later"));
    expect(entry?.text).toBe("new: BACKLOG");
  });

  it("creates in BACKLOG beneath a BACKLOG ancestor, through groups too", async () => {
    sandbox = await treeSandbox({
      tasks: { epic: { status: "BACKLOG" } },
    });
    const child = await sandbox.run("new", "epic/part", "Part", "--json");
    expect(child.code).toBe(0);
    expect(child.json<TaskWithDerivedJson>()).toMatchObject({
      status: "BACKLOG",
      parent: "epic",
    });

    const deep = await sandbox.run("new", "epic/stage/step", "Step", "--json");
    expect(deep.code).toBe(0);
    expect(deep.json<TaskWithDerivedJson>()).toMatchObject({
      status: "BACKLOG",
      parent: "epic",
    });
  });

  it("sets the assignee and refuses an assignee that is not an actor", async () => {
    sandbox = await treeSandbox({});
    const result = await sandbox.run(
      "new",
      "deploy",
      "Deploy",
      "--assign",
      "alice",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>()).toMatchObject({
      assignee: "alice",
      situation: "assigned",
      ready: false,
    });

    const bad = await sandbox.run(
      "new",
      "other",
      "Other",
      "--assign",
      "two words",
      "--json",
    );
    expect(bad.code).toBe(2);
    expect(errorOf(bad).code).toBe("USAGE");
    expect(await sandbox.exists(".tasks/other")).toBe(false);
  });

  it("sets the priority and refuses a level that does not exist", async () => {
    sandbox = await treeSandbox({});
    const result = await sandbox.run(
      "new",
      "hot",
      "Hot",
      "--priority",
      "high",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>()).toMatchObject({
      priority: "high",
      effective_priority: "high",
    });

    const bad = await sandbox.run(
      "new",
      "cold",
      "Cold",
      "--priority",
      "extreme",
      "--json",
    );
    expect(bad.code).toBe(2);
    expect(errorOf(bad).details).toMatchObject({ priority: "extreme" });
    expect(await sandbox.exists(".tasks/cold")).toBe(false);
  });

  it("refuses a path where a task exists", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const before = await sandbox.read(".tasks/a/task.md");
    const result = await sandbox.run("new", "a", "Again", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({ id: "a", kind: "exists" });
    expect(await sandbox.read(".tasks/a/task.md")).toBe(before);
  });

  it("refuses a path reserved by an archived task, naming purge", async () => {
    sandbox = await treeSandbox({
      archived: { "old/task": { status: "DONE" } },
    });
    const result = await sandbox.run("new", "old/task", "Again", "--json");
    expect(result.code).toBe(4);
    const error = errorOf(result);
    expect(error.message).toContain("tasks purge old/task");
    expect(error.details).toMatchObject({ id: "old/task", kind: "reserved" });
    expect(await sandbox.exists(".tasks/old/task")).toBe(false);
  });

  it("refuses a path beneath a resolved ancestor", async () => {
    sandbox = await treeSandbox({
      tasks: {
        shipped: { status: "DONE" },
        dropped: { status: "CANCELLED" },
      },
    });
    for (const parent of ["shipped", "dropped"]) {
      const result = await sandbox.run(
        "new",
        `${parent}/more`,
        "More",
        "--json",
      );
      expect(result.code).toBe(4);
      expect(errorOf(result).details).toMatchObject({
        kind: "resolved-ancestor",
        ancestor: parent,
      });
    }
    const deep = await sandbox.run("new", "shipped/a/b", "Deep", "--json");
    expect(deep.code).toBe(4);
  });

  it("refuses a path beneath a malformed manifest: its status is unknown", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(".tasks/broken/task.md", "not a manifest\n");
    const result = await sandbox.run("new", "broken/child", "Child", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      kind: "malformed-ancestor",
      ancestor: "broken",
    });
  });

  it("refuses a path that a file occupies", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.write(".tasks/a/notes", "workspace content\n");
    const result = await sandbox.run("new", "a/notes/x", "X", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({ kind: "path-blocked" });
  });

  it("turns an existing group into the task; its tasks become children", async () => {
    sandbox = await treeSandbox({
      tasks: { "epic/a": {}, "epic/b": { status: "DONE" } },
    });
    const result = await sandbox.run("new", "epic", "The", "epic", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>()).toMatchObject({
      id: "epic",
      parent: null,
      status: "TODO",
      children: { open: 1, resolved: 1 },
      situation: "open",
      ready: false,
    });

    const tree = await sandbox.loadTree();
    expect(tree.groups.has("epic")).toBe(false);
    expect(tree.byId.get("epic/a")?.parent).toBe("epic");
    expect(tree.byId.get("epic/b")?.parent).toBe("epic");
  });

  it("refuses BACKLOG over a group whose tasks are scheduled; TODO adopts them", async () => {
    sandbox = await treeSandbox({
      tasks: {
        "g/x": {},
        "g/y": { status: "BACKLOG" },
        "g/z": { status: "DONE" },
        "h/y": { status: "BACKLOG" },
        "h/z": { status: "CANCELLED" },
      },
    });
    const refused = await sandbox.run(
      "new",
      "g",
      "Epic",
      "--backlog",
      "--json",
    );
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toEqual({
      id: "g",
      kind: "backlog-invariant",
      descendants: ["g/x"],
    });
    expect(await sandbox.exists(".tasks/g/task.md")).toBe(false);

    expect((await sandbox.run("new", "g", "Epic")).code).toBe(0);
    const unscheduled = await sandbox.run(
      "new",
      "h",
      "Later",
      "--backlog",
      "--json",
    );
    expect(unscheduled.code).toBe(0);
    expect(unscheduled.json<TaskWithDerivedJson>()).toMatchObject({
      status: "BACKLOG",
      children: { open: 1, resolved: 1 },
    });
  });

  it("refuses an invalid path, a missing title and a multi-line title as usage", async () => {
    sandbox = await treeSandbox({});
    for (const bad of ["Bad_Path", "a//b", "a/", ".hidden", "x:"]) {
      const result = await sandbox.run("new", bad, "Title", "--json");
      expect(result.code, bad).toBe(2);
    }
    expect((await sandbox.run("new", "a")).code).toBe(2);
    expect((await sandbox.run("new", "a", "two\nlines")).code).toBe(2);
    expect((await sandbox.loadTree()).tasks).toEqual([]);
  });

  it("creates the task in a listed project, qualified by its alias", async () => {
    sandbox = await treeSandbox({});
    const backend = await sandbox.project("backend", "../backend", {
      tasks: { kernel: {} },
    });
    const result = await sandbox.run(
      "new",
      "backend:kernel/tests",
      "Kernel",
      "tests",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>()).toMatchObject({
      id: "backend:kernel/tests",
      parent: "backend:kernel",
      project: "backend",
      status: "TODO",
      path: path.join(backend, ".tasks", "kernel", "tests"),
    });
    const [entry] = await readLog(
      path.join(backend, ".tasks", "kernel", "tests"),
    );
    expect(entry?.text).toBe("new: TODO");
    expect((await sandbox.loadTree()).tasks).toEqual([]);

    const unknown = await sandbox.run("new", "nope:x", "X", "--json");
    expect(unknown.code).toBe(2);
  });

  it("regenerates index.md when the tree has one", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(".tasks/index.md", "stale\n");
    expect((await sandbox.run("new", "a", "Task")).code).toBe(0);
    const index = await sandbox.read(".tasks/index.md");
    expect(index).not.toContain("stale");
    expect(index).toContain("[a](a/)");
  });
});
