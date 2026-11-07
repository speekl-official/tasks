import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/core/config.js";
import { findTask, loadTree } from "../src/core/tree.js";
import { ACTOR_ENV, SESSION_ENV } from "../src/core/types.js";
import { renderSpec } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { makeSandbox } from "./helpers.js";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await makeSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

describe("the sandbox runner", () => {
  it("restores the environment and the cwd after every call", async () => {
    const actor = process.env[ACTOR_ENV];
    const session = process.env[SESSION_ENV];
    const cwd = process.cwd();

    const result = await sandbox.runWith(
      { env: { [ACTOR_ENV]: "someone", [SESSION_ENV]: "s1" }, cwd: "." },
      "--version",
    );
    expect(result.code).toBe(0);
    expect(process.env[ACTOR_ENV]).toBe(actor);
    expect(process.env[SESSION_ENV]).toBe(session);
    expect(process.cwd()).toBe(cwd);
  });

  it("captures stdout and the exit code", async () => {
    const result = await sandbox.run("--version");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("tree fixtures", () => {
  it("writes task files through the canonical serializer", async () => {
    await sandbox.tree({
      tasks: { "epic/part": { status: "IN_PROGRESS", state: true } },
    });
    const source = await sandbox.read(".tasks/epic/part/task.md");
    expect(source).toBe(renderSpec("epic/part", { status: "IN_PROGRESS" }));
    expect(await sandbox.exists(".tasks/epic/part/state.md")).toBe(true);

    const task = findTask(await sandbox.loadTree(), "epic/part");
    expect(task.frontmatter.claimed_by).toBe("tester");
    expect(task.frontmatter.claimed_at).toBe(task.frontmatter.created);
  });

  it("writes an inconsistent claim when asked explicitly", async () => {
    await sandbox.tree({
      tasks: {
        a: { status: "IN_PROGRESS", claimed_by: null, claimed_at: null },
      },
    });
    const task = findTask(await sandbox.loadTree(), "a");
    expect(task.frontmatter.claimed_by).toBeNull();
  });

  it("writes the configuration keys it is given", async () => {
    await sandbox.tree({
      scope: "a",
      session_timeout_minutes: 5,
      tasks: { a: {} },
    });
    expect(await sandbox.read(".tasks/config.yml")).toBe(
      "version: 2\nscope: a\nsession_timeout_minutes: 5\n",
    );
    expect(await sandbox.read(".tasks/.gitignore")).toBe(".locks/\n");
  });

  it("lists a sibling project and gives it a tree of its own", async () => {
    await sandbox.tree({ tasks: { a: {} } });
    const backend = await sandbox.project("backend", "../backend", {
      tasks: { "kernel/tests": { status: "DONE" } },
    });
    expect(backend).toBe(path.join(sandbox.root, "backend"));

    const config = await loadConfig(sandbox.tasksDir);
    expect(config.projects).toEqual({ backend: "../backend" });
    const foreign = await loadTree({
      root: backend,
      tasksDir: path.join(backend, ".tasks"),
    });
    expect(findTask(foreign, "kernel/tests").frontmatter.status).toBe("DONE");
  });

  it("keeps sibling projects inside the sandbox", async () => {
    await expect(sandbox.project("x", "../../escape")).rejects.toThrow(
      /leaves the sandbox/,
    );
  });

  it("writes the minimal v2 tree", async () => {
    await sandbox.initV2();
    expect((await sandbox.loadTree()).tasks).toEqual([]);
  });

  it("back-dates a file", async () => {
    await sandbox.write("f.txt", "x");
    await sandbox.age("f.txt", 90);
    const { mtime } = await fs.stat(path.join(sandbox.dir, "f.txt"));
    const minutes = (Date.now() - mtime.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(89);
    expect(minutes).toBeLessThan(91);
  });
});
