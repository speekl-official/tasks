import fs from "node:fs/promises";
import path from "node:path";

import type { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import type { GlobalOptions } from "../src/context.js";
import {
  assertV2Tree,
  heartbeat,
  openContext,
  startDirectory,
} from "../src/context.js";
import { Projects } from "../src/core/projects.js";
import { readSession } from "../src/core/sessions.js";
import { isTaskError } from "../src/errors.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

/** The slice of a commander `Command` that `openContext` reads. */
function command(options: GlobalOptions): Command {
  return { optsWithGlobals: () => options } as unknown as Command;
}

async function expectTaskError(
  promise: Promise<unknown>,
  exitCode: number,
  fragment?: string,
): Promise<void> {
  try {
    await promise;
    expect.unreachable("expected a TaskError");
  } catch (err) {
    expect(isTaskError(err)).toBe(true);
    if (isTaskError(err)) {
      expect(err.exitCode).toBe(exitCode);
      if (fragment) expect(err.message).toContain(fragment);
    }
  }
}

describe("startDirectory", () => {
  it("resolves -C against the working directory, else uses cwd", () => {
    expect(startDirectory({})).toBe(process.cwd());
    expect(startDirectory({ dir: "sub/dir" })).toBe(
      path.resolve(process.cwd(), "sub/dir"),
    );
  });
});

describe("openContext", () => {
  it("opens the tree found from -C, resolves the actor and loads projects", async () => {
    sandbox = await treeSandbox({
      tasks: { a: {} },
      projects: { backend: "../backend" },
    });
    await sandbox.project("backend", "../backend", { tasks: { x: {} } });
    const nested = path.join(sandbox.dir, "nested");
    await fs.mkdir(nested, { recursive: true });

    const context = await openContext(command({ dir: nested, as: "alice" }));
    expect(context.project.root).toBe(sandbox.dir);
    expect(context.tree.byId.has("a")).toBe(true);
    expect(context.identity.actor).toBe("alice");
    expect(context.identity.session).toBeNull();
    expect(context.projects.aliases()).toEqual(["backend"]);
    expect(context.json).toBe(false);

    const trees = await context.trees();
    expect(trees.map((load) => load.alias)).toEqual([null, "backend"]);
  });

  it("writes a heartbeat in the local and every listed tree before anything else", async () => {
    sandbox = await treeSandbox({ projects: { backend: "../backend" } });
    const backend = await sandbox.project("backend", "../backend", {});

    await openContext(command({ dir: sandbox.dir, session: "s1" }));

    const local = await readSession(sandbox.tasksDir, "s1");
    const foreign = await readSession(path.join(backend, ".tasks"), "s1");
    expect(local.exists).toBe(true);
    expect(foreign.exists).toBe(true);
  });

  it("clears an ended mark when the session runs again", async () => {
    sandbox = await treeSandbox({});
    const file = path.join(sandbox.tasksDir, ".locks", "sessions", "s1");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "ended\n", "utf8");

    await openContext(command({ dir: sandbox.dir, session: "s1" }));

    expect((await readSession(sandbox.tasksDir, "s1")).ended).toBe(false);
  });

  it("skips a listed project that is not checked out", async () => {
    sandbox = await treeSandbox({ projects: { gone: "../gone" } });
    const context = await openContext(
      command({ dir: sandbox.dir, session: "s1" }),
    );
    expect((await context.trees()).map((load) => load.alias)).toEqual([null]);
  });

  it("fails as not found without a tree", async () => {
    sandbox = await treeSandbox({});
    await fs.rm(sandbox.tasksDir, { recursive: true, force: true });
    await expectTaskError(
      openContext(command({ dir: sandbox.dir })),
      3,
      "tasks init",
    );
  });

  it("refuses a v1 tree as a usage error naming migrate", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(".tasks/config.yml", "version: 1\n");
    await expectTaskError(
      openContext(command({ dir: sandbox.dir })),
      2,
      "tasks migrate",
    );
  });

  it("refuses an unsupported version", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(".tasks/config.yml", "version: 3\n");
    await expectTaskError(
      openContext(command({ dir: sandbox.dir })),
      2,
      "version 3",
    );
  });

  it("rejects an actor or session that fails the pattern as usage", async () => {
    sandbox = await treeSandbox({});
    await expectTaskError(
      openContext(command({ dir: sandbox.dir, as: "two words" })),
      2,
    );
    await expectTaskError(
      openContext(command({ dir: sandbox.dir, session: "bad token" })),
      2,
    );
  });

  it("reloads the local tree on demand", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const context = await openContext(command({ dir: sandbox.dir }));
    expect(context.tree.byId.has("b")).toBe(false);

    await sandbox.tree({ tasks: { b: {} } });
    await context.reload();
    expect(context.tree.byId.has("b")).toBe(true);
  });
});

describe("assertV2Tree", () => {
  it("accepts a v2 tree", async () => {
    sandbox = await treeSandbox({});
    await expect(assertV2Tree(sandbox.local)).resolves.toBeUndefined();
  });
});

describe("heartbeat", () => {
  it("touches the registry of every writable tree and returns them", async () => {
    sandbox = await treeSandbox({ projects: { backend: "../backend" } });
    const backend = await sandbox.project("backend", "../backend", {});
    const projects = new Projects(await sandbox.loadTree());

    const touched = await heartbeat(projects, "s9");

    expect(touched).toEqual([sandbox.tasksDir, path.join(backend, ".tasks")]);
  });
});

describe("init with a session", () => {
  it("touches the registry of the tree it just created", async () => {
    sandbox = await treeSandbox({});
    await fs.rm(sandbox.tasksDir, { recursive: true, force: true });

    const result = await sandbox.run("init", "--no-skill", "--session", "s1");
    expect(result.code).toBe(0);
    expect((await readSession(sandbox.tasksDir, "s1")).exists).toBe(true);
  });
});
