import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  DerivedTask,
  SnapshotTask,
  TreeSnapshot,
} from "../src/core/derive.js";
import { deriveTree } from "../src/core/derive.js";
import {
  indexExists,
  indexPath,
  isIndexStale,
  refreshIndex,
  renderIndex,
  writeIndex,
} from "../src/core/index-md.js";
import type { Tree } from "../src/core/tree.js";
import type { TreeSpec } from "./fixtures.js";
import { writeTaskSpec } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

/**
 * Trivially satisfied gates; derive reads open children from the tree
 * itself. Every claim is live with a heartbeat and every task has a last
 * entry, so a timestamp leaking into the index would show.
 */
function snapshotOf(tree: Tree, start: Record<string, string[]> = {}) {
  const snapshot: TreeSnapshot = {
    tree,
    project: null,
    tasks: tree.tasks.map(
      (task): SnapshotTask => ({
        task,
        project: null,
        start: {
          satisfied: !(task.id in start),
          refs: (start[task.id] ?? []).map((ref) => ({
            ref,
            project: null,
            id: ref,
            satisfied: false,
            reason: "not-done",
            status: "TODO",
          })),
        },
        finish: { satisfied: true, open_children: [], refs: [] },
        liveness:
          task.frontmatter.status === "IN_PROGRESS"
            ? { liveness: "live", last_seen: "2026-09-21T16:40:12Z" }
            : null,
        lastEntry: {
          time: "2026-09-21T16:40:12Z",
          actor: "agent",
          via: null,
          session: "s1",
          text: "note",
        },
      }),
    ),
  };
  return snapshot;
}

async function load(
  start: Record<string, string[]> = {},
  actor: string | null = null,
): Promise<{ tree: Tree; derived: Map<string, DerivedTask> }> {
  const tree = await sandbox!.loadTree();
  return { tree, derived: deriveTree(snapshotOf(tree, start), actor) };
}

const SPEC: TreeSpec = {
  tasks: {
    "auth-rework": { priority: "high", title: "Rework authentication" },
    "auth-rework/audit": { status: "DONE" },
    "auth-rework/token-schema": {
      status: "PAUSED",
      state: true,
      assignee: "alice",
      title: "Design the token schema",
    },
    "auth-rework/phase/impl": {},
    "billing/invoices": {},
    solo: { status: "IN_PROGRESS", claimed_session: "s1" },
    blocked: { depends_on: ["solo"] },
  },
  archived: { "old/thing": { status: "DONE" } },
  groups: ["auth-rework/screenshots", "empty-group"],
};

describe("renderIndex", () => {
  it("nests the tree by containment, one line per task", async () => {
    sandbox = await treeSandbox(SPEC);
    const { tree, derived } = await load({ blocked: ["solo"] });
    const text = renderIndex(tree, derived);

    expect(text.split("\n").slice(0, 3)).toEqual([
      expect.stringMatching(/^<!--.*`tasks reindex`.*-->$/),
      "",
      "# Task index",
    ]);
    expect(text).toContain(
      [
        "- [auth-rework](auth-rework/) — Rework authentication · open 1/3 · high",
        "  - [auth-rework/audit](auth-rework/audit/) — audit · done",
        "  - auth-rework/phase/",
        "    - [auth-rework/phase/impl](auth-rework/phase/impl/) — impl · ready · high (inherited)",
        "  - [auth-rework/token-schema](auth-rework/token-schema/) — Design the token schema · waiting for alice · high (inherited)",
        "- billing/",
        "  - [billing/invoices](billing/invoices/) — invoices · ready",
        "- [blocked](blocked/) — blocked · blocked by solo",
        "- [solo](solo/) — solo · working by tester",
        "",
      ].join("\n"),
    );
    expect(text.endsWith("working by tester\n")).toBe(true);
    expect(text).not.toContain("old/thing");
    expect(text).not.toContain("screenshots");
    expect(text).not.toContain("empty-group");
  });

  it("is free of timestamps, liveness and anything that depends on the actor", async () => {
    sandbox = await treeSandbox(SPEC);
    const { tree, derived } = await load();
    const text = renderIndex(tree, derived);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain("live");
    expect(text).not.toContain("agent");

    const asActor = await load({}, "alice");
    expect(renderIndex(asActor.tree, asActor.derived)).toBe(text);
  });

  it("renders the same bytes twice, and from a fresh read", async () => {
    sandbox = await treeSandbox(SPEC);
    const first = await load();
    const text = renderIndex(first.tree, first.derived);
    expect(renderIndex(first.tree, first.derived)).toBe(text);
    const again = await load();
    expect(renderIndex(again.tree, again.derived)).toBe(text);
  });

  it("shows progress for a parent whose situation does not", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { assignee: "alice" },
        "epic/a": { status: "DONE" },
        "epic/b": {},
        closable: {},
        "closable/a": { status: "CANCELLED" },
      },
    });
    const { tree, derived } = await load();
    const text = renderIndex(tree, derived);
    expect(text).toContain("- [epic](epic/) — epic · assigned alice · 1/2\n");
    expect(text).toContain(
      "- [closable](closable/) — closable · closable · 1/1\n",
    );
  });

  it("lists malformed manifests in place and in a final section", async () => {
    sandbox = await treeSandbox({ tasks: { epic: {}, "broken/part": {} } });
    await sandbox.write(".tasks/epic/bad/task.md", "no frontmatter\n");
    await sandbox.write(".tasks/broken/task.md", "---\nstatus: NOPE\n---\n");
    await sandbox.write(".tasks/task.md", "not a task\n");
    const { tree, derived } = await load();
    const text = renderIndex(tree, derived);

    expect(text).toContain(
      [
        "- [broken](broken/) — malformed task.md, see below",
        "  - [broken/part](broken/part/) — part · held by broken",
        "- [epic](epic/) — epic · open 0/1",
        "  - [epic/bad](epic/bad/) — malformed task.md, see below",
      ].join("\n"),
    );
    const malformed = text.split("## Malformed\n\n")[1]!.trimEnd().split("\n");
    expect(malformed).toHaveLength(3);
    expect(malformed[0]).toMatch(/^- \[task\.md\]\(task\.md\): /);
    expect(malformed[1]).toMatch(
      /^- \[broken\/task\.md\]\(broken\/task\.md\): /,
    );
    expect(malformed[2]).toMatch(
      /^- \[epic\/bad\/task\.md\]\(epic\/bad\/task\.md\): /,
    );
    // No absolute path: the file reads the same in every clone.
    expect(text).not.toContain(sandbox.root);
  });

  it("says so when there are no tasks", async () => {
    sandbox = await treeSandbox({ archived: { gone: { status: "DONE" } } });
    const { tree, derived } = await load();
    expect(renderIndex(tree, derived)).toContain(
      "# Task index\n\n_No tasks yet._\n",
    );
  });
});

describe("the index file", () => {
  it("lives at the root of .tasks/", async () => {
    sandbox = await treeSandbox({});
    const { tree } = await load();
    expect(indexPath(tree)).toBe(path.join(sandbox.tasksDir, "index.md"));
  });

  it("is written atomically by writeIndex", async () => {
    sandbox = await treeSandbox(SPEC);
    const { tree, derived } = await load();
    expect(await indexExists(tree)).toBe(false);
    const file = await writeIndex(tree, derived);
    expect(file).toBe(indexPath(tree));
    expect(await indexExists(tree)).toBe(true);
    expect(await sandbox.read(".tasks/index.md")).toBe(
      renderIndex(tree, derived),
    );
    expect(await fs.readdir(sandbox.tasksDir)).not.toContainEqual(
      expect.stringMatching(/\.tmp$/),
    );
  });

  it("is stale only when it exists and differs from a fresh rendering", async () => {
    sandbox = await treeSandbox(SPEC);
    let { tree, derived } = await load();
    expect(await isIndexStale(tree, derived)).toBe(false);

    await writeIndex(tree, derived);
    expect(await isIndexStale(tree, derived)).toBe(false);

    await writeTaskSpec(sandbox.tasksDir, "new-task", {});
    ({ tree, derived } = await load());
    expect(await isIndexStale(tree, derived)).toBe(true);

    // CRLF from a checkout is not a difference.
    await sandbox.write(
      ".tasks/index.md",
      renderIndex(tree, derived).replace(/\n/g, "\r\n"),
    );
    expect(await isIndexStale(tree, derived)).toBe(false);
  });

  it("is refreshed only where it exists", async () => {
    sandbox = await treeSandbox(SPEC);
    let { tree, derived } = await load();
    expect(await refreshIndex(tree, derived)).toBe(false);
    expect(await sandbox.exists(".tasks/index.md")).toBe(false);

    await sandbox.write(".tasks/index.md", "outdated\n");
    expect(await refreshIndex(tree, derived)).toBe(true);
    expect(await sandbox.read(".tasks/index.md")).toBe(
      renderIndex(tree, derived),
    );

    // Current already: left alone, mtime and all.
    await sandbox.age(".tasks/index.md", 60);
    const before = (await fs.stat(indexPath(tree))).mtimeMs;
    ({ tree, derived } = await load());
    expect(await refreshIndex(tree, derived)).toBe(false);
    expect((await fs.stat(indexPath(tree))).mtimeMs).toBe(before);
  });

  it("is not mistaken for a directory of the same name", async () => {
    sandbox = await treeSandbox({});
    await fs.mkdir(path.join(sandbox.tasksDir, "index.md"));
    const { tree, derived } = await load();
    expect(await indexExists(tree)).toBe(false);
    expect(await refreshIndex(tree, derived)).toBe(false);
  });
});
