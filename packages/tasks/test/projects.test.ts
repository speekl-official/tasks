import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LoadedTree, ProjectLoad } from "../src/core/projects.js";
import { Projects } from "../src/core/projects.js";
import type { TaskError } from "../src/errors.js";
import { isTaskError } from "../src/errors.js";
import { addProjectAlias, renderSpec, writeTree } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { makeSandbox } from "./helpers.js";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await makeSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

async function caughtAsync(promise: Promise<unknown>): Promise<TaskError> {
  try {
    await promise;
  } catch (err) {
    if (isTaskError(err)) return err;
    throw err;
  }
  throw new Error("expected a TaskError");
}

function ok(load: ProjectLoad): LoadedTree {
  if (load.kind !== "ok") throw new Error(`expected a tree, got ${load.kind}`);
  return load;
}

/** `<sandbox root>/<name>`: where sibling projects live. */
function sibling(...segments: string[]): string {
  return path.join(sandbox.root, ...segments);
}

/**
 * The local tree lists `backend` and `cli` (the latter through a roundabout
 * path) and `ghost`, which is not checked out. `backend` lists `c`, which
 * exists, and `ghost2`, which does not. `bare` is a tree nobody lists.
 */
async function layout(): Promise<Projects> {
  await sandbox.tree({ tasks: { deploy: {} } });
  await sandbox.project("backend", "../backend", {
    projects: { c: "../c", ghost2: "../ghost2" },
    tasks: { api: { status: "DONE" } },
  });
  await sandbox.project("cli", "../tools/../cli", { tasks: { x: {} } });
  await addProjectAlias(sandbox.tasksDir, "ghost", "../ghost");
  await writeTree(sibling("c", ".tasks"), { tasks: { c1: {} } });
  await writeTree(sibling("bare", ".tasks"), { tasks: { z: {} } });
  return new Projects(await sandbox.loadTree());
}

describe("the local tree and its aliases", () => {
  it("presents the local tree as writable, without an alias", async () => {
    await sandbox.tree({ tasks: { deploy: {} } });
    const tree = await sandbox.loadTree();
    const projects = new Projects(tree);

    expect(projects.local).toMatchObject({
      kind: "ok",
      alias: null,
      local: true,
      writable: true,
      key: sandbox.dir,
    });
    expect(projects.local.tree).toBe(tree);
    expect(projects.local.project).toBe(tree.project);
    expect(projects.aliases()).toEqual([]);
    expect(await projects.listed()).toEqual([]);
  });

  it("lists the aliases in configuration order, and only its own", async () => {
    const projects = await layout();
    expect(projects.aliases()).toEqual(["backend", "cli", "ghost"]);

    // `backend` lists `c`; that extends nothing here.
    const err = await caughtAsync(projects.byAlias("c"));
    expect(err.exitCode).toBe(2);
    expect(err.details).toEqual({
      alias: "c",
      aliases: ["backend", "cli", "ghost"],
    });
  });

  it("says when the tree lists no projects at all", async () => {
    await sandbox.tree({});
    const projects = new Projects(await sandbox.loadTree());
    const err = await caughtAsync(projects.byAlias("backend"));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain("lists no projects");
    expect(err.details).toEqual({ alias: "backend", aliases: [] });
  });
});

describe("byAlias", () => {
  it("loads a listed project once, writable, under its alias", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));

    expect(backend).toMatchObject({
      alias: "backend",
      local: false,
      writable: true,
      key: sibling("backend"),
    });
    expect(backend.project).toEqual({
      root: sibling("backend"),
      tasksDir: sibling("backend", ".tasks"),
    });
    expect([...backend.tree.byId.keys()]).toEqual(["api"]);
    expect(await projects.byAlias("backend")).toBe(backend);
  });

  it("classifies a listed directory that is absent as not checked out", async () => {
    const projects = await layout();
    expect(await projects.byAlias("ghost")).toEqual({
      kind: "not-checked-out",
      alias: "ghost",
      relPath: "../ghost",
      dir: sibling("ghost"),
    });
  });

  it("classifies a listed directory without a tree as unresolved", async () => {
    await sandbox.tree({});
    await sandbox.write("../plain/README.md", "no tree here\n");
    await addProjectAlias(sandbox.tasksDir, "plain", "../plain");
    const projects = new Projects(await sandbox.loadTree());

    expect(await projects.byAlias("plain")).toEqual({
      kind: "unresolved",
      alias: "plain",
      relPath: "../plain",
      dir: sibling("plain"),
      cause: null,
    });
  });

  it("classifies v1 and unsupported trees instead of throwing", async () => {
    await sandbox.tree({});
    await sandbox.project("legacy", "../legacy", { tasks: { a: {} } });
    await sandbox.write("../legacy/.tasks/config.yml", "version: 1\n");
    await sandbox.project("future", "../future", {});
    await sandbox.write("../future/.tasks/config.yml", "version: 3\n");
    await sandbox.project("noconfig", "../noconfig", { tasks: { a: {} } });
    await fs.rm(sibling("noconfig", ".tasks", "config.yml"));
    const projects = new Projects(await sandbox.loadTree());

    expect(await projects.listed()).toEqual([
      {
        kind: "unsupported-version",
        alias: "legacy",
        relPath: "../legacy",
        dir: sibling("legacy"),
        version: 1,
      },
      {
        kind: "unsupported-version",
        alias: "future",
        relPath: "../future",
        dir: sibling("future"),
        version: 3,
      },
      {
        kind: "unsupported-version",
        alias: "noconfig",
        relPath: "../noconfig",
        dir: sibling("noconfig"),
        version: 1,
      },
    ]);
  });

  it("classifies a tree whose config.yml is invalid as unresolved, keeping the error", async () => {
    await sandbox.tree({});
    await sandbox.project("broken", "../broken", {});
    await sandbox.write(
      "../broken/.tasks/config.yml",
      "version: 2\nstatuses: [a]\n",
    );
    const projects = new Projects(await sandbox.loadTree());

    const load = await projects.byAlias("broken");
    if (load.kind !== "unresolved") throw new Error(`got ${load.kind}`);
    expect(load.alias).toBe("broken");
    expect(load.cause?.exitCode).toBe(2);
    expect(load.cause?.message).toContain('unknown key "statuses"');
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "classifies a tree the scan cannot enter as unresolved",
    async () => {
      await sandbox.tree({});
      await sandbox.project("locked", "../locked", { tasks: { a: {} } });
      const inner = sibling("locked", ".tasks", "a");
      await fs.chmod(inner, 0o000);
      try {
        const projects = new Projects(await sandbox.loadTree());
        const load = await projects.byAlias("locked");
        if (load.kind !== "unresolved") throw new Error(`got ${load.kind}`);
        expect(load.cause?.exitCode).toBe(1);
        expect(load.cause?.details).toMatchObject({ code: "EACCES" });
      } finally {
        await fs.chmod(inner, 0o755);
      }
    },
  );
});

describe("byPath", () => {
  it("returns the local tree for any path that leads back to it", async () => {
    const projects = await layout();
    await sandbox.write("docs/notes.md", "inside the project, no tree\n");
    const backend = ok(await projects.byAlias("backend"));

    expect(await projects.byPath(backend, "../repo")).toBe(projects.local);
    expect(await projects.byPath(projects.local, ".")).toBe(projects.local);
    expect(await projects.byPath(projects.local, "docs")).toBe(projects.local);
  });

  it("recognizes a listed tree however the path is spelled", async () => {
    const projects = await layout();
    await sandbox.write("../backend/src/index.ts", "");
    await fs.symlink(sibling("backend"), sibling("backend-link"), "dir");

    // Reached through a symlink before the alias was ever asked for.
    const viaLink = ok(
      await projects.byPath(projects.local, "../backend-link"),
    );
    expect(viaLink).toMatchObject({ alias: "backend", writable: true });
    expect(await projects.byAlias("backend")).toBe(viaLink);

    expect(await projects.byPath(projects.local, "../backend/")).toBe(viaLink);
    expect(await projects.byPath(projects.local, "../backend/src")).toBe(
      viaLink,
    );
    const cli = ok(await projects.byAlias("cli"));
    expect(await projects.byPath(cli, "../backend")).toBe(viaLink);
  });

  it("reaches a tree nobody lists, read-only", async () => {
    const projects = await layout();
    const bare = ok(await projects.byPath(projects.local, "../bare"));

    expect(bare).toMatchObject({
      alias: null,
      local: false,
      writable: false,
      key: sibling("bare"),
    });
    expect([...bare.tree.byId.keys()]).toEqual(["z"]);
    expect(await projects.byPath(projects.local, "../bare")).toBe(bare);
  });

  it("reads a listed tree's own projects only to resolve its references", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));

    const c = ok(await projects.byPath(backend, "../c"));
    expect(c).toMatchObject({ alias: null, local: false, writable: false });
    expect(projects.aliases()).not.toContain("c");
  });

  it("classifies an absent directory by who lists it", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));

    // Listed by the tree that stores the reference.
    expect(await projects.byPath(backend, "../ghost2")).toEqual({
      kind: "not-checked-out",
      alias: null,
      relPath: "../ghost2",
      dir: sibling("ghost2"),
    });
    // Listed by the local tree.
    expect(await projects.byPath(backend, "../ghost")).toEqual({
      kind: "not-checked-out",
      alias: "ghost",
      relPath: "../ghost",
      dir: sibling("ghost"),
    });
    // Listed by nobody, from either side.
    expect(await projects.byPath(backend, "../nowhere")).toEqual({
      kind: "unresolved",
      alias: null,
      relPath: "../nowhere",
      dir: sibling("nowhere"),
      cause: null,
    });
    expect(await projects.byPath(projects.local, "../ghost2")).toEqual({
      kind: "unresolved",
      alias: null,
      relPath: "../ghost2",
      dir: sibling("ghost2"),
      cause: null,
    });
  });

  it("refuses an empty or absolute project path", async () => {
    const projects = await layout();
    for (const bad of ["", "/abs/backend", "C:/repos/backend"]) {
      const err = await caughtAsync(projects.byPath(projects.local, bad));
      expect(err.exitCode).toBe(2);
      expect(err.details).toEqual({ path: bad });
    }
  });
});

describe("resolveArgument", () => {
  it("addresses the local tree without a prefix and a project by alias", async () => {
    const projects = await layout();

    const local = await projects.resolveArgument("deploy");
    expect(local.target).toBe(projects.local);
    expect(local.path).toBe("deploy");

    const foreign = await projects.resolveArgument("backend:api/sub");
    expect(foreign.target).toBe(ok(await projects.byAlias("backend")));
    expect(foreign.path).toBe("api/sub");

    const absent = await projects.resolveArgument("ghost:x");
    expect(absent.target.kind).toBe("not-checked-out");
    expect(absent.path).toBe("x");
  });

  it("refuses an unknown alias, a project path and a malformed argument", async () => {
    const projects = await layout();

    const unknown = await caughtAsync(projects.resolveArgument("nope:x"));
    expect(unknown.exitCode).toBe(2);
    expect(unknown.details).toEqual({
      alias: "nope",
      aliases: ["backend", "cli", "ghost"],
    });
    // A path is not an alias on the command line; the message names the alias.
    const pathForm = await caughtAsync(
      projects.resolveArgument("../backend:api"),
    );
    expect(pathForm.exitCode).toBe(2);
    expect(pathForm.message).toContain("write backend:<path>");
    const unlisted = await caughtAsync(
      projects.resolveArgument("../elsewhere:api"),
    );
    expect(unlisted.exitCode).toBe(2);
    expect(unlisted.message).toContain("named by its alias");
    expect(
      (await caughtAsync(projects.resolveArgument("Not A Task"))).exitCode,
    ).toBe(2);
  });
});

describe("storedReference, qualify", () => {
  it("stores the bare id within one tree", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));

    expect(projects.storedReference(projects.local, projects.local, "a")).toBe(
      "a",
    );
    expect(projects.storedReference(backend, backend, "api")).toBe("api");
  });

  it("uses the configured path from the local tree to a listed one", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));
    const cli = ok(await projects.byAlias("cli"));

    expect(projects.storedReference(projects.local, backend, "api")).toBe(
      "../backend:api",
    );
    expect(projects.storedReference(projects.local, cli, "x")).toBe(
      "../tools/../cli:x",
    );
  });

  it("computes the path between the roots everywhere else", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));
    const cli = ok(await projects.byAlias("cli"));
    const bare = ok(await projects.byPath(projects.local, "../bare"));

    expect(projects.storedReference(backend, projects.local, "deploy")).toBe(
      "../repo:deploy",
    );
    expect(projects.storedReference(backend, cli, "x")).toBe("../cli:x");
    expect(projects.storedReference(projects.local, bare, "z")).toBe(
      "../bare:z",
    );
  });

  it("handles a tree nested inside the project", async () => {
    const projects = await layout();
    await writeTree(path.join(sandbox.dir, "packages", "web", ".tasks"), {
      tasks: { t: {} },
    });
    const web = ok(await projects.byPath(projects.local, "packages/web"));

    expect(projects.storedReference(projects.local, web, "t")).toBe(
      "packages/web:t",
    );
    const back = projects.storedReference(web, projects.local, "deploy");
    expect(back).toBe("../..:deploy");
    expect(await projects.byPath(web, "../..")).toBe(projects.local);
  });

  it("qualifies ids from the local tree's point of view", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));
    const cli = ok(await projects.byAlias("cli"));
    const bare = ok(await projects.byPath(projects.local, "../bare"));

    expect(projects.qualifier(projects.local)).toBeNull();
    expect(projects.qualify(projects.local, "deploy")).toBe("deploy");
    expect(projects.qualify(backend, "api")).toBe("backend:api");
    expect(projects.qualify(cli, "x")).toBe("cli:x");
    expect(projects.qualify(bare, "z")).toBe("../bare:z");
  });
});

describe("writableTrees", () => {
  it("is the local tree, then each listed tree that loaded, once", async () => {
    await layout();
    await sandbox.write("../plain/README.md", "no tree\n");
    await addProjectAlias(sandbox.tasksDir, "plain", "../plain");
    await sandbox.project("legacy", "../legacy", {});
    await sandbox.write("../legacy/.tasks/config.yml", "version: 1\n");
    await addProjectAlias(sandbox.tasksDir, "again", "../backend/");
    const projects = new Projects(await sandbox.loadTree());
    // A bare-path tree that loaded is still read-only.
    ok(await projects.byPath(projects.local, "../bare"));

    const trees = await projects.writableTrees();
    expect(trees.map((load) => load.alias)).toEqual([null, "backend", "cli"]);
    expect(trees[0]).toBe(projects.local);
    expect(trees.every((load) => load.writable)).toBe(true);
    // A second alias of one tree is the same tree.
    expect(await projects.byAlias("again")).toBe(trees[1]);
  });
});

describe("reload", () => {
  it("re-reads a listed tree and makes it the snapshot later lookups see", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));
    await sandbox.write(
      "../backend/.tasks/api/task.md",
      renderSpec("api", { status: "TODO" }),
    );

    const fresh = await projects.reload(backend);
    expect(backend.tree.byId.get("api")!.frontmatter.status).toBe("DONE");
    expect(fresh.tree.byId.get("api")!.frontmatter.status).toBe("TODO");
    expect(fresh).toMatchObject({
      alias: "backend",
      writable: true,
      key: backend.key,
    });
    expect(projects.latest(backend)).toBe(fresh);
    expect(await projects.byAlias("backend")).toBe(fresh);
  });

  it("re-reads the local tree", async () => {
    const projects = await layout();
    const backend = ok(await projects.byAlias("backend"));
    await sandbox.write(
      ".tasks/deploy/task.md",
      renderSpec("deploy", { status: "DONE" }),
    );

    const local = await projects.reload(projects.local);
    expect(projects.local).toBe(local);
    expect(local.tree.byId.get("deploy")!.frontmatter.status).toBe("DONE");
    expect(await projects.byPath(backend, "../repo")).toBe(local);
  });
});
