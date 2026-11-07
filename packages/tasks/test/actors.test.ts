import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HooksInstallJson } from "../src/commands/hooks.js";
import type {
  ActorsJson,
  TaskWithDerivedJson,
  ValidationJson,
} from "../src/core/types.js";
import { ACTOR_ENV, CONFIG_FILENAME } from "../src/core/types.js";
import { ExitCode } from "../src/errors.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";
import { errorOf, frontmatterOf, plain } from "./transitions-support.js";

/**
 * The roster: `actors:` in `config.yml`. A name typed for someone else must
 * be on it, the identity a command resolves for itself is only diagnosed,
 * validation reports the names open tasks carry that it lacks, and `actors`
 * shows who is around.
 */

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

const ROSTER = {
  alice: "maintainer; approves plans and does releases",
  tester: null,
  agent: "the coding agent",
};

function configFile(s: Sandbox): string {
  return path.join(s.tasksDir, CONFIG_FILENAME);
}

describe("a typed actor against the roster", () => {
  it("assign refuses an actor the roster lacks, naming the listed ones and the file", async () => {
    sandbox = await treeSandbox({ actors: ROSTER, tasks: { a: {} } });
    const result = await sandbox.run("assign", "a", "Alice", "--json");
    expect(result.code).toBe(ExitCode.Usage);
    const error = errorOf(result);
    expect(error.code).toBe("USAGE");
    expect(error.details).toEqual({
      field: "actor",
      value: "Alice",
      actors: ["alice", "tester", "agent"],
      file: configFile(sandbox),
    });
    expect(error.message).toBe(
      `Unknown actor "Alice": ${configFile(sandbox)} lists alice, tester, agent under actors:; use one of them or add "Alice" there. Did you mean alice?`,
    );
    expect((await frontmatterOf(sandbox, "a")).assignee).toBeNull();
    expect(await sandbox.exists(".tasks/a/log.md")).toBe(false);
  });

  it("assign and handoff accept a listed actor and refuse an unlisted one", async () => {
    sandbox = await treeSandbox({
      actors: ROSTER,
      tasks: { a: {}, b: { status: "IN_PROGRESS", state: true } },
    });
    expect((await sandbox.run("assign", "a", "alice")).code).toBe(0);
    expect((await frontmatterOf(sandbox, "a")).assignee).toBe("alice");

    const refused = await sandbox.run(
      "handoff",
      "b",
      "bob",
      "-m",
      "x",
      "--json",
    );
    expect(refused.code).toBe(ExitCode.Usage);
    expect(errorOf(refused).message).not.toContain("Did you mean");
    expect((await frontmatterOf(sandbox, "b")).status).toBe("IN_PROGRESS");

    expect((await sandbox.run("handoff", "b", "agent", "-m", "x")).code).toBe(
      0,
    );
    expect(await frontmatterOf(sandbox, "b")).toMatchObject({
      status: "PAUSED",
      assignee: "agent",
    });
  });

  it("judges assign and handoff by the roster of the tree that holds the task, and --force lifts nothing", async () => {
    sandbox = await treeSandbox({ actors: ROSTER });
    const backend = await sandbox.project("backend", "../backend", {
      actors: { bob: null, tester: null },
      tasks: { x: {}, y: { status: "IN_PROGRESS", state: true } },
    });
    expect((await sandbox.run("assign", "backend:x", "bob")).code).toBe(0);
    const refused = await sandbox.run("assign", "backend:x", "alice", "--json");
    expect(refused.code).toBe(ExitCode.Usage);
    expect(errorOf(refused).details).toMatchObject({
      actors: ["bob", "tester"],
      file: path.join(backend, ".tasks", CONFIG_FILENAME),
    });
    const forced = await sandbox.run(
      "handoff",
      "backend:y",
      "alice",
      "-m",
      "x",
      "--force",
      "--json",
    );
    expect(forced.code).toBe(ExitCode.Usage);
    expect((await frontmatterOf(sandbox, "y", backend)).status).toBe(
      "IN_PROGRESS",
    );
  });

  it("refuses an unlisted name before judging the transition itself", async () => {
    sandbox = await treeSandbox({
      actors: ROSTER,
      tasks: { done: { status: "DONE" } },
    });
    // A bad argument is a usage error, like a name that fails the pattern,
    // whatever the task's state would have said.
    expect((await sandbox.run("assign", "done", "zed", "--json")).code).toBe(
      ExitCode.Usage,
    );
    expect((await sandbox.run("assign", "done", "alice", "--json")).code).toBe(
      ExitCode.Conflict,
    );
  });

  it("constrains nothing without a roster", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("assign", "a", "whoever")).code).toBe(0);
    expect((await frontmatterOf(sandbox, "a")).assignee).toBe("whoever");
  });

  it("judges new --assign by the roster of the tree that holds the task", async () => {
    sandbox = await treeSandbox({ actors: ROSTER });
    const backend = await sandbox.project("backend", "../backend", {
      actors: { bob: null, tester: null },
    });

    const foreign = await sandbox.run(
      "new",
      "backend:x",
      "X",
      "--assign",
      "bob",
      "--json",
    );
    expect(foreign.code).toBe(0);
    expect(foreign.json<TaskWithDerivedJson>().assignee).toBe("bob");

    const refused = await sandbox.run(
      "new",
      "backend:y",
      "Y",
      "--assign",
      "alice",
      "--json",
    );
    expect(refused.code).toBe(ExitCode.Usage);
    expect(errorOf(refused).details).toEqual({
      field: "--assign",
      value: "alice",
      actors: ["bob", "tester"],
      file: path.join(backend, ".tasks", CONFIG_FILENAME),
    });
    expect(await sandbox.exists("../backend/.tasks/y")).toBe(false);

    const local = await sandbox.run(
      "new",
      "z",
      "Z",
      "--assign",
      "bob",
      "--json",
    );
    expect(local.code).toBe(ExitCode.Usage);
    expect(errorOf(local).details).toMatchObject({
      actors: ["alice", "tester", "agent"],
      file: configFile(sandbox),
    });
    expect(await sandbox.exists(".tasks/z")).toBe(false);
    expect((await sandbox.run("new", "w", "W", "--assign", "alice")).code).toBe(
      0,
    );
  });

  it("refuses an --as the roster lacks and only diagnoses the operator behind it", async () => {
    sandbox = await treeSandbox({
      actors: { alice: ROSTER.alice, agent: null },
      tasks: { a: {} },
    });
    const refused = await sandbox.run("mine", "--as", "bob", "--json");
    expect(refused.code).toBe(ExitCode.Usage);
    expect(errorOf(refused).details).toMatchObject({
      field: "--as",
      value: "bob",
      actors: ["alice", "agent"],
    });

    // The operator, tester, is not listed: a warning, not a refusal.
    const done = await sandbox.run("assign", "a", "agent", "--as", "alice");
    expect(done.code).toBe(0);
    expect(plain(done.stderr)).toContain(
      `operator tester is not listed under actors: in ${configFile(sandbox)} (alice, agent); set ${ACTOR_ENV} to a listed name or add tester there.`,
    );
    expect((await frontmatterOf(sandbox, "a")).assignee).toBe("agent");

    // A listed operator behind a listed --as: nothing to say.
    const quiet = await sandbox.runWith(
      { env: { [ACTOR_ENV]: "alice" } },
      "unassign",
      "a",
      "--as",
      "agent",
    );
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");
  });

  it("diagnoses an identity the roster lacks on stderr and goes on, silently under --json", async () => {
    sandbox = await treeSandbox({
      actors: { alice: ROSTER.alice, agent: null },
      tasks: { a: {} },
    });
    const result = await sandbox.run("ready");
    expect(result.code).toBe(0);
    expect(plain(result.stderr)).toBe(
      `! actor tester is not listed under actors: in ${configFile(sandbox)} (alice, agent); set ${ACTOR_ENV} to a listed name or add tester there.\n`,
    );
    // Under --json stderr is reserved for the error envelope.
    const json = await sandbox.run("ready", "--json");
    expect(json.stderr).toBe("");
    expect(json.json<{ count: number }>().count).toBe(1);

    const near = await sandbox.runWith(
      { env: { [ACTOR_ENV]: "Agent" } },
      "claim",
      "a",
    );
    expect(near.code).toBe(0);
    expect(plain(near.stderr)).toContain("Did you mean agent?");
    expect((await frontmatterOf(sandbox, "a")).claimed_by).toBe("Agent");

    const listed = await sandbox.runWith(
      { env: { [ACTOR_ENV]: "agent" } },
      "ready",
    );
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe("");
  });

  it("hooks install refuses an actor the roster lacks and writes nothing", async () => {
    sandbox = await treeSandbox({ actors: { alice: null } });
    const refused = await sandbox.run("hooks", "install", "--json");
    expect(refused.code).toBe(ExitCode.Usage);
    const error = errorOf(refused);
    expect(error.details).toEqual({
      field: "--actor",
      value: "agent",
      actors: ["alice"],
      file: configFile(sandbox),
    });
    expect(error.message).toContain("pass --actor <name> with one of them");
    expect(await sandbox.exists(".claude")).toBe(false);

    // The roster is read from config.yml, so a broken one is refused too.
    await sandbox.write(".tasks/config.yml", "version: 2\nnonsense: 1\n");
    const broken = await sandbox.run("hooks", "install", "--json");
    expect(broken.code).toBe(ExitCode.Usage);
    expect(errorOf(broken).message).toContain('unknown key "nonsense"');
    expect(await sandbox.exists(".claude")).toBe(false);
    await sandbox.write(".tasks/config.yml", "version: 2\nactors:\n  alice:\n");

    const result = await sandbox.run(
      "hooks",
      "install",
      "--actor",
      "alice",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<HooksInstallJson>()).toMatchObject({
      installed: true,
      actor: "alice",
    });
  });
});

describe("validate", () => {
  it("warns about an open task's assignee or claimant the roster lacks", async () => {
    sandbox = await treeSandbox({
      actors: { alice: null, tester: null },
      tasks: {
        a: { assignee: "bob" },
        b: { status: "IN_PROGRESS", claimed_by: "carol" },
        c: { status: "DONE", assignee: "dave" },
        d: { assignee: "alice" },
        e: { status: "IN_PROGRESS" },
      },
    });
    const result = await sandbox.run("validate", "--json");
    expect(result.code).toBe(0);
    const findings = result.json<ValidationJson>().findings;
    expect(
      findings.map(({ severity, kind, task }) => ({ severity, kind, task })),
    ).toEqual([
      { severity: "warning", kind: "unknown-actor", task: "a" },
      { severity: "warning", kind: "unknown-actor", task: "b" },
    ]);
    expect(findings[0]!.message).toBe(
      "is assigned to bob, who is not listed under actors: in config.yml (alice, tester); `tasks assign` a listed actor, or add the name there",
    );
    expect(findings[1]!.message).toContain(
      "is claimed by carol, who is not listed",
    );
  });

  it("reports nothing without a roster", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { assignee: "bob" }, b: { status: "IN_PROGRESS" } },
    });
    const result = await sandbox.run("validate", "--json");
    expect(result.code).toBe(0);
    expect(result.json<ValidationJson>().findings).toEqual([]);
  });
});

describe("tasks actors", () => {
  async function roster(): Promise<void> {
    sandbox = await treeSandbox({
      actors: ROSTER,
      tasks: {
        a: { assignee: "alice" },
        b: { status: "IN_PROGRESS", claimed_by: "alice" },
        c: { assignee: "zed" },
        d: { status: "DONE", assignee: "bob" },
        e: { status: "IN_PROGRESS" },
      },
    });
    await sandbox.project("backend", "../backend", {
      tasks: { x: { assignee: "alice" }, y: { assignee: "yuri" } },
    });
  }

  it("lists the roster in its order with counts across the trees, then the unlisted names", async () => {
    await roster();
    const result = await sandbox.run("actors", "--json");
    expect(result.code).toBe(0);
    expect(result.json<ActorsJson>()).toEqual({
      actor: "tester",
      via: null,
      projects: ["backend"],
      actors: [
        {
          actor: "alice",
          description: ROSTER.alice,
          listed: true,
          claimed: 1,
          assigned: 2,
        },
        {
          actor: "tester",
          description: null,
          listed: true,
          claimed: 1,
          assigned: 0,
        },
        {
          actor: "agent",
          description: ROSTER.agent,
          listed: true,
          claimed: 0,
          assigned: 0,
        },
        {
          actor: "yuri",
          description: null,
          listed: false,
          claimed: 0,
          assigned: 1,
        },
        {
          actor: "zed",
          description: null,
          listed: false,
          claimed: 0,
          assigned: 1,
        },
      ],
      unavailable: [],
    });

    const local = await sandbox.run("actors", "--local", "--json");
    const json = local.json<ActorsJson>();
    expect(json.projects).toEqual([]);
    expect(json.actors.map((row) => row.actor)).toEqual([
      "alice",
      "tester",
      "agent",
      "zed",
    ]);
    expect(json.actors[0]).toMatchObject({ claimed: 1, assigned: 1 });
  });

  it("marks the caller and the names to fix in its human output", async () => {
    await roster();
    const result = await sandbox.run("actors");
    expect(result.code).toBe(0);
    const out = plain(result.stdout);
    expect(out).toMatch(
      /^alice +maintainer; approves plans and does releases +1 claimed · 2 assigned$/m,
    );
    expect(out).toMatch(/^tester \(you\) +1 claimed$/m);
    expect(out).toMatch(/^agent +the coding agent +—$/m);
    expect(out).toMatch(
      /^zed +not listed in this tree's config.yml +1 assigned$/m,
    );
    expect(out).toContain("3 listed actors · projects backend");
  });

  it("shows the caller and the names in use when nothing is listed", async () => {
    sandbox = await treeSandbox({ tasks: { a: { assignee: "alice" } } });
    const result = await sandbox.run("actors", "--json");
    expect(result.json<ActorsJson>().actors).toEqual([
      {
        actor: "alice",
        description: null,
        listed: false,
        claimed: 0,
        assigned: 1,
      },
      {
        actor: "tester",
        description: null,
        listed: false,
        claimed: 0,
        assigned: 0,
      },
    ]);
    expect(plain((await sandbox.run("actors")).stdout)).toContain(
      "config.yml lists no actors: any name may be assigned",
    );
  });
});
