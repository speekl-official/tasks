import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../src/core/config.js";
import { renderTaskFile } from "../src/core/frontmatter.js";
import { makeTask } from "../src/core/task.js";
import type { Tree } from "../src/core/tree.js";
import {
  ancestorIdsOf,
  ancestorsOf,
  archivedTaskDir,
  childrenOf,
  descendantsOf,
  findArchivedTask,
  findTask,
  hasLiveTask,
  isGroup,
  isReservedPath,
  loadTree,
  malformedAncestorOf,
  malformedChildrenOf,
  malformedDescendantsOf,
  parentForPath,
  reloadTask,
  resolveTaskArg,
  resolveTaskId,
  taskDir,
  toMalformedJson,
  writeTask,
} from "../src/core/tree.js";
import type { TaskError } from "../src/errors.js";
import { isTaskError } from "../src/errors.js";
import { renderSpec, specFrontmatter } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { makeSandbox } from "./helpers.js";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await makeSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

function ids(list: Array<{ id: string }>): string[] {
  return list.map((entry) => entry.id);
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

const VALID = renderSpec("x", {});

describe("scanning", () => {
  it("finds tasks at any depth, parents through intermediate groups", async () => {
    await sandbox.tree({
      tasks: {
        epic: {},
        "epic/phase/part": {},
        "epic/part2": {},
        "standalone/deep/leaf": {},
      },
    });
    const tree = await sandbox.loadTree();

    expect(ids(tree.tasks)).toEqual([
      "epic",
      "epic/part2",
      "epic/phase/part",
      "standalone/deep/leaf",
    ]);
    expect(tree.tasks.map((task) => task.parent)).toEqual([
      null,
      "epic",
      "epic",
      null,
    ]);
    expect([...tree.groups]).toEqual([
      "epic/phase",
      "standalone",
      "standalone/deep",
    ]);
    expect(tree.malformed).toEqual([]);
  });

  it("builds each task from its directory and manifest", async () => {
    await sandbox.tree({
      tasks: {
        "auth/token-schema": {
          status: "PAUSED",
          assignee: "alice",
          body: "# Design the token schema\n\n## Notes\n",
          extra: { owner_team: "platform" },
        },
      },
    });
    const tree = await sandbox.loadTree();
    const task = findTask(tree, "auth/token-schema");

    expect(task.name).toBe("token-schema");
    expect(task.title).toBe("Design the token schema");
    expect(task.archived).toBe(false);
    expect(task.dir).toBe(path.join(sandbox.tasksDir, "auth", "token-schema"));
    expect(task.file).toBe(path.join(task.dir, "task.md"));
    expect(task.frontmatter.status).toBe("PAUSED");
    expect(task.frontmatter.assignee).toBe("alice");
    expect(task.extra).toEqual([["owner_team", "platform"]]);
    expect(task.body).toBe("# Design the token schema\n\n## Notes");
  });

  it("never scans a task.md under a dot-directory or a non-matching segment", async () => {
    await sandbox.tree({ tasks: { ok: {} } });
    for (const relative of [
      ".tasks/.hidden/x/task.md",
      ".tasks/Upper/task.md",
      ".tasks/Upper/inner/task.md",
      ".tasks/snake_case/task.md",
      ".tasks/dotted.name/task.md",
      ".tasks/-leading/task.md",
      ".tasks/ok/.drafts/y/task.md",
      ".tasks/ok/Bad/z/task.md",
      ".tasks/.locks/task.md",
    ]) {
      await sandbox.write(relative, "not even a manifest");
    }
    const tree = await sandbox.loadTree();

    expect(ids(tree.tasks)).toEqual(["ok"]);
    expect(tree.malformed).toEqual([]);
    expect([...tree.groups]).toEqual([]);
  });

  it("treats names of root files as ordinary away from the root", async () => {
    await sandbox.tree({ tasks: { index: {}, epic: {} } });
    await sandbox.write(".tasks/index.md/task.md", "not scanned");
    await sandbox.write(".tasks/epic/index.md", "# workspace content");
    await sandbox.write(".tasks/epic/config.yml", "statuses: nonsense");
    await sandbox.write(".tasks/epic/README.md", "# workspace content");
    const tree = await sandbox.loadTree();

    expect(ids(tree.tasks)).toEqual(["epic", "index"]);
    expect(tree.malformed).toEqual([]);
  });

  it("reports a malformed manifest instead of skipping it", async () => {
    await sandbox.tree({ tasks: { fine: {} } });
    await sandbox.write(".tasks/broken/task.md", "# no frontmatter\n");
    const tree = await sandbox.loadTree();

    expect(ids(tree.tasks)).toEqual(["fine"]);
    expect(tree.malformed).toHaveLength(1);
    const [broken] = tree.malformed;
    expect(broken).toMatchObject({
      id: "broken",
      path: path.join(sandbox.tasksDir, "broken", "task.md"),
      dir: path.join(sandbox.tasksDir, "broken"),
      parent: null,
      archived: false,
    });
    expect(broken!.message).toContain("does not begin with a `---` line");
    expect(toMalformedJson(broken!)).toEqual({
      path: broken!.path,
      message: broken!.message,
    });
    expect(tree.malformedById.get("broken")).toBe(broken);
    expect(hasLiveTask(tree, "broken")).toBe(true);
    expect(tree.byId.has("broken")).toBe(false);
  });

  it("keeps a malformed manifest as the parent of the tasks beneath it", async () => {
    await sandbox.tree({
      tasks: { "broken/child": {}, "broken/group/grandchild": {} },
    });
    await sandbox.write(".tasks/broken/task.md", "---\nstatus: NOPE\n---\n");
    const tree = await sandbox.loadTree();

    expect(tree.tasks.map((task) => [task.id, task.parent])).toEqual([
      ["broken/child", "broken"],
      ["broken/group/grandchild", "broken"],
    ]);
    expect(tree.malformed[0]!.issues.map((issue) => issue.field)).toEqual([
      "status",
      "created",
      "updated",
    ]);
    expect(ancestorIdsOf(tree, "broken/group/grandchild")).toEqual(["broken"]);
    expect(ancestorsOf(tree, "broken/group/grandchild")).toEqual([]);
    expect(malformedAncestorOf(tree, "broken/child")?.id).toBe("broken");
    expect(childrenOf(tree, "broken").map((task) => task.id)).toEqual([
      "broken/child",
      "broken/group/grandchild",
    ]);
    expect(ids(malformedChildrenOf(tree, null))).toEqual(["broken"]);
  });

  it("treats a group that holds no task as plain content", async () => {
    await sandbox.tree({ tasks: { epic: {} } });
    await sandbox.write(".tasks/epic/screenshots/shot.png", "png");
    await sandbox.write(".tasks/notes/ideas.txt", "ideas");
    const tree = await sandbox.loadTree();

    expect(ids(tree.tasks)).toEqual(["epic"]);
    expect(childrenOf(tree, "epic")).toEqual([]);
    expect(descendantsOf(tree, "epic")).toEqual([]);
    expect(isGroup(tree, "epic/screenshots")).toBe(true);
    expect(isGroup(tree, "notes")).toBe(true);
  });

  it("records which workspace files exist", async () => {
    await sandbox.tree({
      tasks: {
        a: { state: true, plan: "# Plan\n" },
        b: { design: true, log: "" },
      },
    });
    await fs.mkdir(path.join(sandbox.tasksDir, "b", "state.md"));
    const tree = await sandbox.loadTree();

    expect(findTask(tree, "a").workspace).toEqual({
      state: true,
      design: false,
      plan: true,
      log: false,
    });
    expect(findTask(tree, "b").workspace).toEqual({
      state: false,
      design: true,
      plan: false,
      log: true,
    });
  });

  it("reads a group wider than one read batch", async () => {
    const tasks: Record<string, object> = {};
    for (let n = 0; n < 70; n += 1) tasks[`wide/t${n}`] = {};
    await sandbox.tree({ tasks });
    await sandbox.write(".tasks/wide/t35/task.md", "broken");
    const tree = await sandbox.loadTree();

    expect(tree.tasks).toHaveLength(69);
    expect(ids(tree.malformed)).toEqual(["wide/t35"]);
    expect(tree.tasks.every((task) => task.parent === null)).toBe(true);
  });

  it("reports a task.md placed directly in .tasks/ as malformed", async () => {
    await sandbox.tree({ tasks: { a: {} } });
    await sandbox.write(".tasks/task.md", VALID);
    const tree = await sandbox.loadTree();

    expect(tree.malformed).toHaveLength(1);
    expect(tree.malformed[0]).toMatchObject({
      id: "",
      path: path.join(sandbox.tasksDir, "task.md"),
    });
    expect(tree.malformedById.size).toBe(0);
    expect(findTask(tree, "a").parent).toBeNull();
  });

  it("scans .archive/ with the same rules", async () => {
    await sandbox.tree({
      tasks: { live: {} },
      archived: {
        "old/epic": { status: "DONE" },
        "old/epic/part": { status: "CANCELLED" },
      },
    });
    await sandbox.write(".tasks/.archive/former/notes.txt", "a former path");
    await sandbox.write(".tasks/.archive/.hidden/x/task.md", VALID);
    await sandbox.write(".tasks/.archive/Bad/task.md", VALID);
    const tree = await sandbox.loadTree();

    expect(ids(tree.tasks)).toEqual(["live"]);
    expect(ids(tree.archived)).toEqual(["old/epic", "old/epic/part"]);
    const part = tree.archivedById.get("old/epic/part")!;
    expect(part.archived).toBe(true);
    expect(part.parent).toBe("old/epic");
    expect(part.dir).toBe(
      path.join(sandbox.tasksDir, ".archive", "old", "epic", "part"),
    );
    expect(tree.byId.has("old/epic")).toBe(false);
    expect(isReservedPath(tree, "old/epic")).toBe(true);
    expect(isReservedPath(tree, "old")).toBe(false);
    expect(isReservedPath(tree, "former")).toBe(false);
    expect(isGroup(tree, "old")).toBe(false);
    expect(tree.archivedMalformed).toEqual([]);
  });

  it("keeps a malformed archived manifest reserving its path", async () => {
    await sandbox.tree({});
    await sandbox.write(".tasks/.archive/gone/task.md", "garbage");
    const tree = await sandbox.loadTree();

    expect(tree.malformed).toEqual([]);
    expect(ids(tree.archivedMalformed)).toEqual(["gone"]);
    expect(tree.archivedMalformed[0]!.archived).toBe(true);
    expect(isReservedPath(tree, "gone")).toBe(true);
  });

  it("refuses a v1 tree and names the upgrade", async () => {
    await sandbox.write(".tasks/config.yml", "version: 1\n");
    const err = await caughtAsync(sandbox.loadTree());
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain("tasks migrate");
  });

  it("uses a configuration the caller already loaded", async () => {
    await sandbox.tree({ tasks: { a: {} } });
    const config = { ...defaultConfig(), scope: "a" };
    const tree = await loadTree(sandbox.local, { config });
    expect(tree.config).toBe(config);
  });
});

describe("lookup", () => {
  let tree: Tree;

  beforeEach(async () => {
    await sandbox.tree({
      tasks: {
        "auth/tests": {},
        "billing/tests": {},
        "auth/token-schema": {},
        deploy: {},
      },
      archived: { "old/retired": { status: "DONE" } },
    });
    await sandbox.write(".tasks/auth/broken/task.md", "nope");
    tree = await sandbox.loadTree();
  });

  it("finds a task by its exact id", () => {
    expect(findTask(tree, "auth/tests").id).toBe("auth/tests");
  });

  it("is not-found, flagged archived, for a path only .archive/ holds", () => {
    const err = caught(() => findTask(tree, "old/retired"));
    expect(err.exitCode).toBe(3);
    expect(err.details).toEqual({ id: "old/retired", archived: true });
  });

  it("is not-found for a path nothing holds", () => {
    const err = caught(() => findTask(tree, "nothing/here"));
    expect(err.exitCode).toBe(3);
    expect(err.details).toEqual({ id: "nothing/here" });
  });

  it("is a conflict for a malformed manifest, naming the file", () => {
    const err = caught(() => findTask(tree, "auth/broken"));
    expect(err.exitCode).toBe(4);
    expect(err.details).toMatchObject({
      id: "auth/broken",
      kind: "malformed",
      path: path.join(sandbox.tasksDir, "auth", "broken", "task.md"),
    });
  });

  it("resolves a command-line argument by the suffix rule", () => {
    expect(resolveTaskArg(tree, "token-schema").id).toBe("auth/token-schema");
    expect(resolveTaskArg(tree, "auth/tests").id).toBe("auth/tests");
    expect(resolveTaskId(tree, "broken")).toBe("auth/broken");
  });

  it("refuses an ambiguous suffix, naming the candidates", () => {
    const err = caught(() => resolveTaskArg(tree, "tests"));
    expect(err.exitCode).toBe(2);
    expect(err.details).toEqual({
      argument: "tests",
      candidates: ["auth/tests", "billing/tests"],
    });
  });

  it("says when an unmatched argument names an archived task", () => {
    const err = caught(() => resolveTaskArg(tree, "retired"));
    expect(err.exitCode).toBe(3);
    expect(err.details).toEqual({
      argument: "retired",
      id: "old/retired",
      archived: true,
    });
  });

  it("is not-found for an argument nothing matches", () => {
    expect(caught(() => resolveTaskArg(tree, "nope")).exitCode).toBe(3);
  });

  it("finds an archived task by its exact path", () => {
    expect(findArchivedTask(tree, "old/retired").archived).toBe(true);
    expect(caught(() => findArchivedTask(tree, "retired")).exitCode).toBe(3);
  });

  it("maps ids to native directories", () => {
    expect(taskDir(tree, "a/b")).toBe(path.join(sandbox.tasksDir, "a", "b"));
    expect(archivedTaskDir(tree, "a/b")).toBe(
      path.join(sandbox.tasksDir, ".archive", "a", "b"),
    );
  });

  it("answers path questions over the snapshot", () => {
    expect(hasLiveTask(tree, "deploy")).toBe(true);
    expect(hasLiveTask(tree, "auth")).toBe(false);
    expect(isGroup(tree, "auth")).toBe(true);
    expect(isGroup(tree, "deploy")).toBe(false);
    expect(isReservedPath(tree, "old/retired")).toBe(true);
    expect(isReservedPath(tree, "deploy")).toBe(false);
  });
});

describe("containment", () => {
  let tree: Tree;

  beforeEach(async () => {
    await sandbox.tree({
      tasks: {
        epic: {},
        "epic/a": {},
        "epic/a/x": {},
        "epic/g/b": {},
        "epic/g/b/y": {},
        other: {},
      },
      archived: { old: { status: "DONE" }, "old/part": { status: "DONE" } },
    });
    await sandbox.write(".tasks/epic/g/broken/task.md", "nope");
    tree = await sandbox.loadTree();
  });

  it("lists children through groups, top-level tasks for null", () => {
    expect(ids(childrenOf(tree, "epic"))).toEqual(["epic/a", "epic/g/b"]);
    expect(ids(childrenOf(tree, null))).toEqual(["epic", "other"]);
    expect(ids(malformedChildrenOf(tree, "epic"))).toEqual(["epic/g/broken"]);
  });

  it("lists descendants in tree order or deepest first", () => {
    expect(ids(descendantsOf(tree, "epic"))).toEqual([
      "epic/a",
      "epic/a/x",
      "epic/g/b",
      "epic/g/b/y",
    ]);
    expect(ids(descendantsOf(tree, "epic", { deepestFirst: true }))).toEqual([
      "epic/g/b/y",
      "epic/a/x",
      "epic/g/b",
      "epic/a",
    ]);
    expect(ids(malformedDescendantsOf(tree, "epic"))).toEqual([
      "epic/g/broken",
    ]);
    expect(descendantsOf(tree, "epic/a/x")).toEqual([]);
  });

  it("lists ancestors nearest first", () => {
    expect(ids(ancestorsOf(tree, "epic/g/b/y"))).toEqual(["epic/g/b", "epic"]);
    expect(ancestorIdsOf(tree, "epic/g/b/y")).toEqual(["epic/g/b", "epic"]);
    expect(ancestorsOf(tree, "epic")).toEqual([]);
    expect(malformedAncestorOf(tree, "epic/g/b/y")).toBeNull();
  });

  it("finds the parent a new task at a path would get", () => {
    expect(parentForPath(tree, "epic/g/new")).toBe("epic");
    expect(parentForPath(tree, "epic/g/b/new/deeper")).toBe("epic/g/b");
    expect(parentForPath(tree, "epic/g/broken/new")).toBe("epic/g/broken");
    expect(parentForPath(tree, "fresh")).toBeNull();
  });

  it("walks the archive on request", () => {
    expect(ids(childrenOf(tree, "old", { archived: true }))).toEqual([
      "old/part",
    ]);
    expect(ids(ancestorsOf(tree, "old/part", { archived: true }))).toEqual([
      "old",
    ]);
    expect(ids(descendantsOf(tree, "old", { archived: true }))).toEqual([
      "old/part",
    ]);
    expect(parentForPath(tree, "old/part/new", { archived: true })).toBe(
      "old/part",
    );
  });
});

describe("reading and writing one task", () => {
  it("reloads a task from disk without touching the snapshot", async () => {
    await sandbox.tree({ tasks: { epic: {}, "epic/g/part": {} } });
    const tree = await sandbox.loadTree();
    await sandbox.write(
      ".tasks/epic/g/part/task.md",
      renderSpec("epic/g/part", { status: "DONE" }),
    );
    await sandbox.write(".tasks/epic/g/part/state.md", "## Done\n");

    const fresh = await reloadTask(tree, "epic/g/part");
    expect(fresh.frontmatter.status).toBe("DONE");
    expect(fresh.parent).toBe("epic");
    expect(fresh.workspace.state).toBe(true);
    expect(findTask(tree, "epic/g/part").frontmatter.status).toBe("TODO");
  });

  it("reloads an archived task on request", async () => {
    await sandbox.tree({ archived: { old: { status: "DONE" } } });
    const tree = await sandbox.loadTree();
    const task = await reloadTask(tree, "old", { archived: true });
    expect(task.archived).toBe(true);
    expect(task.frontmatter.status).toBe("DONE");
  });

  it("is not-found when the task vanished and a conflict when it broke", async () => {
    await sandbox.tree({ tasks: { a: {}, b: {} } });
    const tree = await sandbox.loadTree();
    await fs.rm(path.join(sandbox.tasksDir, "a"), { recursive: true });
    await sandbox.write(".tasks/b/task.md", "broken now");

    expect((await caughtAsync(reloadTask(tree, "a"))).exitCode).toBe(3);
    const err = await caughtAsync(reloadTask(tree, "b"));
    expect(err.exitCode).toBe(4);
    expect(err.details).toMatchObject({ id: "b", kind: "malformed" });
  });

  it("writes canonically, keeps unknown keys, and rewrites identically", async () => {
    await sandbox.tree({
      tasks: { a: { extra: { meta: { team: "core", tags: ["x", "y"] } } } },
    });
    const tree = await sandbox.loadTree();
    const task = findTask(tree, "a");
    const changed = {
      ...task,
      frontmatter: {
        ...task.frontmatter,
        status: "DONE" as const,
        updated: "2026-02-01T00:00:00Z",
      },
    };

    await writeTask(changed);
    const written = await sandbox.read(".tasks/a/task.md");
    expect(written).toBe(
      renderTaskFile(changed.frontmatter, changed.extra, changed.body),
    );
    // `y` is a YAML 1.1 boolean, so it is quoted to stay a string everywhere.
    expect(written).toContain('meta: {team: core, tags: [x, "y"]}');

    const reread = findTask(await sandbox.loadTree(), "a");
    expect(reread.frontmatter).toEqual(changed.frontmatter);
    expect(reread.extra).toEqual(task.extra);
    await writeTask(reread);
    expect(await sandbox.read(".tasks/a/task.md")).toBe(written);
    expect(await fs.readdir(task.dir)).toEqual(["task.md"]);
  });

  it("creates the group directories of a new task on demand", async () => {
    await sandbox.tree({});
    const tree = await sandbox.loadTree();
    const id = "new-epic/phase/first";
    await writeTask(
      makeTask({
        id,
        dir: taskDir(tree, id),
        archived: false,
        parent: parentForPath(tree, id),
        frontmatter: specFrontmatter({}),
        body: "# First\n",
      }),
    );

    const after = await sandbox.loadTree();
    expect(findTask(after, id).title).toBe("First");
    expect([...after.groups]).toEqual(["new-epic", "new-epic/phase"]);
  });
});
