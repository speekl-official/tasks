import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedArchiveJson } from "../src/core/archive.js";
import { formatIso } from "../src/core/time.js";
import type { TaskWithDerivedJson } from "../src/core/types.js";
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

interface ArchiveJson {
  id: string;
  path: string;
  tasks: string[];
  left_blocked: string[];
}

interface PurgeJson {
  id: string;
  path: string;
  removed: string[];
  referenced_by: string[];
}

function errorOf(result: CliResult): ErrorJson["error"] {
  return result.json<ErrorJson>().error;
}

async function box(spec: TreeSpec): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

function archived(s: Sandbox, id: string): string {
  return path.join(s.tasksDir, ".archive", ...id.split("/"));
}

describe("archive", () => {
  it("refuses a task that is not resolved", async () => {
    const s = await box({ tasks: { a: { status: "PAUSED" } } });
    const result = await s.run("archive", "a", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      id: "a",
      kind: "not-resolved",
      status: "PAUSED",
    });
    expect(await s.exists(".tasks/a/task.md")).toBe(true);
  });

  it("refuses a resolved task with an open or unreadable descendant, naming it", async () => {
    const s = await box({
      tasks: {
        e: { status: "DONE" },
        "e/open": {},
        "e/fine": { status: "DONE" },
      },
    });
    await s.write(".tasks/e/broken/task.md", "garbage\n");
    const result = await s.run("archive", "e", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      kind: "open-descendants",
      open_descendants: ["e/broken", "e/open"],
    });
    expect(await s.exists(".tasks/.archive")).toBe(false);
  });

  it("refuses while live tasks reference the subtree, naming them across trees", async () => {
    const s = await box({
      tasks: {
        d: { status: "DONE" },
        "d/part": { status: "DONE" },
        // Inside the subtree: archived along, so not a dependent.
        "d/inner": { status: "DONE", finishes_after: ["d/part"] },
        x: { depends_on: ["d/part"] },
        // Resolved: nothing is left to block, so not a dependent either.
        done: { status: "DONE", finishes_after: ["d"] },
      },
    });
    await s.project("backend", "../backend", {
      tasks: { y: { depends_on: ["../repo:d"] } },
    });
    const result = await s.run("archive", "d", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toEqual({
      id: "d",
      kind: "dependents",
      dependents: ["x", "backend:y"],
    });
    expect(await s.exists(".tasks/d/task.md")).toBe(true);
  });

  it("says on stderr when a manifest could not be read: its references are unknown", async () => {
    const s = await box({ tasks: { d: { status: "DONE" } } });
    await s.write(".tasks/broken/task.md", "garbage\n");
    const result = await s.run("archive", "d", "--json");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("could not be read");
    expect(result.stderr).toContain(path.join("broken", "task.md"));
  });

  it("archives anyway with --force, reporting who is left blocked", async () => {
    const s = await box({
      tasks: {
        d: { status: "DONE" },
        "d/part": { status: "CANCELLED" },
        x: { depends_on: ["d/part"] },
      },
    });
    await s.project("backend", "../backend", {
      tasks: { y: { depends_on: ["../repo:d"] } },
    });
    const result = await s.run("archive", "d", "--force", "--json");
    expect(result.code).toBe(0);
    expect(result.json<ArchiveJson>()).toEqual({
      id: "d",
      path: archived(s, "d"),
      tasks: ["d", "d/part"],
      left_blocked: ["x", "backend:y"],
    });
    // The entry was written before the move, so it travelled with the task.
    const entries = await readLog(archived(s, "d"));
    expect(entries.at(-1)?.text).toBe(
      "archive (forced)\nleft blocked: x, backend:y",
    );
    const blocked = await s.run("dep", "list", "x", "--json");
    expect(blocked.json<{ refs: Array<{ reason: string }> }>().refs).toEqual([
      expect.objectContaining({ reason: "archived" }),
    ]);
  });

  it("moves the subtree with its workspace under .archive/ and removes emptied groups", async () => {
    const s = await box({
      tasks: {
        "g/t": { status: "DONE", state: true, design: true },
        "g/t/sub": { status: "DONE" },
        "h/t": { status: "DONE" },
        "h/u": {},
      },
    });
    await s.write(".tasks/g/t/notes.txt", "workspace\n");

    const result = await s.run("archive", "g/t", "--json");
    expect(result.code).toBe(0);
    expect(result.json<ArchiveJson>()).toEqual({
      id: "g/t",
      path: archived(s, "g/t"),
      tasks: ["g/t", "g/t/sub"],
      left_blocked: [],
    });
    for (const file of [
      "task.md",
      "state.md",
      "design.md",
      "notes.txt",
      "sub/task.md",
    ]) {
      expect(await s.exists(`.tasks/.archive/g/t/${file}`), file).toBe(true);
    }
    expect(await s.exists(".tasks/g")).toBe(false);
    const [entry] = await readLog(archived(s, "g/t"));
    expect(entry).toMatchObject({ actor: "tester", text: "archive" });

    // A group that still holds a task stays.
    expect((await s.run("archive", "h/t")).code).toBe(0);
    expect(await s.exists(".tasks/h/u/task.md")).toBe(true);

    const tree = await s.loadTree();
    expect([...tree.archivedById.keys()]).toEqual(["g/t", "g/t/sub", "h/t"]);
  });

  it("prints the destination and what moved with the task", async () => {
    const s = await box({
      tasks: { e: { status: "DONE" }, "e/c": { status: "DONE" } },
    });
    const result = await s.run("archive", "e");
    expect(result.code).toBe(0);
    const text = stripVTControlCharacters(result.stdout);
    expect(text).toContain("✓ archive e → ");
    expect(text).toContain("with e/c");
  });

  it("merges into the archive path a descendant was archived to", async () => {
    const s = await box({
      tasks: { e: { status: "DONE" }, "e/c": { status: "DONE" } },
    });
    expect((await s.run("archive", "e/c")).code).toBe(0);
    expect(await s.exists(".tasks/e/c")).toBe(false);

    const result = await s.run("archive", "e", "--json");
    expect(result.code).toBe(0);
    expect(result.json<ArchiveJson>().tasks).toEqual(["e"]);
    expect(await s.exists(".tasks/.archive/e/task.md")).toBe(true);
    expect(await s.exists(".tasks/.archive/e/c/task.md")).toBe(true);
    expect(await s.exists(".tasks/e")).toBe(false);
  });

  it("refuses a task.md present on both sides, moving nothing", async () => {
    const s = await box({
      tasks: { a: { status: "DONE" } },
      archived: { a: { status: "DONE" } },
    });
    const result = await s.run("archive", "a", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      id: "a",
      kind: "duplicate",
      paths: ["task.md"],
    });
    expect(await s.exists(".tasks/a/task.md")).toBe(true);
    expect(await s.exists(".tasks/a/log.md")).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "takes the archive entry back when the move fails",
    async () => {
      const s = await box({
        tasks: {
          a: {
            status: "DONE",
            log: "## 2026-01-01T00:00:00Z tester\nnew: TODO\n",
          },
          b: { status: "DONE" },
        },
      });
      const archive = path.join(s.tasksDir, ".archive");
      await fs.mkdir(archive);
      await fs.chmod(archive, 0o555);
      try {
        const result = await s.run("archive", "a", "--json");
        expect(result.code).toBe(1);
        expect(await s.read(".tasks/a/log.md")).toBe(
          "## 2026-01-01T00:00:00Z tester\nnew: TODO\n",
        );
        expect((await s.run("archive", "b")).code).toBe(1);
        expect(await s.exists(".tasks/b/log.md")).toBe(false);
      } finally {
        await fs.chmod(archive, 0o755);
      }
      expect(await s.exists(".tasks/a/task.md")).toBe(true);
    },
  );

  it("keeps the archived path reserved for new until it is purged", async () => {
    const s = await box({ tasks: { "g/t": { status: "DONE" } } });
    expect((await s.run("archive", "t")).code).toBe(0);
    const again = await s.run("new", "g/t", "Again", "--json");
    expect(again.code).toBe(4);
    expect(errorOf(again).message).toContain("tasks purge g/t");
  });

  it("archives in a listed project, refusing while the local tree references it", async () => {
    const s = await box({ tasks: { x: { depends_on: ["../backend:k"] } } });
    const backend = await s.project("backend", "../backend", {
      tasks: { k: { status: "DONE" } },
    });
    const refused = await s.run("archive", "backend:k", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toMatchObject({
      id: "backend:k",
      dependents: ["x"],
    });

    const forced = await s.run("archive", "backend:k", "--force", "--json");
    expect(forced.code).toBe(0);
    expect(forced.json<ArchiveJson>()).toEqual({
      id: "backend:k",
      path: path.join(backend, ".tasks", ".archive", "k"),
      tasks: ["backend:k"],
      left_blocked: ["x"],
    });
  });
});

describe("restore", () => {
  it("moves the archived subtree back, logs it, and tidies the archive", async () => {
    const s = await box({
      archived: { e: { status: "DONE" }, "e/c": { status: "DONE" } },
    });
    const result = await s.run("restore", "e", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>()).toMatchObject({
      id: "e",
      status: "DONE",
      situation: "done",
      children: { open: 0, resolved: 1 },
      path: path.join(s.tasksDir, "e"),
    });
    expect(await s.exists(".tasks/e/c/task.md")).toBe(true);
    expect(await s.exists(".tasks/.archive")).toBe(false);
    const entries = await readLog(path.join(s.tasksDir, "e"));
    expect(entries.at(-1)?.text).toBe("restore");

    const human = await s.run("archive", "e");
    expect(human.code).toBe(0);
    const again = await s.run("restore", "e");
    expect(stripVTControlCharacters(again.stdout)).toContain("✓ restore e");
  });

  it("restores one archived descendant under its open parent", async () => {
    const s = await box({
      tasks: { e: {} },
      archived: { "e/c": { status: "DONE" } },
    });
    const result = await s.run("restore", "e/c", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>()).toMatchObject({
      id: "e/c",
      parent: "e",
    });
  });

  it("never restores under a resolved parent", async () => {
    const s = await box({
      tasks: { e: { status: "DONE" } },
      archived: { "e/c": { status: "DONE" } },
    });
    const result = await s.run("restore", "e/c", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      kind: "resolved-ancestor",
      ancestor: "e",
    });
    expect(await s.exists(".tasks/.archive/e/c/task.md")).toBe(true);
  });

  it("addresses the archive in full: a suffix or a missing entry is not found", async () => {
    const s = await box({ archived: { "e/c": { status: "DONE" } } });
    expect((await s.run("restore", "c")).code).toBe(3);
    expect((await s.run("restore", "nope")).code).toBe(3);
    // A directory that only carries a former path holds no task to restore.
    expect((await s.run("restore", "e")).code).toBe(3);
  });

  it("refuses a path where a live task is", async () => {
    const s = await box({
      tasks: { a: {} },
      archived: { a: { status: "DONE" } },
    });
    const result = await s.run("restore", "a", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({ kind: "exists" });
  });

  it("merges into a group at its path, which becomes the task again", async () => {
    const s = await box({
      tasks: { "e/old": { status: "DONE" } },
      archived: { e: { status: "DONE" } },
    });
    const result = await s.run("restore", "e", "--json");
    expect(result.code).toBe(0);
    const tree = await s.loadTree();
    expect(tree.byId.get("e/old")?.parent).toBe("e");
    expect(tree.groups.has("e")).toBe(false);
  });

  it("refuses a merge that leaves open work under a resolved task", async () => {
    const s = await box({
      tasks: { "e/new": {} },
      archived: { e: { status: "DONE" } },
    });
    const result = await s.run("restore", "e", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      kind: "open-under-resolved",
      task: "e/new",
      ancestor: "e",
    });
    expect(await s.exists(".tasks/.archive/e/task.md")).toBe(true);
    expect(await s.exists(".tasks/e/task.md")).toBe(false);
  });

  it("refuses a merge in which a task would exist twice", async () => {
    const s = await box({
      tasks: { "e/x": { status: "DONE" } },
      archived: { e: { status: "DONE" }, "e/x": { status: "DONE" } },
    });
    const result = await s.run("restore", "e", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toMatchObject({
      kind: "duplicate",
      paths: ["x/task.md"],
    });
    expect(await s.exists(".tasks/.archive/e/task.md")).toBe(true);
  });
});

describe("purge", () => {
  it("removes the entry for good, names the referrers and releases the path", async () => {
    const s = await box({
      tasks: { x: { depends_on: ["a"] }, y: { finishes_after: ["a/sub"] } },
      archived: { a: { status: "DONE" }, "a/sub": { status: "DONE" } },
    });
    const result = await s.run("purge", "a", "--json");
    expect(result.code).toBe(0);
    expect(result.json<PurgeJson>()).toEqual({
      id: "a",
      path: archived(s, "a"),
      removed: ["a", "a/sub"],
      referenced_by: ["x", "y"],
    });
    expect(await s.exists(".tasks/.archive")).toBe(false);

    const recreated = await s.run("new", "a", "Again");
    expect(recreated.code).toBe(0);
  });

  it("removes a directory that only carries a former path", async () => {
    const s = await box({ archived: { "g/t": { status: "DONE" } } });
    const result = await s.run("purge", "g");
    expect(result.code).toBe(0);
    expect(stripVTControlCharacters(result.stdout)).toContain(
      "✓ purge g: removed g/t",
    );
    expect(await s.exists(".tasks/.archive")).toBe(false);
  });

  it("keeps the rest of the archive", async () => {
    const s = await box({
      archived: { "g/t": { status: "DONE" }, "g/u": { status: "DONE" } },
    });
    expect((await s.run("purge", "g/t")).code).toBe(0);
    expect(await s.exists(".tasks/.archive/g/u/task.md")).toBe(true);
  });

  it("is not found where nothing is archived", async () => {
    const s = await box({ tasks: { a: { status: "DONE" } } });
    expect((await s.run("purge", "a")).code).toBe(3);
    expect((await s.run("purge", "Bad_Path")).code).toBe(2);
  });
});

describe("delete", () => {
  it("removes a task that was never worked, and the groups it empties", async () => {
    const s = await box({});
    expect((await s.run("new", "g/t", "Typo")).code).toBe(0);
    const result = await s.run("delete", "t", "--json");
    expect(result.code).toBe(0);
    expect(result.json()).toEqual({ id: "g/t", deleted: true });
    expect(await s.exists(".tasks/g")).toBe(false);

    expect((await s.run("new", "u", "Typo")).code).toBe(0);
    const human = await s.run("delete", "u");
    expect(stripVTControlCharacters(human.stdout)).toContain("✓ delete u");
  });

  it("refuses a task with a history, a resume point, anything beneath it or a referrer", async () => {
    const s = await box({
      tasks: {
        st: { state: true },
        scribbled: { log: "notes written by hand\n" },
        p: {},
        "p/c": {},
        target: {},
        user: { depends_on: ["target"] },
      },
      groups: ["q/screens"],
    });
    await s.write(".tasks/q/task.md", await s.read(".tasks/target/task.md"));
    expect((await s.run("new", "hist", "Worked")).code).toBe(0);
    expect((await s.run("log", "hist", "Started looking")).code).toBe(0);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["hist", { kind: "history", entries: 2 }],
      ["scribbled", { kind: "history", entries: 0 }],
      ["st", { kind: "present-state" }],
      ["p", { kind: "descendants", descendants: ["p/c"] }],
      ["q", { kind: "descendants", descendants: ["q/screens"] }],
      ["target", { kind: "dependents", dependents: ["user"] }],
    ];
    for (const [id, details] of cases) {
      const result = await s.run("delete", id, "--json");
      expect(result.code, id).toBe(4);
      const error = errorOf(result);
      expect(error.details, id).toMatchObject({
        id,
        alternative: "archive",
        ...details,
      });
      expect(error.message, id).toContain("tasks archive");
      expect(await s.exists(`.tasks/${id}/task.md`), id).toBe(true);
    }
  });

  it("is authorized like a transition", async () => {
    const s = await box({ tasks: { a: { assignee: "alice" } } });
    const refused = await s.run("delete", "a", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toMatchObject({ assignee: "alice" });
    expect((await s.run("delete", "a", "--force")).code).toBe(0);
    expect(await s.exists(".tasks/a")).toBe(false);
  });
});

describe("archive --resolved-before and --all-resolved", () => {
  // Fixture tasks are stamped 2026-01-01 unless said otherwise: old enough.
  const RECENT = formatIso(new Date());

  it("archives the resolved subtrees older than the threshold and lists the roots a refusal kept", async () => {
    const s = await box({
      tasks: {
        old: { status: "DONE" },
        "old/part": { status: "CANCELLED" },
        fresh: { status: "DONE", updated: RECENT },
        held: { status: "DONE" },
        user: { depends_on: ["held"] },
        epic: {},
        // Resolved under an open parent: a root of its own.
        "epic/done": { status: "DONE" },
        "epic/todo": {},
      },
    });
    const result = await s.run("archive", "--resolved-before", "30d", "--json");
    expect(result.code).toBe(0);
    expect(result.json<ResolvedArchiveJson>()).toEqual({
      before: expect.stringMatching(/Z$/),
      archived: [
        {
          id: "epic/done",
          path: archived(s, "epic/done"),
          tasks: ["epic/done"],
          left_blocked: [],
        },
        {
          id: "old",
          path: archived(s, "old"),
          tasks: ["old", "old/part"],
          left_blocked: [],
        },
      ],
      skipped: [{ id: "held", reason: "dependents", dependents: ["user"] }],
    });
    expect(await s.exists(".tasks/fresh/task.md")).toBe(true);
    expect(await s.exists(".tasks/held/task.md")).toBe(true);
    expect(await s.exists(".tasks/old")).toBe(false);
    expect(await s.exists(".tasks/epic/done")).toBe(false);
    expect(await s.exists(".tasks/epic/todo/task.md")).toBe(true);
  });

  it("takes every resolved subtree with --all-resolved, and the configured days without a value", async () => {
    const s = await box({
      tasks: { a: { status: "DONE", updated: RECENT }, b: { status: "DONE" } },
    });
    const bare = await s.run("archive", "--resolved-before", "--json");
    expect(bare.code).toBe(2);
    expect(errorOf(bare).details).toMatchObject({
      key: "archive_resolved_after_days",
    });

    await s.write(
      ".tasks/config.yml",
      "version: 2\narchive_resolved_after_days: 30\n",
    );
    const configured = await s.run("archive", "--resolved-before", "--json");
    expect(configured.code).toBe(0);
    expect(
      configured.json<ResolvedArchiveJson>().archived.map((entry) => entry.id),
    ).toEqual(["b"]);

    const all = await s.run("archive", "--all-resolved", "--json");
    expect(all.code).toBe(0);
    expect(all.json<ResolvedArchiveJson>()).toMatchObject({
      before: null,
      archived: [expect.objectContaining({ id: "a" })],
      skipped: [],
    });
  });

  it("refuses a task beside a batch option, no task without one, both options, and --force", async () => {
    const s = await box({ tasks: { a: { status: "DONE" } } });
    for (const argv of [
      ["archive", "a", "--all-resolved"],
      ["archive"],
      ["archive", "--all-resolved", "--resolved-before", "1d"],
      ["archive", "--all-resolved", "--force"],
      ["archive", "--resolved-before", "yesterday"],
    ]) {
      const result = await s.run(...argv, "--json");
      expect({ argv, code: result.code }).toEqual({ argv, code: 2 });
    }
    expect(await s.exists(".tasks/a/task.md")).toBe(true);
  });

  it("prints what it archived and what it skipped", async () => {
    const s = await box({
      tasks: {
        old: { status: "DONE" },
        "old/x": { status: "DONE" },
        held: { status: "DONE" },
        user: { depends_on: ["held"] },
      },
    });
    const out = stripVTControlCharacters(
      (await s.run("archive", "--all-resolved")).stdout,
    );
    expect(out).toContain("✓ archive 1 resolved subtree (2 tasks)");
    expect(out).toContain("  old with old/x");
    expect(out).toContain("skipped held: referenced by user");

    const again = stripVTControlCharacters(
      (await s.run("archive", "--all-resolved")).stdout,
    );
    expect(again).toContain("Nothing archived.");
    expect(again).toContain("skipped held");
  });
});
