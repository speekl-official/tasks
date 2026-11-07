import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GateResolver } from "../src/core/gates.js";
import { Projects } from "../src/core/projects.js";
import {
  refreshIndexFor,
  snapshotAll,
  snapshotTree,
} from "../src/core/snapshot.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

async function source(): Promise<{ projects: Projects; gates: GateResolver }> {
  const projects = new Projects(await sandbox.loadTree());
  return { projects, gates: new GateResolver(projects) };
}

describe("snapshotTree", () => {
  it("composes gates, liveness and the last log entry into derived tasks", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": { status: "DONE" },
        "epic/b": {
          status: "IN_PROGRESS",
          claimed_by: "agent",
          claimed_session: "s1",
          state: true,
          log: "## 2026-01-02T00:00:00Z agent s:s1\nclaim: TODO → IN_PROGRESS\nstarted\n",
        },
        later: { depends_on: ["epic/b"] },
      },
    });
    await sandbox.write(".tasks/.locks/sessions/s1", "");

    const src = await source();
    const { derived } = await snapshotTree(src, src.projects.local, "agent");

    expect(derived.get("epic")?.derived.situation).toBe("open");
    expect(derived.get("epic")?.derived.children).toEqual({
      open: 1,
      resolved: 1,
    });
    expect(derived.get("epic")?.derived.active).toBe(true);

    const b = derived.get("epic/b")!;
    expect(b.derived.situation).toBe("working");
    expect(b.derived.liveness).toBe("live");
    expect(b.derived.last_entry?.text).toContain("claim: TODO → IN_PROGRESS");

    const later = derived.get("later")!;
    expect(later.derived.situation).toBe("blocked");
    expect(later.derived.blocked_by).toEqual([
      { ref: "epic/b", reason: "not-done", status: "IN_PROGRESS" },
    ]);
    expect(later.derived.ready).toBe(false);
  });
});

describe("snapshotAll", () => {
  it("covers the local tree first, then listed trees, qualifying their ids", async () => {
    sandbox = await treeSandbox({
      tasks: { a: {} },
      projects: { backend: "../backend" },
    });
    await sandbox.project("backend", "../backend", { tasks: { x: {} } });

    const all = await snapshotAll(await source(), "agent");
    expect(all.map((d) => d.load.alias)).toEqual([null, "backend"]);
    expect(all[1]!.derived.get("x")?.json.id).toBe("backend:x");

    const local = await snapshotAll(await source(), "agent", { local: true });
    expect(local.map((d) => d.load.alias)).toEqual([null]);
  });
});

describe("refreshIndexFor", () => {
  it("regenerates index.md only when the file exists", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const src = await source();

    expect(await refreshIndexFor(src, src.projects.local)).toBe(false);
    expect(await sandbox.exists(".tasks/index.md")).toBe(false);

    await sandbox.write(".tasks/index.md", "stale\n");
    expect(await refreshIndexFor(src, src.projects.local)).toBe(true);
    const index = await sandbox.read(path.join(".tasks", "index.md"));
    expect(index).toContain("a/");
    expect(index).not.toContain("stale");
  });
});
