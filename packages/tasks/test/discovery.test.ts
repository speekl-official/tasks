import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findProject, requireProject } from "../src/core/discovery.js";
import { isTaskError } from "../src/errors.js";
import type { Sandbox } from "./helpers.js";
import { makeSandbox } from "./helpers.js";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await makeSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

describe("discovery", () => {
  it("finds the tree in the start directory", async () => {
    await sandbox.initV2();
    expect(await findProject(sandbox.dir)).toEqual({
      root: sandbox.dir,
      tasksDir: sandbox.tasksDir,
    });
  });

  it("walks up from a subdirectory", async () => {
    await sandbox.initV2();
    const deep = path.join(sandbox.dir, "src", "deep");
    await fs.mkdir(deep, { recursive: true });
    expect((await findProject(deep))?.root).toBe(sandbox.dir);
  });

  it("stops at the nearest tree without merging trees above it", async () => {
    await sandbox.initV2();
    await sandbox.write("packages/web/.tasks/config.yml", "version: 2\n");
    const nested = path.join(sandbox.dir, "packages", "web", "src");
    await fs.mkdir(nested, { recursive: true });
    expect((await findProject(nested))?.root).toBe(
      path.join(sandbox.dir, "packages", "web"),
    );
  });

  it("starts from any directory the caller names, like -C", async () => {
    await sandbox.project("main", "../main");
    const elsewhere = path.join(sandbox.root, "worktree");
    await fs.mkdir(elsewhere);
    expect((await findProject(path.join(sandbox.root, "main")))?.root).toBe(
      path.join(sandbox.root, "main"),
    );
    expect(await findProject(elsewhere)).toBeNull();
  });

  it("finds nothing from a directory that does not exist", async () => {
    await sandbox.initV2();
    expect(
      await findProject(path.join(sandbox.dir, "not-checked-out")),
    ).toBeNull();
  });

  it("ignores a .tasks that is a file", async () => {
    await sandbox.write(".tasks", "not a directory");
    expect(await findProject(sandbox.dir)).toBeNull();
  });

  it("fails as not-found, pointing at tasks init", async () => {
    try {
      await requireProject(sandbox.dir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isTaskError(err)).toBe(true);
      if (isTaskError(err)) {
        expect(err.exitCode).toBe(3);
        expect(err.message).toContain("tasks init");
        expect(err.details).toEqual({ cwd: sandbox.dir });
      }
    }
  });

  it("names a start directory that does not exist", async () => {
    const missing = path.join(sandbox.dir, "missing");
    await expect(requireProject(missing)).rejects.toMatchObject({
      exitCode: 3,
      message: expect.stringContaining("is not a directory"),
    });
  });
});
