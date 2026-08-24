import { describe, expect, it } from "vitest";

import { parseRef } from "../src/core/refs.js";
import { findCycles, wouldCreateCycle } from "../src/core/deps.js";
import type { Task } from "../src/core/task.js";

function task(id: string, depends_on: string[] = []): Task {
  return {
    id,
    phase: "p",
    status: "PENDING",
    depends_on,
    created: "2026-08-21T00:00:00Z",
    updated: "2026-08-21T00:00:00Z",
    claimed_by: null,
    claimed_at: null,
    body: "",
    filePath: `/tmp/.tasks/p/${id}.md`,
    archived: false,
    frontmatterPhase: "p",
    filenameId: id,
  };
}

describe("dependency refs", () => {
  it("parses a bare id as local", () => {
    expect(parseRef("some-task")).toMatchObject({ kind: "local", id: "some-task" });
  });

  it("parses a path-qualified ref as external", () => {
    expect(parseRef("../other-repo:some-task")).toMatchObject({
      kind: "external",
      projectPath: "../other-repo",
      id: "some-task",
    });
  });

  it("splits on the last colon", () => {
    expect(parseRef("../a:b/c:my-task")).toMatchObject({
      kind: "external",
      projectPath: "../a:b/c",
      id: "my-task",
    });
  });

  it("rejects absolute posix paths", () => {
    expect(() => parseRef("/abs/repo:task")).toThrowError(/absolute paths are not allowed/);
  });

  it("rejects windows drive-letter paths", () => {
    expect(() => parseRef("C:\\repo:task")).toThrowError(/absolute paths are not allowed/);
  });

  it("rejects an invalid id", () => {
    expect(() => parseRef("Not_An_Id")).toThrowError(/Invalid task id/);
  });

  it("rejects an empty project path", () => {
    expect(() => parseRef(":task")).toThrowError(/missing project path/);
  });
});

describe("cycle detection", () => {
  it("finds a direct cycle", () => {
    const cycles = findCycles([task("a", ["b"]), task("b", ["a"])]);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("finds a longer cycle", () => {
    const cycles = findCycles([task("a", ["b"]), task("b", ["c"]), task("c", ["a"])]);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("accepts a DAG", () => {
    expect(findCycles([task("a", ["b"]), task("b", ["c"]), task("c")])).toEqual([]);
  });

  it("ignores external refs, which cannot form a local cycle", () => {
    expect(findCycles([task("a", ["../other:a"])])).toEqual([]);
  });

  it("predicts a cycle before it is written", () => {
    const tasks = [task("a", ["b"]), task("b")];
    expect(wouldCreateCycle(tasks, "b", ["a"])).toBe(true);
    expect(wouldCreateCycle(tasks, "b", [])).toBe(false);
  });
});
