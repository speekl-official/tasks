import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertActor,
  assertSession,
  claimLiveness,
  housekeepSessions,
  livenessForTree,
  markSessionEnded,
  readSession,
  registryDir,
  resolveIdentity,
  resolveOperator,
  resolveSession,
  sessionCheck,
  sessionEnd,
  sessionFile,
  touchSession,
} from "../src/core/sessions.js";
import { formatIso } from "../src/core/time.js";
import type { Tree } from "../src/core/tree.js";
import { findTask, loadTree } from "../src/core/tree.js";
import type { Identity } from "../src/core/types.js";
import { ACTOR_ENV, SESSION_ENV, TASKS_DIRNAME } from "../src/core/types.js";
import type { TaskError } from "../src/errors.js";
import { isTaskError } from "../src/errors.js";
import type { TaskSpec, TreeSpec } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { makeSandbox, treeSandbox } from "./helpers.js";

const exec = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await exec("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = await gitAvailable();

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

async function boxWith(spec: TreeSpec = {}): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

async function emptyBox(): Promise<Sandbox> {
  sandbox = await makeSandbox();
  return sandbox;
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

function caught(fn: () => unknown): TaskError {
  try {
    fn();
  } catch (err) {
    if (isTaskError(err)) return err;
    throw err;
  }
  throw new Error("expected a TaskError");
}

function minutesAgo(minutes: number): string {
  return formatIso(new Date(Date.now() - minutes * 60_000));
}

/** An `IN_PROGRESS` task claimed by `tester` in `session`. */
function claimed(session: string | null, extra: TaskSpec = {}): TaskSpec {
  return { status: "IN_PROGRESS", claimed_session: session, ...extra };
}

/**
 * The suite's environment minus every identity, session and git setting,
 * with git pointed at empty configuration and kept from discovering a
 * repository above the sandbox, so the machine's own identity cannot leak in.
 */
function isolatedEnv(
  box: Sandbox,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("GIT_")) continue;
    if (key === ACTOR_ENV || key === SESSION_ENV) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: box.root,
    XDG_CONFIG_HOME: path.join(box.root, ".config"),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: box.root,
    ...extra,
  };
}

async function git(box: Sandbox, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd: box.dir, env: isolatedEnv(box) });
}

function stubOsUser(username: string): void {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username,
    uid: 501,
    gid: 20,
    shell: "/bin/sh",
    homedir: "/home/someone",
  });
}

async function identityIn(
  box: Sandbox,
  options: {
    as?: string;
    session?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ identity: Identity; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const identity = await resolveIdentity({
    as: options.as,
    session: options.session,
    env: isolatedEnv(box, options.env),
    projectRoot: box.dir,
    diagnose: (message) => diagnostics.push(message),
  });
  return { identity, diagnostics };
}

/* ------------------------------------------------------------------------ */

describe("assertActor and assertSession", () => {
  it("pass a value matching the pattern through", () => {
    for (const value of ["agent", "ada@example.com", "a.b_c+d-e", "7F3a"]) {
      expect(assertActor(value, "assignee")).toBe(value);
      expect(assertSession(value)).toBe(value);
    }
  });

  it("refuse anything else as a usage error naming the source", () => {
    for (const value of ["", "Ada L", "-x", ".x", "a/b", "a:b", "ünï", "x\n"]) {
      const actor = caught(() => assertActor(value, "--as"));
      expect(actor.code).toBe("USAGE");
      expect(actor.details).toMatchObject({ field: "--as", value });
      expect(caught(() => assertSession(value)).code).toBe("USAGE");
    }
  });
});

describe("resolveSession", () => {
  it("takes --session over TASKS_SESSION", () => {
    expect(
      resolveSession({ session: "s1", env: { [SESSION_ENV]: "s2" } }),
    ).toBe("s1");
    expect(resolveSession({ env: { [SESSION_ENV]: "s2" } })).toBe("s2");
  });

  it("is null without either; an empty variable counts as unset", () => {
    expect(resolveSession({ env: {} })).toBeNull();
    expect(resolveSession({ session: null, env: { [SESSION_ENV]: "" } })).toBe(
      null,
    );
  });

  it("reads the process environment by default", () => {
    vi.stubEnv(SESSION_ENV, "from-process");
    try {
      expect(resolveSession()).toBe("from-process");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a token that fails the pattern, from either source", () => {
    const fromOption = caught(() =>
      resolveSession({ session: "a b", env: {} }),
    );
    expect(fromOption.code).toBe("USAGE");
    expect(fromOption.details).toMatchObject({ field: "--session" });

    const fromEnv = caught(() =>
      resolveSession({ env: { [SESSION_ENV]: "../x" } }),
    );
    expect(fromEnv.code).toBe("USAGE");
    expect(fromEnv.details).toMatchObject({ field: SESSION_ENV });
  });
});

describe("resolveIdentity", () => {
  it.skipIf(!HAS_GIT)("takes TASKS_ACTOR over the git identity", async () => {
    const box = await emptyBox();
    await git(box, "init", "-q");
    await git(box, "config", "user.name", "ada");
    const { identity, diagnostics } = await identityIn(box, {
      env: { [ACTOR_ENV]: "agent" },
    });
    expect(identity).toEqual({ actor: "agent", via: null, session: null });
    expect(diagnostics).toEqual([]);
  });

  it("makes --as the principal and records the operator as via", async () => {
    const box = await emptyBox();
    const { identity } = await identityIn(box, {
      as: "alice",
      env: { [ACTOR_ENV]: "agent" },
    });
    expect(identity).toEqual({ actor: "alice", via: "agent", session: null });
  });

  it("records no via when --as names the operator itself", async () => {
    const box = await emptyBox();
    const { identity } = await identityIn(box, {
      as: "agent",
      env: { [ACTOR_ENV]: "agent" },
    });
    expect(identity).toEqual({ actor: "agent", via: null, session: null });
  });

  it("refuses a TASKS_ACTOR that fails the pattern, --as or not", async () => {
    const box = await emptyBox();
    for (const as of [undefined, "alice"]) {
      const err = await caughtAsync(
        identityIn(box, { as, env: { [ACTOR_ENV]: "Ada L" } }),
      );
      expect(err.code).toBe("USAGE");
      expect(err.details).toMatchObject({ field: ACTOR_ENV, value: "Ada L" });
    }
  });

  it("refuses an --as that fails the pattern", async () => {
    const box = await emptyBox();
    const err = await caughtAsync(
      identityIn(box, { as: "Alice B", env: { [ACTOR_ENV]: "agent" } }),
    );
    expect(err.code).toBe("USAGE");
    expect(err.details).toMatchObject({ field: "--as" });
  });

  it.skipIf(!HAS_GIT)(
    "skips a git user.name with a space, says so, and uses user.email",
    async () => {
      const box = await emptyBox();
      await git(box, "init", "-q");
      await git(box, "config", "user.name", "Ada L");
      await git(box, "config", "user.email", "ada@example.com");

      const { identity, diagnostics } = await identityIn(box);
      expect(identity).toEqual({
        actor: "ada@example.com",
        via: null,
        session: null,
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain('git user.name "Ada L" does not match');
      expect(diagnostics[0]).toContain("for instance ada");
    },
  );

  it.skipIf(!HAS_GIT)("takes a one-word git user.name", async () => {
    const box = await emptyBox();
    await git(box, "init", "-q");
    await git(box, "config", "user.name", "ada");
    await git(box, "config", "user.email", "ada@example.com");
    const { identity, diagnostics } = await identityIn(box);
    expect(identity.actor).toBe("ada");
    expect(diagnostics).toEqual([]);
  });

  it("falls back to the operating-system user", async () => {
    const box = await emptyBox();
    stubOsUser("ada");
    const { identity, diagnostics } = await identityIn(box);
    expect(identity).toEqual({ actor: "ada", via: null, session: null });
    expect(diagnostics).toEqual([]);
  });

  it("skips an absent git silently", async () => {
    const box = await emptyBox();
    stubOsUser("ada");
    const { identity, diagnostics } = await identityIn(box, {
      env: { PATH: path.join(box.root, "no-bin") },
    });
    expect(identity.actor).toBe("ada");
    expect(diagnostics).toEqual([]);
  });

  it("refuses when no source yields an actor, naming the remedies", async () => {
    const box = await emptyBox();
    stubOsUser("Ada Lovelace");
    const err = await caughtAsync(identityIn(box));
    expect(err.code).toBe("USAGE");
    expect(err.message).toContain(ACTOR_ENV);
    expect(err.message).toContain("--as");
    expect(err.details).toMatchObject({ os_user: "Ada Lovelace" });

    await expect(
      resolveOperator({ env: isolatedEnv(box), projectRoot: box.dir }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("treats an unreadable operating-system user like an invalid one", async () => {
    const box = await emptyBox();
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("no passwd entry for uid 1000");
    });
    const err = await caughtAsync(identityIn(box));
    expect(err.code).toBe("USAGE");
    expect(err.details).toMatchObject({ os_user: null });
  });

  it("lets --as stand alone when no operator can be resolved", async () => {
    const box = await emptyBox();
    stubOsUser("Ada Lovelace");
    const { identity, diagnostics } = await identityIn(box, { as: "alice" });
    expect(identity).toEqual({ actor: "alice", via: null, session: null });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("no operator recorded");
  });

  it("carries the session, --session over TASKS_SESSION", async () => {
    const box = await emptyBox();
    const env = { [ACTOR_ENV]: "agent", [SESSION_ENV]: "env-s" };
    expect((await identityIn(box, { env })).identity.session).toBe("env-s");
    expect(
      (await identityIn(box, { env, session: "opt-s" })).identity.session,
    ).toBe("opt-s");
    const err = await caughtAsync(
      identityIn(box, { env: { [ACTOR_ENV]: "agent", [SESSION_ENV]: "a b" } }),
    );
    expect(err.code).toBe("USAGE");
  });

  it("resolves the operator alone the same way", async () => {
    const box = await emptyBox();
    expect(
      await resolveOperator({
        env: isolatedEnv(box, { [ACTOR_ENV]: "agent" }),
        projectRoot: box.dir,
      }),
    ).toBe("agent");
  });
});

describe("the session registry", () => {
  it("creates an empty heartbeat file with a fresh mtime", async () => {
    const box = await boxWith();
    await touchSession(box.tasksDir, "s1");

    const file = sessionFile(box.tasksDir, "s1");
    expect(file).toBe(path.join(box.tasksDir, ".locks", "sessions", "s1"));
    expect(path.dirname(file)).toBe(registryDir(box.tasksDir));
    expect(await fs.readFile(file, "utf8")).toBe("");
    const record = await readSession(box.tasksDir, "s1");
    expect(record).toMatchObject({ exists: true, ended: false });
    expect(record.lastSeen! >= minutesAgo(1)).toBe(true);
  });

  it("refreshes the mtime of an aged file", async () => {
    const box = await boxWith();
    await touchSession(box.tasksDir, "s1");
    await box.age(".tasks/.locks/sessions/s1", 120);
    expect(
      (await readSession(box.tasksDir, "s1")).lastSeen! < minutesAgo(119),
    ).toBe(true);
    await touchSession(box.tasksDir, "s1");
    expect(
      (await readSession(box.tasksDir, "s1")).lastSeen! >= minutesAgo(1),
    ).toBe(true);
  });

  it("marks a session ended, and a later touch clears the mark", async () => {
    const box = await boxWith();
    const at = new Date(Date.now() - 5_000);
    expect(await markSessionEnded(box.tasksDir, "s1", at)).toBe(formatIso(at));
    expect(await box.read(".tasks/.locks/sessions/s1")).toBe("ended\n");
    expect(await readSession(box.tasksDir, "s1")).toEqual({
      exists: true,
      ended: true,
      lastSeen: formatIso(at),
    });

    await touchSession(box.tasksDir, "s1");
    expect(await box.read(".tasks/.locks/sessions/s1")).toBe("");
    expect((await readSession(box.tasksDir, "s1")).ended).toBe(false);
    expect(await fs.readdir(registryDir(box.tasksDir))).toEqual(["s1"]);
  });

  it("reads the mark without a newline, and nothing else as one", async () => {
    const box = await boxWith();
    await touchSession(box.tasksDir, "s1");
    const cases: Array<[string, boolean]> = [
      ["ended", true],
      ["ended\n", true],
      ["ended\r\n", true],
      ["ENDED", false],
      ["ended later", false],
      ["\nended", false],
    ];
    for (const [content, ended] of cases) {
      await box.write(".tasks/.locks/sessions/s1", content);
      expect((await readSession(box.tasksDir, "s1")).ended, content).toBe(
        ended,
      );
    }
  });

  it("reports an absent session", async () => {
    const box = await boxWith();
    expect(await readSession(box.tasksDir, "nobody")).toEqual({
      exists: false,
      ended: false,
      lastSeen: null,
    });
  });

  it("refuses a token that is not safe as a file name", async () => {
    const box = await boxWith();
    for (const token of ["../escape", ".hidden", "a b", "a/b", ""]) {
      expect(caught(() => sessionFile(box.tasksDir, token)).code).toBe("USAGE");
      expect((await caughtAsync(touchSession(box.tasksDir, token))).code).toBe(
        "USAGE",
      );
    }
    expect(await box.exists(".tasks/.locks")).toBe(false);
  });

  it("never creates a tree where there is none", async () => {
    const box = await boxWith();
    const absent = path.join(box.root, "elsewhere", TASKS_DIRNAME);
    expect((await caughtAsync(touchSession(absent, "s1"))).code).toBe(
      "NOT_FOUND",
    );
    expect((await caughtAsync(markSessionEnded(absent, "s1"))).code).toBe(
      "NOT_FOUND",
    );
    expect(await box.exists("../elsewhere")).toBe(false);
  });
});

describe("claim liveness", () => {
  async function stat(box: Sandbox, session: string): Promise<string> {
    return formatIso((await fs.stat(sessionFile(box.tasksDir, session))).mtime);
  }

  it("tells live, orphaned and unknown claims apart", async () => {
    const box = await boxWith({
      tasks: {
        live: claimed("s-live"),
        stale: claimed("s-stale"),
        ended: claimed("s-ended"),
        "no-session": claimed(null),
        "no-file": claimed("s-gone"),
        waiting: { status: "TODO" },
      },
    });
    await touchSession(box.tasksDir, "s-live");
    await touchSession(box.tasksDir, "s-stale");
    await box.age(".tasks/.locks/sessions/s-stale", 31);
    await markSessionEnded(box.tasksDir, "s-ended");
    // A file for the claimant does not make a session-less claim known.
    await touchSession(box.tasksDir, "tester");

    const tree = await box.loadTree();
    const of = (id: string) => claimLiveness(tree, findTask(tree, id));

    expect(await of("live")).toEqual({
      liveness: "live",
      last_seen: await stat(box, "s-live"),
    });
    expect(await of("stale")).toEqual({
      liveness: "orphaned",
      last_seen: await stat(box, "s-stale"),
    });
    expect((await of("stale")).last_seen! < minutesAgo(30)).toBe(true);
    expect(await of("ended")).toEqual({
      liveness: "orphaned",
      last_seen: await stat(box, "s-ended"),
    });
    expect(await of("no-session")).toEqual({
      liveness: "unknown",
      last_seen: null,
    });
    expect(await of("no-file")).toEqual({
      liveness: "unknown",
      last_seen: null,
    });

    const all = await livenessForTree(tree);
    expect([...all.keys()].sort()).toEqual([
      "ended",
      "live",
      "no-file",
      "no-session",
      "stale",
    ]);
    expect(all.get("live")?.liveness).toBe("live");
    expect(all.get("stale")?.liveness).toBe("orphaned");
    expect(all.get("ended")?.liveness).toBe("orphaned");
    expect(all.get("no-session")?.liveness).toBe("unknown");
    expect(all.get("no-file")?.liveness).toBe("unknown");
  });

  it("judges every claim of one session by one heartbeat", async () => {
    const box = await boxWith({
      tasks: { a: claimed("s1"), b: claimed("s1") },
    });
    await touchSession(box.tasksDir, "s1");
    const tree = await box.loadTree();
    const now = new Date(Date.now() + 31 * 60_000);
    const all = await livenessForTree(tree, now);
    expect(all.get("a")).toEqual(all.get("b"));
    expect(all.get("a")?.liveness).toBe("orphaned");
  });

  it("honors a custom session_timeout_minutes", async () => {
    const box = await boxWith({
      session_timeout_minutes: 5,
      tasks: { a: claimed("s1") },
    });
    await touchSession(box.tasksDir, "s1");

    await box.age(".tasks/.locks/sessions/s1", 4);
    let tree = await box.loadTree();
    expect((await claimLiveness(tree, findTask(tree, "a"))).liveness).toBe(
      "live",
    );

    await box.age(".tasks/.locks/sessions/s1", 6);
    tree = await box.loadTree();
    expect((await claimLiveness(tree, findTask(tree, "a"))).liveness).toBe(
      "orphaned",
    );
  });

  it("uses the registry and timeout of the tree that holds the task", async () => {
    const box = await boxWith({ tasks: { here: claimed("s1") } });
    const backendRoot = await box.project("backend", "../backend", {
      session_timeout_minutes: 60,
      tasks: { there: claimed("s1") },
    });
    const backendTasks = path.join(backendRoot, TASKS_DIRNAME);
    await touchSession(box.tasksDir, "s1");
    await touchSession(backendTasks, "s1");
    await box.age(".tasks/.locks/sessions/s1", 45);
    await box.age("../backend/.tasks/.locks/sessions/s1", 45);

    const local = await box.loadTree();
    const backend = await loadTree({
      root: backendRoot,
      tasksDir: backendTasks,
    });
    expect((await claimLiveness(local, findTask(local, "here"))).liveness).toBe(
      "orphaned",
    );
    expect(
      (await claimLiveness(backend, findTask(backend, "there"))).liveness,
    ).toBe("live");
  });
});

describe("housekeepSessions", () => {
  it("removes stale and ended files no claim names, and keeps the rest", async () => {
    const box = await boxWith({
      tasks: { a: claimed("kept"), b: claimed("held"), c: { status: "DONE" } },
    });
    for (const session of ["kept", "stale", "fresh"]) {
      await touchSession(box.tasksDir, session);
    }
    await box.age(".tasks/.locks/sessions/kept", 120);
    await box.age(".tasks/.locks/sessions/stale", 120);
    await markSessionEnded(box.tasksDir, "ended-free");
    await markSessionEnded(box.tasksDir, "held");

    expect(await housekeepSessions(await box.loadTree())).toEqual([
      "ended-free",
      "stale",
    ]);
    expect((await fs.readdir(registryDir(box.tasksDir))).sort()).toEqual([
      "fresh",
      "held",
      "kept",
    ]);
  });

  it("does nothing without a registry", async () => {
    const box = await boxWith({ tasks: { a: claimed("s1") } });
    expect(await housekeepSessions(await box.loadTree())).toEqual([]);
  });

  it("leaves entries alone that are not session files", async () => {
    const box = await boxWith();
    await touchSession(box.tasksDir, "s1");
    await box.write(".tasks/.locks/sessions/.s1.0a1b2c.tmp", "");
    await fs.mkdir(path.join(registryDir(box.tasksDir), "nested"));
    for (const name of ["s1", ".s1.0a1b2c.tmp", "nested"]) {
      await box.age(`.tasks/.locks/sessions/${name}`, 120);
    }
    expect(await housekeepSessions(await box.loadTree())).toEqual(["s1"]);
    expect((await fs.readdir(registryDir(box.tasksDir))).sort()).toEqual([
      ".s1.0a1b2c.tmp",
      "nested",
    ]);
  });

  it("keeps every file while a manifest cannot be read", async () => {
    const box = await boxWith({ tasks: { a: {} } });
    await box.write(".tasks/broken/task.md", "no frontmatter here\n");
    await touchSession(box.tasksDir, "s1");
    await box.age(".tasks/.locks/sessions/s1", 120);
    expect(await housekeepSessions(await box.loadTree())).toEqual([]);
    expect(await box.exists(".tasks/.locks/sessions/s1")).toBe(true);
  });

  it("measures age against the tree's own timeout", async () => {
    const box = await boxWith({ session_timeout_minutes: 240 });
    await touchSession(box.tasksDir, "s1");
    await box.age(".tasks/.locks/sessions/s1", 120);
    expect(await housekeepSessions(await box.loadTree())).toEqual([]);
  });
});

describe("sessionCheck", () => {
  const inSession = (session: string): Identity => ({
    actor: "tester",
    via: null,
    session,
  });

  function claimEntry(time: string): string {
    return `## ${time} tester s:s1\nclaim: PAUSED → IN_PROGRESS\n`;
  }

  async function check(box: Sandbox, identity: Identity) {
    return sessionCheck(
      [{ tree: await box.loadTree(), alias: null }],
      identity,
    );
  }

  it("passes for a claim taken from PAUSED without a new write", async () => {
    const claimedAt = minutesAgo(10);
    const box = await boxWith({
      tasks: {
        "auth/schema": claimed("s1", {
          claimed_at: claimedAt,
          state: true,
          log: claimEntry(claimedAt),
        }),
      },
    });
    await box.age(".tasks/auth/schema/state.md", 60);

    const result = await check(box, inSession("s1"));
    expect(result.ok).toBe(true);
    expect(result.session).toBe("s1");
    expect(result.violations).toEqual([]);
    // The claim's own log entry adds nothing the claim warning does not say.
    expect(result.warnings).toEqual([
      expect.objectContaining({
        id: "auth/schema",
        kind: "state-older-than-claim",
      }),
    ]);
    expect(result.warnings[0]!.message).toContain(claimedAt);
  });

  it("fails for a claim taken from TODO, until state.md exists", async () => {
    const box = await boxWith({ tasks: { "auth/schema": claimed("s1") } });
    expect(await check(box, inSession("s1"))).toEqual({
      ok: false,
      session: "s1",
      violations: [{ id: "auth/schema", kind: "missing-state" }],
      warnings: [],
    });

    await box.write(".tasks/auth/schema/state.md", "## Next\n");
    expect(await check(box, inSession("s1"))).toEqual({
      ok: true,
      session: "s1",
      violations: [],
      warnings: [],
    });
  });

  it("covers the session's own claims, whoever the principal", async () => {
    const box = await boxWith({
      tasks: {
        mine: claimed("s1"),
        "on-behalf": claimed("s1", { claimed_by: "alice" }),
        "other-session": claimed("s2"),
        "no-session": claimed(null),
        paused: { status: "PAUSED" },
      },
    });
    const result = await check(box, inSession("s1"));
    expect(result.violations.map((v) => v.id)).toEqual(["mine", "on-behalf"]);
  });

  it("warns when state.md predates the last log entry", async () => {
    const box = await boxWith({
      tasks: {
        a: claimed("s1", {
          claimed_at: minutesAgo(60),
          state: true,
          log: `${claimEntry(minutesAgo(60))}\n## ${minutesAgo(10)} tester s:s1\nprogress noted\n`,
        }),
      },
    });
    await box.age(".tasks/a/state.md", 30);
    const result = await check(box, inSession("s1"));
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.kind)).toEqual([
      "state-older-than-log",
    ]);
  });

  it("reports both warnings when both hold", async () => {
    const box = await boxWith({
      tasks: {
        a: claimed("s1", {
          claimed_at: minutesAgo(30),
          state: true,
          log: `${claimEntry(minutesAgo(30))}\n## ${minutesAgo(10)} tester s:s1\nprogress noted\n`,
        }),
      },
    });
    await box.age(".tasks/a/state.md", 60);
    const result = await check(box, inSession("s1"));
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.kind)).toEqual([
      "state-older-than-claim",
      "state-older-than-log",
    ]);
  });

  it("without a session, covers the actor's claims that have none", async () => {
    const box = await boxWith({
      tasks: {
        mine: claimed(null),
        "mine-written": claimed(null, { state: true }),
        "mine-in-a-session": claimed("s1"),
        theirs: claimed(null, { claimed_by: "alice" }),
      },
    });
    expect(
      await check(box, { actor: "tester", via: null, session: null }),
    ).toEqual({
      ok: false,
      session: null,
      violations: [{ id: "mine", kind: "missing-state" }],
      warnings: [],
    });
  });

  it("qualifies the ids of a listed project", async () => {
    const box = await boxWith({
      tasks: { here: claimed("s1", { state: true }) },
    });
    const backendRoot = await box.project("backend", "../backend", {
      tasks: { "api/there": claimed("s1") },
    });
    const backend = await loadTree({
      root: backendRoot,
      tasksDir: path.join(backendRoot, TASKS_DIRNAME),
    });
    const result = await sessionCheck(
      [
        { tree: await box.loadTree(), alias: null },
        { tree: backend, alias: "backend" },
        { tree: backend, alias: "duplicate" },
      ],
      inSession("s1"),
    );
    expect(result.violations).toEqual([
      { id: "backend:api/there", kind: "missing-state" },
    ]);
  });
});

describe("sessionEnd", () => {
  async function twoTrees(): Promise<{
    box: Sandbox;
    local: Tree;
    backend: Tree;
  }> {
    const box = await boxWith({
      tasks: { a: claimed("s1"), c: claimed("s2"), d: { status: "TODO" } },
    });
    const backendRoot = await box.project("backend", "../backend", {
      tasks: { "api/b": claimed("s1") },
    });
    const backend = await loadTree({
      root: backendRoot,
      tasksDir: path.join(backendRoot, TASKS_DIRNAME),
    });
    return { box, local: await box.loadTree(), backend };
  }

  it("marks every tree ended and reports the session's claims, qualified", async () => {
    const { box, local, backend } = await twoTrees();
    await touchSession(local.project.tasksDir, "s1");
    const now = new Date();

    const result = await sessionEnd(
      [
        { tree: local, alias: null },
        { tree: backend, alias: "backend" },
      ],
      "s1",
      now,
    );
    expect(result).toEqual({
      session: "s1",
      ended: formatIso(now),
      claims: ["a", "backend:api/b"],
    });
    for (const tasksDir of [local.project.tasksDir, backend.project.tasksDir]) {
      expect(await readSession(tasksDir, "s1")).toEqual({
        exists: true,
        ended: true,
        lastSeen: formatIso(now),
      });
    }

    // A fresh claim is orphaned at once, without waiting for the timeout.
    expect(await claimLiveness(local, findTask(local, "a"))).toEqual({
      liveness: "orphaned",
      last_seen: formatIso(now),
    });
    expect((await claimLiveness(local, findTask(local, "c"))).liveness).toBe(
      "unknown",
    );

    // The same session acting again is running again.
    await touchSession(local.project.tasksDir, "s1");
    expect((await claimLiveness(local, findTask(local, "a"))).liveness).toBe(
      "live",
    );
    expect(box.dir).toBe(local.project.root);
  });

  it("ends a session that holds no claim", async () => {
    const { local } = await twoTrees();
    const result = await sessionEnd([{ tree: local, alias: null }], "idle");
    expect(result.claims).toEqual([]);
    expect(result.ended).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect((await readSession(local.project.tasksDir, "idle")).ended).toBe(
      true,
    );
  });

  it("refuses a token that fails the pattern", async () => {
    const { local } = await twoTrees();
    const err = await caughtAsync(
      sessionEnd([{ tree: local, alias: null }], "not valid"),
    );
    expect(err.code).toBe("USAGE");
  });
});
