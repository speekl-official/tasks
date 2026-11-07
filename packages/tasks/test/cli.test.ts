import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { VERSION, buildCli } from "../src/cli.js";
import type { HeartbeatJson } from "../src/commands/heartbeat.js";
import type { InitJson } from "../src/commands/init.js";
import { LIST_FILTERS } from "../src/commands/list.js";
import type { ResumeJson } from "../src/commands/resume.js";
import type { ShowJson } from "../src/commands/show.js";
import { readSession } from "../src/core/sessions.js";
import { SKILLS_RELATIVE_DIR, SKILL_NAME } from "../src/core/skill.js";
import {
  configTemplate,
  defaultRoster,
  gitignoreTemplate,
  readmeTemplate,
} from "../src/core/templates.js";
import { formatIso } from "../src/core/time.js";
import type {
  CollectionJson,
  SessionCheckJson,
  SessionEndJson,
} from "../src/core/types.js";
import { SITUATIONS } from "../src/core/types.js";
import { ExitCode } from "../src/errors.js";
import type { TreeSpec } from "./fixtures.js";
import type { CliResult, Sandbox } from "./helpers.js";
import { makeSandbox, treeSandbox } from "./helpers.js";

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

/** Colour depends on the terminal the suite runs in; the words do not. */
function plain(text: string): string {
  return stripVTControlCharacters(text);
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** The error envelope: one JSON document on stderr and nothing on stdout. */
function envelope(result: CliResult): ErrorJson {
  expect(result.stdout).toBe("");
  return JSON.parse(result.stderr) as ErrorJson;
}

function collection(result: CliResult): CollectionJson {
  expect(result.code).toBe(ExitCode.Success);
  return result.json<CollectionJson>();
}

function ids(result: CliResult): string[] {
  return collection(result).tasks.map((task) => task.id);
}

/** The commands this module registers, every one of which takes --json. */
const CLI_COMMANDS = [
  "init",
  "show",
  "resume",
  "ready",
  "mine",
  "actors",
  "list",
  "tree",
  "heartbeat",
  "session-end",
  "session-check",
];

/** A stored status as a word of its own: what overviews must not print. */
const STATUS_WORD = /\b(?:BACKLOG|TODO|IN_PROGRESS|PAUSED|DONE|CANCELLED)\b/;

/** Every file and directory under `dir`, with file contents. */
async function filesUnder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const key = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[`${key}/`] = "";
        await walk(full);
      } else {
        out[key] = await fs.readFile(full, "utf8");
      }
    }
  };
  await walk(dir);
  return out;
}

/** One task in each situation, by the precedence table. */
const SITUATION_TREE: TreeSpec = {
  tasks: {
    d1: { status: "DONE" },
    c1: { status: "CANCELLED" },
    w1: { status: "IN_PROGRESS" },
    p1: { status: "BACKLOG", state: true },
    b1: { status: "BACKLOG" },
    hold: { assignee: "alice" },
    "hold/part": {},
    wt: { status: "PAUSED", assignee: "alice", state: true },
    bl: { depends_on: ["b1"] },
    cl: {},
    "cl/x": { status: "DONE" },
    op: {},
    "op/y": {},
    r1: {},
  },
};

/** What each `list` flag selects from `SITUATION_TREE`, in id order. */
const SITUATION_ROWS: Record<string, string[]> = {
  ready: ["op/y", "r1"],
  blocked: ["bl"],
  waiting: ["wt"],
  assigned: ["hold"],
  held: ["hold/part"],
  working: ["w1"],
  parked: ["p1"],
  backlog: ["b1"],
  closable: ["cl"],
  open: ["op"],
  done: ["cl/x", "d1"],
  cancelled: ["c1"],
  resolved: ["c1", "cl/x", "d1"],
};

/** The open tasks of `SITUATION_TREE`, as `list` shows them by default. */
const OPEN_ROWS = [
  "b1",
  "bl",
  "cl",
  "hold",
  "hold/part",
  "op",
  "op/y",
  "p1",
  "r1",
  "w1",
  "wt",
];

/* ------------------------------------------------------------------------ */
/* The program                                                              */
/* ------------------------------------------------------------------------ */

describe("the program", () => {
  it("lists every registered command and the global options in --help", async () => {
    sandbox = await makeSandbox();
    const result = await sandbox.run("--help");
    expect(result.code).toBe(ExitCode.Success);

    const names = buildCli().commands.map((command) => command.name());
    expect(names).toEqual(
      expect.arrayContaining([...CLI_COMMANDS, "skill", "hooks"]),
    );
    for (const name of names) {
      expect(result.stdout).toMatch(new RegExp(`^ {2}${name}\\b`, "m"));
    }
    expect(result.stdout).toContain("-C, --dir <dir>");
    expect(result.stdout).toContain("--as <actor>");
    expect(result.stdout).toContain("--session <token>");
  });

  it("shows the global options in every command's help, and --json where there is output", async () => {
    sandbox = await makeSandbox();
    for (const command of buildCli().commands) {
      const result = await sandbox.run(command.name(), "--help");
      expect(result.code).toBe(ExitCode.Success);
      expect(result.stdout).toContain("-C, --dir <dir>");
      expect(result.stdout).toContain("--as <actor>");
      expect(result.stdout).toContain("--session <token>");
    }
    for (const name of CLI_COMMANDS) {
      expect((await sandbox.run(name, "--help")).stdout).toContain("--json");
    }
  });

  it("prints the version with -v", async () => {
    sandbox = await makeSandbox();
    const result = await sandbox.run("-v");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it("accepts the global options after the command name", async () => {
    sandbox = await treeSandbox({ tasks: { a: { assignee: "alice" } } });

    const asTester = await sandbox.run("show", "a", "--json");
    expect(asTester.json<ShowJson>().ready).toBe(false);
    const asAlice = await sandbox.run("show", "a", "--as", "alice", "--json");
    expect(asAlice.code).toBe(ExitCode.Success);
    expect(asAlice.json<ShowJson>().ready).toBe(true);

    expect((await readSession(sandbox.tasksDir, "s1")).exists).toBe(false);
    expect((await sandbox.run("list", "--session", "s1")).code).toBe(
      ExitCode.Success,
    );
    expect((await readSession(sandbox.tasksDir, "s1")).exists).toBe(true);

    const outside = { cwd: sandbox.root };
    expect(
      ids(await sandbox.runWith(outside, "list", "-C", "repo", "--json")),
    ).toEqual(["a"]);
    expect(
      ids(await sandbox.runWith(outside, "-C", "repo", "list", "--json")),
    ).toEqual(["a"]);
  });

  it("discovers the tree upwards from -C", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await fs.mkdir(path.join(sandbox.dir, "src", "deep"), { recursive: true });
    const result = await sandbox.runWith(
      { cwd: sandbox.root },
      "-C",
      path.join("repo", "src", "deep"),
      "list",
      "--json",
    );
    expect(ids(result)).toEqual(["a"]);
  });

  it("answers an unknown command, an unknown option and a missing argument as usage", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });

    const command = await sandbox.run("bogus");
    expect(command.code).toBe(ExitCode.Usage);
    expect(command.stderr).toContain("bogus");
    const commandJson = await sandbox.run("bogus", "--json");
    expect(commandJson.code).toBe(ExitCode.Usage);
    expect(envelope(commandJson).error.code).toBe("USAGE");

    const option = await sandbox.run("list", "--bogus");
    expect(option.code).toBe(ExitCode.Usage);
    expect(option.stderr).toContain("--bogus");
    const optionJson = await sandbox.run("list", "--bogus", "--json");
    expect(optionJson.code).toBe(ExitCode.Usage);
    expect(envelope(optionJson).error).toMatchObject({ code: "USAGE" });

    const missing = await sandbox.run("show", "--json");
    expect(missing.code).toBe(ExitCode.Usage);
    expect(envelope(missing).error.message).toContain("task");
  });

  it("fails as not found without a tree, naming tasks init", async () => {
    sandbox = await makeSandbox();
    const text = await sandbox.run("list");
    expect(text.code).toBe(ExitCode.NotFound);
    expect(text.stderr).toContain("tasks init");

    const json = await sandbox.run("ready", "--json");
    expect(json.code).toBe(ExitCode.NotFound);
    expect(envelope(json).error.code).toBe("NOT_FOUND");
  });

  it("refuses a v1 tree as usage naming tasks migrate", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.write(".tasks/config.yml", "version: 1\n");
    for (const name of ["list", "ready"]) {
      const text = await sandbox.run(name);
      expect(text.code).toBe(ExitCode.Usage);
      expect(text.stderr).toContain("tasks migrate");

      const json = await sandbox.run(name, "--json");
      expect(json.code).toBe(ExitCode.Usage);
      expect(envelope(json).error).toMatchObject({
        code: "USAGE",
        details: { upgrade: "tasks migrate" },
      });
    }
  });

  it("refuses a tree of an unsupported version", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.write(".tasks/config.yml", "version: 3\n");
    const result = await sandbox.run("tree");
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain("version 3");
  });

  it("rejects an actor or a session that fails the pattern", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect((await sandbox.run("list", "--as", "two words")).code).toBe(
      ExitCode.Usage,
    );
    expect((await sandbox.run("list", "--session", "bad/token")).code).toBe(
      ExitCode.Usage,
    );
    const env = { env: { TASKS_ACTOR: "no spaces" } };
    expect((await sandbox.runWith(env, "list")).code).toBe(ExitCode.Usage);
  });

  it("writes errors as the envelope on stderr, with the exit code of their kind", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });

    const usage = await sandbox.run("ready", "--scope", "a", "--all", "--json");
    expect(usage.code).toBe(ExitCode.Usage);
    expect(envelope(usage).error.code).toBe("USAGE");

    const notFound = await sandbox.run("show", "nope", "--json");
    expect(notFound.code).toBe(ExitCode.NotFound);
    expect(envelope(notFound).error).toMatchObject({
      code: "NOT_FOUND",
      details: { argument: "nope" },
    });

    const conflict = await sandbox.run("init", "--no-skill", "--json");
    expect(conflict.code).toBe(ExitCode.Conflict);
    expect(envelope(conflict).error.code).toBe("CONFLICT");
  });
});

describe("read commands", () => {
  it("write nothing without a session", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { design: true },
        "epic/a": {
          state: true,
          log: "## 2026-01-02T00:00:00Z tester\nnote: looked at it\n",
        },
        b: { status: "IN_PROGRESS" },
      },
    });
    const before = await filesUnder(sandbox.tasksDir);
    const runs: Array<[string[], number]> = [
      [["show", "a"], ExitCode.Success],
      [["resume", "a", "--json"], ExitCode.Success],
      [["ready"], ExitCode.Success],
      [["mine", "--json"], ExitCode.Success],
      [["actors"], ExitCode.Success],
      [["list"], ExitCode.Success],
      [["list", "--resolved", "--json"], ExitCode.Success],
      [["tree"], ExitCode.Success],
      // `b` is claimed without a session and has no state.md.
      [["session-check"], ExitCode.Conflict],
    ];
    for (const [argv, code] of runs) {
      expect((await sandbox.run(...argv)).code, argv.join(" ")).toBe(code);
    }
    expect(await filesUnder(sandbox.tasksDir)).toEqual(before);
  });
});

/* ------------------------------------------------------------------------ */
/* init                                                                     */
/* ------------------------------------------------------------------------ */

describe("init", () => {
  it("scaffolds config.yml, README.md, .gitignore and .locks/, and prints the actor", async () => {
    sandbox = await makeSandbox();
    const result = await sandbox.run("init", "--no-skill");
    expect(result.code).toBe(ExitCode.Success);

    expect(await sandbox.read(".tasks/config.yml")).toBe(
      configTemplate({ actors: defaultRoster("tester") }),
    );
    expect(await sandbox.read(".tasks/README.md")).toBe(readmeTemplate());
    expect(await sandbox.read(".tasks/.gitignore")).toBe(gitignoreTemplate());
    const locks = await fs.stat(path.join(sandbox.tasksDir, ".locks"));
    expect(locks.isDirectory()).toBe(true);

    const out = plain(result.stdout);
    expect(out).toContain(`Initialized .tasks/ at ${sandbox.tasksDir}`);
    expect(out).toMatch(/^ {2}actor: tester \(/m);
    for (const name of ["config.yml", "README.md", ".gitignore"]) {
      expect(out).toContain(path.join(".tasks", name));
    }
    expect(out).toContain(path.join(".tasks", ".locks") + path.sep);

    // The scaffold is a tree every other command opens.
    expect(ids(await sandbox.run("list", "--json"))).toEqual([]);
  });

  it("prints the principal and the operator under --as", async () => {
    sandbox = await makeSandbox();
    const text = await sandbox.run("init", "--no-skill", "--as", "alice");
    expect(plain(text.stdout)).toMatch(/^ {2}actor: alice via tester \(/m);

    await fs.rm(sandbox.tasksDir, { recursive: true });
    const json = await sandbox.run(
      "init",
      "--no-skill",
      "--as",
      "alice",
      "--json",
    );
    expect(json.json<InitJson>()).toMatchObject({
      actor: "alice",
      via: "tester",
    });
  });

  it("emits its JSON shape and installs the skill", async () => {
    sandbox = await makeSandbox();
    const result = await sandbox.run("init", "--json");
    expect(result.code).toBe(ExitCode.Success);

    const json = result.json<InitJson>();
    expect(Object.keys(json)).toEqual([
      "actor",
      "via",
      "actors",
      "tasksDir",
      "created",
      "skill",
    ]);
    expect(json).toMatchObject({
      actor: "tester",
      via: null,
      tasksDir: sandbox.tasksDir,
    });
    expect(json.created).toEqual(
      ["config.yml", "README.md", ".gitignore", ".locks"].map((name) =>
        path.join(sandbox.tasksDir, name),
      ),
    );
    const skillDir = path.join(sandbox.dir, ".claude", "skills", "tasks");
    expect(json.skill).toMatchObject({ installed: true, dir: skillDir });
    expect(json.skill?.files).toContain(path.join(skillDir, "SKILL.md"));
    expect(await sandbox.exists(".claude/skills/tasks/SKILL.md")).toBe(true);
  });

  it("names the resolved actor and agent in the commented actors example", async () => {
    sandbox = await makeSandbox();
    const result = await sandbox.run(
      "init",
      "--no-skill",
      "--as",
      "alice",
      "--json",
    );
    expect(result.json<InitJson>().actors).toBeNull();
    expect(await sandbox.read(".tasks/config.yml")).toContain(
      "# actors:\n#   alice:\n#   agent: the coding agent\n",
    );
    const listed = await sandbox.run("actors", "--json");
    expect(
      listed
        .json<{ actors: { listed: boolean }[] }>()
        .actors.every((row) => !row.listed),
    ).toBe(true);
  });

  it("writes the roster live with --actors: the resolved actor and agent, or the names given", async () => {
    sandbox = await makeSandbox();
    const result = await sandbox.run(
      "init",
      "--no-skill",
      "--actors",
      "--json",
    );
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<InitJson>().actors).toEqual(["tester", "agent"]);
    expect(await sandbox.read(".tasks/config.yml")).toContain(
      "\nactors:\n  tester:\n  agent: the coding agent\n",
    );
    const listed = await sandbox.run("actors", "--json");
    expect(
      listed
        .json<{ actors: { actor: string; listed: boolean }[] }>()
        .actors.map((row) => [row.actor, row.listed]),
    ).toEqual([
      ["tester", true],
      ["agent", true],
    ]);
    // The roster is on from the first command.
    expect((await sandbox.run("new", "a", "A", "--assign", "bob")).code).toBe(
      ExitCode.Usage,
    );

    await fs.rm(sandbox.tasksDir, { recursive: true });
    const named = await sandbox.run(
      "init",
      "--no-skill",
      "--actors",
      " alice, agent,,dan ",
      "--json",
    );
    expect(named.json<InitJson>().actors).toEqual(["alice", "agent", "dan"]);
    expect(await sandbox.read(".tasks/config.yml")).toContain(
      "\nactors:\n  alice:\n  agent: the coding agent\n  dan:\n",
    );
  });

  it("refuses a bare --actors when it runs as agent, and quotes a name YAML would retype", async () => {
    sandbox = await makeSandbox();
    const bare = await sandbox.runWith(
      { env: { TASKS_ACTOR: "agent" } },
      "init",
      "--no-skill",
      "--actors",
      "--json",
    );
    expect(bare.code).toBe(ExitCode.Usage);
    expect(await sandbox.exists(".tasks")).toBe(false);

    const named = await sandbox.run(
      "init",
      "--no-skill",
      "--actors",
      "007,agent",
      "--json",
    );
    expect(named.json<InitJson>().actors).toEqual(["007", "agent"]);
    expect(await sandbox.read(".tasks/config.yml")).toContain(
      '\nactors:\n  "007":\n  agent: the coding agent\n',
    );
    const listed = await sandbox.run("actors", "--json");
    expect(
      listed
        .json<{ actors: { actor: string; listed: boolean }[] }>()
        .actors.map((row) => row.actor),
    ).toEqual(["007", "agent", "tester"]);
  });

  it("prints the roster it wrote, or how to switch one on", async () => {
    sandbox = await makeSandbox();
    const on = await sandbox.run("init", "--no-skill", "--actors", "ada,agent");
    expect(plain(on.stdout)).toMatch(
      /^ {2}actors: ada, agent \(listed in config\.yml/m,
    );
    await fs.rm(sandbox.tasksDir, { recursive: true });
    const off = await sandbox.run("init", "--no-skill");
    expect(plain(off.stdout)).toMatch(
      /^ {2}actors: none listed; uncomment actors: in config\.yml/m,
    );
  });

  it("refuses --actors with a bad name, an empty list or an existing config.yml, writing nothing", async () => {
    sandbox = await makeSandbox();
    const bad = await sandbox.run(
      "init",
      "--no-skill",
      "--actors",
      "two words",
      "--json",
    );
    expect(bad.code).toBe(ExitCode.Usage);
    expect(await sandbox.exists(".tasks")).toBe(false);
    const empty = await sandbox.run(
      "init",
      "--no-skill",
      "--actors",
      " , ",
      "--json",
    );
    expect(empty.code).toBe(ExitCode.Usage);
    expect(await sandbox.exists(".tasks")).toBe(false);

    await sandbox.run("init", "--no-skill");
    await fs.rm(path.join(sandbox.tasksDir, "README.md"));
    const existing = await sandbox.run(
      "init",
      "--no-skill",
      "--force",
      "--actors",
      "--json",
    );
    expect(existing.code).toBe(ExitCode.Usage);
    expect(
      (JSON.parse(existing.stderr) as { error: { details: unknown } }).error
        .details,
    ).toMatchObject({ option: "--actors" });
    expect(await sandbox.exists(".tasks/README.md")).toBe(false);
  });

  it("skips the skill with --no-skill", async () => {
    sandbox = await makeSandbox();
    const result = await sandbox.run("init", "--no-skill", "--json");
    expect(result.json<InitJson>().skill).toBeNull();
    expect(await sandbox.exists(".claude")).toBe(false);
  });

  it("refuses an existing tree without --force", async () => {
    sandbox = await makeSandbox();
    expect((await sandbox.run("init", "--no-skill")).code).toBe(
      ExitCode.Success,
    );
    const again = await sandbox.run("init", "--no-skill");
    expect(again.code).toBe(ExitCode.Conflict);
    expect(again.stderr).toContain("--force");
  });

  it("keeps an edited config under --force and writes only what is missing", async () => {
    sandbox = await makeSandbox();
    await sandbox.run("init", "--no-skill");
    await sandbox.write(".tasks/config.yml", "version: 2\nscope: mine\n");
    await fs.rm(path.join(sandbox.tasksDir, "README.md"));

    const result = await sandbox.run("init", "--no-skill", "--force", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<InitJson>().created).toEqual([
      path.join(sandbox.tasksDir, "README.md"),
    ]);
    expect(await sandbox.read(".tasks/config.yml")).toBe(
      "version: 2\nscope: mine\n",
    );
    expect(await sandbox.read(".tasks/README.md")).toBe(readmeTemplate());

    const complete = await sandbox.run("init", "--no-skill", "--force");
    expect(plain(complete.stdout)).toContain("nothing to create");
  });

  it("leaves an installed skill alone", async () => {
    sandbox = await makeSandbox();
    await sandbox.run("init");
    await sandbox.write(".claude/skills/tasks/SKILL.md", "edited\n");

    const result = await sandbox.run("init", "--force", "--json");
    expect(result.json<InitJson>().skill).toMatchObject({
      installed: false,
      files: [],
    });
    expect(await sandbox.read(".claude/skills/tasks/SKILL.md")).toBe(
      "edited\n",
    );
    const text = await sandbox.run("init", "--force");
    expect(plain(text.stdout)).toContain("skill install --force");
  });

  it("scaffolds the directory -C names", async () => {
    sandbox = await makeSandbox();
    await fs.mkdir(path.join(sandbox.dir, "nested"));
    const result = await sandbox.run(
      "-C",
      "nested",
      "init",
      "--no-skill",
      "--json",
    );
    expect(result.json<InitJson>().tasksDir).toBe(
      path.join(sandbox.dir, "nested", ".tasks"),
    );
    expect(await sandbox.exists("nested/.tasks/config.yml")).toBe(true);
    expect(await sandbox.exists(".tasks")).toBe(false);

    const missing = await sandbox.run("-C", "absent", "init", "--no-skill");
    expect(missing.code).toBe(ExitCode.NotFound);
  });

  it("refuses a v1 tree, even with --force, naming tasks migrate", async () => {
    sandbox = await makeSandbox();
    await sandbox.write(".tasks/config.yml", "version: 1\n");
    for (const extra of [[], ["--force"]]) {
      const result = await sandbox.run("init", "--no-skill", ...extra);
      expect(result.code).toBe(ExitCode.Usage);
      expect(result.stderr).toContain("tasks migrate");
    }
    expect(await sandbox.read(".tasks/config.yml")).toBe("version: 1\n");
    expect(await sandbox.exists(".tasks/README.md")).toBe(false);

    // Without config.yml, a phase directory is what makes it a v1 tree.
    await fs.rm(path.join(sandbox.tasksDir, "config.yml"));
    await sandbox.write(".tasks/backend/login.md", "---\nid: login\n---\n");
    const phase = await sandbox.run("init", "--no-skill", "--force");
    expect(phase.code).toBe(ExitCode.Usage);
    expect(await sandbox.exists(".tasks/config.yml")).toBe(false);
  });

  it("completes an unfinished scaffold under --force", async () => {
    sandbox = await makeSandbox();
    await fs.mkdir(sandbox.tasksDir);
    await sandbox.write(".tasks/.gitignore", ".locks/\n");
    expect((await sandbox.run("init", "--no-skill")).code).toBe(
      ExitCode.Conflict,
    );

    const result = await sandbox.run("init", "--no-skill", "--force", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<InitJson>().created).toEqual(
      ["config.yml", "README.md", ".locks"].map((name) =>
        path.join(sandbox.tasksDir, name),
      ),
    );
    expect(await sandbox.read(".tasks/.gitignore")).toBe(".locks/\n");
  });

  it("touches the registry of the new tree when a session is known", async () => {
    sandbox = await makeSandbox();
    const bad = await sandbox.run("init", "--no-skill", "--session", "a b");
    expect(bad.code).toBe(ExitCode.Usage);
    expect(await sandbox.exists(".tasks")).toBe(false);

    const result = await sandbox.session("s1")("init", "--no-skill");
    expect(result.code).toBe(ExitCode.Success);
    expect(await sandbox.exists(".tasks/.locks/sessions/s1")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* show and resume                                                          */
/* ------------------------------------------------------------------------ */

describe("show", () => {
  it("emits the task object with derived conditions, body, workspace and referrers", async () => {
    sandbox = await treeSandbox({
      tasks: {
        a: {
          status: "PAUSED",
          priority: "high",
          depends_on: ["b"],
          state: true,
          design: true,
          log: "## 2026-01-02T00:00:00Z tester s:s0\npause: IN_PROGRESS → PAUSED\nHalfway there.\n",
          body: "# Alpha\n\nThe body.\n",
        },
        b: {},
        c: { finishes_after: ["a"] },
      },
    });
    await sandbox.project("backend", "../backend", {
      tasks: { x: { depends_on: ["../repo:a"] } },
    });

    const result = await sandbox.run("show", "a", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<ShowJson>()).toEqual({
      id: "a",
      name: "a",
      parent: null,
      project: null,
      title: "Alpha",
      status: "PAUSED",
      priority: "high",
      depends_on: ["b"],
      finishes_after: [],
      assignee: null,
      claimed_by: null,
      claimed_at: null,
      claimed_session: null,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      path: path.join(sandbox.tasksDir, "a"),
      situation: "blocked",
      blocked_by: [{ ref: "b", reason: "not-done", status: "TODO" }],
      ready: false,
      effective_priority: "high",
      held_by: null,
      started: true,
      children: { open: 0, resolved: 0 },
      active: false,
      waiting_for: null,
      closable: false,
      liveness: null,
      last_seen: null,
      last_entry: {
        time: "2026-01-02T00:00:00Z",
        actor: "tester",
        via: null,
        session: "s0",
        text: "pause: IN_PROGRESS → PAUSED\nHalfway there.",
      },
      body: "# Alpha\n\nThe body.",
      workspace: ["state.md", "design.md", "log.md"],
      referenced_by: ["c", "backend:x"],
    });
  });

  it("prints the stored status beside the situation", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "PAUSED", state: true, depends_on: ["b"] }, b: {} },
    });
    const out = plain((await sandbox.run("show", "a")).stdout);
    expect(out).toMatch(/status\s+PAUSED/);
    expect(out).toMatch(/situation\s+blocked by b/);
    expect(out).toContain("# a");
  });

  it("resolves a unique suffix and names the candidates of an ambiguous one", async () => {
    sandbox = await treeSandbox({
      tasks: { "epic/part": {}, "a/tests": {}, "b/tests": {} },
    });
    const unique = await sandbox.run("show", "part", "--json");
    expect(unique.json<ShowJson>().id).toBe("epic/part");

    const ambiguous = await sandbox.run("show", "tests", "--json");
    expect(ambiguous.code).toBe(ExitCode.Usage);
    expect(envelope(ambiguous).error.details).toMatchObject({
      argument: "tests",
      candidates: ["a/tests", "b/tests"],
    });
  });

  it("fails as not found for a missing task and for an archived-only path", async () => {
    sandbox = await treeSandbox({
      tasks: { a: {} },
      archived: { old: { status: "DONE" } },
    });
    expect((await sandbox.run("show", "nope")).code).toBe(ExitCode.NotFound);

    const archived = await sandbox.run("show", "old", "--json");
    expect(archived.code).toBe(ExitCode.NotFound);
    expect(envelope(archived).error.details).toMatchObject({
      id: "old",
      archived: true,
    });
  });

  it("addresses a listed project by alias; a bare suffix stays local", async () => {
    sandbox = await treeSandbox({ tasks: { "kernel/tests": {} } });
    await sandbox.project("backend", "../backend", {
      tasks: { "kernel/tests": { status: "DONE" }, "api/tests": {} },
    });

    const foreign = await sandbox.run("show", "backend:kernel/tests", "--json");
    expect(foreign.json<ShowJson>()).toMatchObject({
      id: "backend:kernel/tests",
      project: "backend",
      status: "DONE",
      situation: "done",
    });
    const local = await sandbox.run("show", "tests", "--json");
    expect(local.json<ShowJson>().id).toBe("kernel/tests");

    const ambiguous = await sandbox.run("show", "backend:tests", "--json");
    expect(ambiguous.code).toBe(ExitCode.Usage);
    expect(envelope(ambiguous).error.details?.candidates).toEqual([
      "backend:api/tests",
      "backend:kernel/tests",
    ]);

    const unknown = await sandbox.run("show", "nowhere:tests");
    expect(unknown.code).toBe(ExitCode.Usage);
  });

  it("names a listed project that is not checked out", async () => {
    sandbox = await treeSandbox({ projects: { gone: "../gone" } });
    const result = await sandbox.run("show", "gone:x", "--json");
    expect(result.code).toBe(ExitCode.NotFound);
    expect(envelope(result).error.details).toMatchObject({
      alias: "gone",
      reason: "not-checked-out",
    });
  });

  it("refuses a listed v1 tree, naming its migration", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const old = await sandbox.project("old", "../old", { tasks: { x: {} } });
    await fs.writeFile(path.join(old, ".tasks", "config.yml"), "version: 1\n");

    const shown = await sandbox.run("show", "old:x", "--json");
    expect(shown.code).toBe(ExitCode.Usage);
    expect(envelope(shown).error.details).toMatchObject({
      alias: "old",
      upgrade: "tasks migrate old",
    });
    const listed = await sandbox.run("list");
    expect(listed.code).toBe(ExitCode.Success);
    expect(plain(listed.stdout)).toContain(
      "old not shown: a .tasks v1 tree; upgrade it with `tasks migrate old`",
    );
  });

  it("refuses a malformed manifest as a conflict naming the file", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(".tasks/broken/task.md", "nonsense\n");
    const result = await sandbox.run("show", "broken", "--json");
    expect(result.code).toBe(ExitCode.Conflict);
    expect(envelope(result).error.details).toMatchObject({
      id: "broken",
      kind: "malformed",
    });
  });
});

describe("resume", () => {
  const RESUME_TREE: TreeSpec = {
    tasks: {
      program: { design: true, title: "Program" },
      "program/epic": { plan: true, title: "Epic" },
      "program/epic/task": {
        status: "IN_PROGRESS",
        claimed_session: "s1",
        state: "## Done\n\nThe schema.\n\n## Next\n\nThe migration.\n",
        log: "## 2026-01-03T00:00:00Z tester s:s1\nclaim: TODO → IN_PROGRESS\nPicked up.\n",
        body: "# Task\n\nDo it.\n",
      },
      "program/epic/task/one": { status: "DONE" },
      "program/epic/task/two": {},
    },
  };

  it("emits the ancestors root first, the children, the workspace and state.md in full", async () => {
    sandbox = await treeSandbox(RESUME_TREE);
    const result = await sandbox.session("s1")("resume", "task", "--json");
    expect(result.code).toBe(ExitCode.Success);

    const json = result.json<ResumeJson>();
    expect(json).toMatchObject({
      id: "program/epic/task",
      parent: "program/epic",
      status: "IN_PROGRESS",
      situation: "working",
      liveness: "live",
      children: { open: 1, resolved: 1 },
      workspace: ["state.md", "log.md"],
      state: "## Done\n\nThe schema.\n\n## Next\n\nThe migration.\n",
      referenced_by: [],
      body: "# Task\n\nDo it.",
      last_entry: {
        time: "2026-01-03T00:00:00Z",
        actor: "tester",
        via: null,
        session: "s1",
        text: "claim: TODO → IN_PROGRESS\nPicked up.",
      },
    });
    expect(json.ancestors).toEqual([
      {
        id: "program",
        title: "Program",
        status: "TODO",
        workspace: ["design.md"],
      },
      {
        id: "program/epic",
        title: "Epic",
        status: "TODO",
        workspace: ["plan.md"],
      },
    ]);
    expect(
      json.child_tasks.map((child) => [child.id, child.situation]),
    ).toEqual([
      ["program/epic/task/one", "done"],
      ["program/epic/task/two", "held"],
    ]);
    expect(json.child_tasks[1]).toMatchObject({
      held_by: "program/epic/task",
      ready: false,
    });
  });

  it("prints the reading order for a person", async () => {
    sandbox = await treeSandbox(RESUME_TREE);
    const out = plain(
      (await sandbox.run("resume", "program/epic/task")).stdout,
    );
    const order = [
      "Ancestors",
      "program/epic ",
      "Children",
      "program/epic/task/two",
      "Workspace",
      "The migration.",
      "Last entry",
      "Picked up.",
    ].map((fragment) => out.indexOf(fragment));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("says when there is no resume point yet", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const json = await sandbox.run("resume", "a", "--json");
    expect(json.json<ResumeJson>()).toMatchObject({
      state: null,
      ancestors: [],
      child_tasks: [],
      workspace: [],
      last_entry: null,
    });
    expect(plain((await sandbox.run("resume", "a")).stdout)).toContain(
      "No state.md yet",
    );
  });

  it("qualifies the ancestors of a task in a listed project", async () => {
    sandbox = await treeSandbox({});
    await sandbox.project("backend", "../backend", {
      tasks: { epic: {}, "epic/part": {} },
    });
    const result = await sandbox.run("resume", "backend:part", "--json");
    const json = result.json<ResumeJson>();
    expect(json.id).toBe("backend:epic/part");
    expect(json.ancestors.map((ancestor) => ancestor.id)).toEqual([
      "backend:epic",
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* ready                                                                    */
/* ------------------------------------------------------------------------ */

describe("ready", () => {
  it("orders by effective priority, then paused before todo, then oldest", async () => {
    sandbox = await treeSandbox({
      tasks: {
        hot: { priority: "urgent" },
        "hot/part": { created: "2026-02-01T00:00:00Z" },
        "late-high": { priority: "high", created: "2026-01-09T00:00:00Z" },
        "paused-new": {
          status: "PAUSED",
          state: true,
          created: "2026-01-05T00:00:00Z",
        },
        "todo-old": { created: "2026-01-02T00:00:00Z" },
        "todo-new": { created: "2026-01-04T00:00:00Z" },
        "low-old": { priority: "low", created: "2025-12-01T00:00:00Z" },
      },
    });
    const json = collection(await sandbox.run("ready", "--json"));
    expect(json.tasks.map((task) => task.id)).toEqual([
      "hot/part",
      "late-high",
      "paused-new",
      "todo-old",
      "todo-new",
      "low-old",
    ]);
    expect(json.tasks.every((task) => task.ready)).toBe(true);
    expect(json.tasks[0]?.effective_priority).toBe("urgent");
  });

  it("offers only free, unblocked tasks outside held and unscheduled subtrees", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/part": {},
        // A broken invariant: the BACKLOG ancestor still keeps it out.
        later: { status: "BACKLOG" },
        "later/part": {},
        claimed: { status: "IN_PROGRESS" },
        "claimed/part": {},
        owned: { assignee: "alice" },
        "owned/part": {},
        blocked: { depends_on: ["epic/part"] },
        theirs: { assignee: "alice" },
        yours: { assignee: "tester" },
        finished: { status: "DONE" },
      },
    });
    expect(ids(await sandbox.run("ready", "--json"))).toEqual([
      "epic/part",
      "yours",
    ]);
    expect(ids(await sandbox.run("ready", "--as", "alice", "--json"))).toEqual([
      "epic/part",
      "theirs",
    ]);
  });

  it("applies the configured scope; --scope replaces it and --all lifts it", async () => {
    sandbox = await treeSandbox({
      scope: "epic",
      tasks: { epic: {}, "epic/a": {}, "epic/b": {}, other: {} },
    });
    const scoped = collection(await sandbox.run("ready", "--json"));
    expect(scoped.scope).toBe("epic");
    expect(scoped.tasks.map((task) => task.id)).toEqual(["epic/a", "epic/b"]);

    const all = collection(await sandbox.run("ready", "--all", "--json"));
    expect(all.scope).toBeNull();
    expect(all.tasks.map((task) => task.id)).toEqual([
      "epic/a",
      "epic/b",
      "other",
    ]);

    const other = collection(
      await sandbox.run("ready", "--scope", "other", "--json"),
    );
    expect(other.scope).toBe("other");
    expect(other.tasks.map((task) => task.id)).toEqual(["other"]);
  });

  it("refuses --scope with --all, a scope that is no path, and one that names nothing", async () => {
    sandbox = await treeSandbox({ tasks: { epic: {} }, groups: ["area"] });
    expect((await sandbox.run("ready", "--scope", "epic", "--all")).code).toBe(
      ExitCode.Usage,
    );
    expect((await sandbox.run("ready", "--scope", "Not A Path")).code).toBe(
      ExitCode.Usage,
    );
    const nothing = await sandbox.run("ready", "--scope", "nope", "--json");
    expect(nothing.code).toBe(ExitCode.NotFound);
    expect(envelope(nothing).error.details).toEqual({ scope: "nope" });
    // A group is a scope like a task.
    expect(
      ids(await sandbox.run("ready", "--scope", "area", "--json")),
    ).toEqual([]);
  });

  it("warns about a configured scope that names nothing and still applies it", async () => {
    sandbox = await treeSandbox({ scope: "gone", tasks: { a: {} } });
    const result = await sandbox.run("ready", "--json");
    expect(collection(result)).toMatchObject({ scope: "gone", count: 0 });
    expect(result.stderr).toContain('scope "gone"');
  });

  it("spans the listed projects, qualifies their ids and interleaves them by the ready order", async () => {
    sandbox = await treeSandbox({
      scope: "epic",
      tasks: {
        a: { created: "2026-01-02T00:00:00Z" },
        epic: {},
        "epic/x": {},
      },
    });
    const backend = await sandbox.project("backend", "../backend", {
      // A listed tree's own scope never applies from here.
      scope: "elsewhere",
      tasks: {
        k: { created: "2025-12-31T00:00:00Z" },
        z: { priority: "high" },
      },
    });

    const json = collection(await sandbox.run("ready", "--json"));
    expect(json.scope).toBe("epic");
    expect(json.projects).toEqual(["backend"]);
    expect(json.tasks.map((task) => task.id)).toEqual([
      "backend:z",
      "backend:k",
      "epic/x",
    ]);
    expect(json.tasks[0]).toMatchObject({
      project: "backend",
      path: path.join(backend, ".tasks", "z"),
    });

    const all = collection(await sandbox.run("ready", "--all", "--json"));
    expect(all.tasks.map((task) => task.id)).toEqual([
      "backend:z",
      "backend:k",
      "epic/x",
      "a",
    ]);

    const local = collection(await sandbox.run("ready", "--local", "--json"));
    expect(local.projects).toEqual([]);
    expect(local.tasks.map((task) => task.id)).toEqual(["epic/x"]);
  });

  it("prints situations, qualified ids and a footer", async () => {
    sandbox = await treeSandbox({ scope: "epic", tasks: { "epic/x": {} } });
    await sandbox.project("backend", "../backend", { tasks: { k: {} } });
    const out = plain((await sandbox.run("ready")).stdout);
    expect(out).toMatch(/epic\/x\s+ready/);
    expect(out).toMatch(/backend:k\s+ready/);
    expect(out).toContain("2 tasks · scope epic · projects backend");
    expect(out).not.toMatch(STATUS_WORD);

    await sandbox.cleanup();
    sandbox = await treeSandbox({ tasks: { a: { status: "BACKLOG" } } });
    const empty = plain((await sandbox.run("ready")).stdout);
    expect(empty).toContain("Nothing is ready for you to take.");
    expect(empty).toContain("0 tasks");
  });
});

/* ------------------------------------------------------------------------ */
/* mine                                                                     */
/* ------------------------------------------------------------------------ */

describe("mine", () => {
  const MINE_TREE: TreeSpec = {
    tasks: {
      "this-session": {
        status: "IN_PROGRESS",
        claimed_session: "s1",
        state: true,
        log: "## 2026-01-03T00:00:00Z tester s:s1\nclaim: TODO → IN_PROGRESS\nStarted on the schema.\n",
      },
      "other-session": {
        status: "IN_PROGRESS",
        claimed_session: "s0",
        created: "2025-12-01T00:00:00Z",
      },
      inbox: {
        assignee: "tester",
        created: "2025-11-01T00:00:00Z",
        log: "## 2026-01-02T00:00:00Z alice\nassign tester\nPlease deploy after the review.\n",
      },
      waiting: { status: "PAUSED", assignee: "tester", state: true },
      theirs: { status: "IN_PROGRESS", claimed_by: "alice" },
      "assigned-done": { status: "DONE", assignee: "tester" },
      free: {},
    },
  };

  it("lists the open tasks the actor claimed or is assigned, this session's claims first", async () => {
    sandbox = await treeSandbox(MINE_TREE);
    const json = collection(await sandbox.session("s1")("mine", "--json"));
    expect(json.scope).toBeNull();
    expect(json.tasks.map((task) => task.id)).toEqual([
      "this-session",
      "other-session",
      "waiting",
      "inbox",
    ]);
    expect(json.tasks[0]).toMatchObject({ liveness: "live" });
    expect(json.tasks[3]?.last_entry).toEqual({
      time: "2026-01-02T00:00:00Z",
      actor: "alice",
      via: null,
      session: null,
      text: "assign tester\nPlease deploy after the review.",
    });

    // Without a session, both claims are equally someone else's run.
    expect(ids(await sandbox.run("mine", "--json"))).toEqual([
      "other-session",
      "this-session",
      "waiting",
      "inbox",
    ]);
  });

  it("renders each task's last log entry", async () => {
    sandbox = await treeSandbox(MINE_TREE);
    const out = plain((await sandbox.session("s1")("mine")).stdout);
    expect(out).toMatch(/this-session\s+working by tester\s+live/);
    expect(out).toContain("2026-01-02T00:00:00Z alice");
    expect(out).toContain("Please deploy after the review.");
    expect(out).toContain("2026-01-03T00:00:00Z tester s:s1");
    expect(out).toContain("4 tasks");
  });

  it("follows --as, ignores the configured scope and spans the listed projects", async () => {
    sandbox = await treeSandbox({
      scope: "elsewhere",
      groups: ["elsewhere"],
      tasks: { a: { assignee: "alice" }, b: { assignee: "tester" } },
    });
    await sandbox.project("backend", "../backend", {
      tasks: { x: { status: "IN_PROGRESS", claimed_by: "alice" } },
    });
    const json = collection(
      await sandbox.run("mine", "--as", "alice", "--json"),
    );
    expect(json.tasks.map((task) => task.id)).toEqual(["backend:x", "a"]);
    expect(json.projects).toEqual(["backend"]);

    const local = await sandbox.run(
      "mine",
      "--as",
      "alice",
      "--local",
      "--json",
    );
    expect(ids(local)).toEqual(["a"]);
  });

  it("says so when nothing is yours", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    expect(ids(await sandbox.run("mine", "--json"))).toEqual([]);
    expect(plain((await sandbox.run("mine")).stdout)).toContain(
      "Nothing claimed by or assigned to you.",
    );
  });
});

/* ------------------------------------------------------------------------ */
/* list and tree                                                            */
/* ------------------------------------------------------------------------ */

describe("list", () => {
  it("offers a flag for every situation, and --resolved", () => {
    expect(LIST_FILTERS.map(([name]) => name).sort()).toEqual(
      [...SITUATIONS, "resolved"].sort(),
    );
  });

  it("shows the open tasks by default, in tree order", async () => {
    sandbox = await treeSandbox(SITUATION_TREE);
    const json = collection(await sandbox.run("list", "--json"));
    expect(json).toMatchObject({ scope: null, projects: [], malformed: [] });
    expect(json.tasks.map((task) => task.id)).toEqual(OPEN_ROWS);
    expect(json.count).toBe(OPEN_ROWS.length);
  });

  it("filters by each situation", async () => {
    sandbox = await treeSandbox(SITUATION_TREE);
    for (const [name, expected] of Object.entries(SITUATION_ROWS)) {
      const result = await sandbox.run("list", `--${name}`, "--json");
      expect(ids(result), `--${name}`).toEqual(expected);
    }
  });

  it("combines situation flags with OR, resolved tasks included when asked for", async () => {
    sandbox = await treeSandbox(SITUATION_TREE);
    expect(
      ids(await sandbox.run("list", "--ready", "--blocked", "--json")),
    ).toEqual(["bl", "op/y", "r1"]);
    expect(
      ids(await sandbox.run("list", "--done", "--waiting", "--json")),
    ).toEqual(["cl/x", "d1", "wt"]);
    expect(
      ids(await sandbox.run("list", "--cancelled", "--resolved", "--json")),
    ).toEqual(["c1", "cl/x", "d1"]);
  });

  it("applies the configured scope, which --all lifts", async () => {
    sandbox = await treeSandbox({ ...SITUATION_TREE, scope: "op" });
    const scoped = collection(await sandbox.run("list", "--json"));
    expect(scoped.scope).toBe("op");
    expect(scoped.tasks.map((task) => task.id)).toEqual(["op", "op/y"]);
    expect(ids(await sandbox.run("list", "--all", "--json"))).toEqual(
      OPEN_ROWS,
    );
    expect(
      ids(await sandbox.run("list", "--scope", "cl", "--done", "--json")),
    ).toEqual(["cl/x"]);
  });

  it("lists malformed manifests in the collection and in the footer, within the scope", async () => {
    sandbox = await treeSandbox({ tasks: { a: {}, epic: {}, "epic/b": {} } });
    await sandbox.write(".tasks/broken/task.md", "nonsense\n");
    await sandbox.write(".tasks/epic/bad/task.md", "---\nstatus: NOPE\n---\n");

    const json = collection(await sandbox.run("list", "--json"));
    expect(json.malformed.map((entry) => entry.path)).toEqual([
      path.join(sandbox.tasksDir, "broken", "task.md"),
      path.join(sandbox.tasksDir, "epic", "bad", "task.md"),
    ]);
    expect(json.malformed[0]?.message).toEqual(expect.any(String));
    expect(json.tasks.map((task) => task.id)).toEqual(["a", "epic", "epic/b"]);

    const scoped = collection(
      await sandbox.run("list", "--scope", "epic", "--json"),
    );
    expect(scoped.malformed.map((entry) => entry.path)).toEqual([
      path.join(sandbox.tasksDir, "epic", "bad", "task.md"),
    ]);

    const out = plain((await sandbox.run("list")).stdout);
    expect(out).toContain(
      `malformed ${path.join(sandbox.tasksDir, "broken", "task.md")}`,
    );
  });

  it("spans the listed projects; the scope applies to the local tree only", async () => {
    sandbox = await treeSandbox({ scope: "epic", tasks: { a: {}, epic: {} } });
    await sandbox.project("backend", "../backend", {
      tasks: { k: {}, "k/sub": { status: "DONE" } },
    });
    const json = collection(await sandbox.run("list", "--json"));
    expect(json.projects).toEqual(["backend"]);
    expect(json.tasks.map((task) => task.id)).toEqual(["epic", "backend:k"]);
    expect(ids(await sandbox.run("list", "--done", "--json"))).toEqual([
      "backend:k/sub",
    ]);
    expect(ids(await sandbox.run("list", "--local", "--json"))).toEqual([
      "epic",
    ]);
  });

  it("notes a listed project it could not show", async () => {
    sandbox = await treeSandbox({
      tasks: { a: {} },
      projects: { gone: "../gone" },
    });
    expect(collection(await sandbox.run("list", "--json")).projects).toEqual(
      [],
    );
    expect(collection(await sandbox.run("list", "--json")).unavailable).toEqual(
      [{ alias: "gone", reason: "not-checked-out" }],
    );
    expect(
      collection(await sandbox.run("list", "--local", "--json")).unavailable,
    ).toEqual([]);
    const out = plain((await sandbox.run("list")).stdout);
    expect(out).toContain("gone not shown: not checked out");
    expect(plain((await sandbox.run("list", "--local")).stdout)).not.toContain(
      "not shown",
    );
  });
});

describe("tree", () => {
  const NESTED: TreeSpec = {
    tasks: {
      epic: { finishes_after: ["solo"] },
      "epic/a": {},
      "epic/a/deep": {},
      "epic/b": { status: "DONE" },
      solo: {},
    },
  };

  it("nests open tasks by containment, with resolved ones under --resolved", async () => {
    sandbox = await treeSandbox(NESTED);
    const lines = plain((await sandbox.run("tree")).stdout).split("\n");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^epic\s+open 1\/2/),
        expect.stringMatching(/^ {2}↳ after solo/),
        expect.stringMatching(/^ {2}a\s+open 0\/1/),
        expect.stringMatching(/^ {4}deep\s+ready/),
        expect.stringMatching(/^solo\s+ready/),
      ]),
    );
    expect(lines.some((line) => /^ {2}b\b/.test(line))).toBe(false);

    const resolved = plain((await sandbox.run("tree", "--resolved")).stdout);
    expect(resolved).toMatch(/^ {2}b\s+done/m);
  });

  it("emits the flat collection, every task carrying its parent", async () => {
    sandbox = await treeSandbox(NESTED);
    await sandbox.project("backend", "../backend", {
      tasks: { k: {}, "k/sub": {} },
    });
    const json = collection(await sandbox.run("tree", "--json"));
    expect(json.tasks.map((task) => [task.id, task.parent])).toEqual([
      ["epic", null],
      ["epic/a", "epic"],
      ["epic/a/deep", "epic/a"],
      ["solo", null],
      ["backend:k", null],
      ["backend:k/sub", "backend:k"],
    ]);
    const resolved = collection(
      await sandbox.run("tree", "--resolved", "--local", "--json"),
    );
    expect(resolved.tasks.map((task) => task.id)).toContain("epic/b");
  });
});

describe("overviews", () => {
  it("speak situation, never the stored status", async () => {
    sandbox = await treeSandbox(SITUATION_TREE);
    for (const argv of [
      ["list"],
      ["list", "--resolved"],
      ["ready"],
      ["tree", "--resolved"],
      ["mine"],
      ["mine", "--as", "alice"],
    ]) {
      const result = await sandbox.run(...argv);
      expect(result.code).toBe(ExitCode.Success);
      expect(plain(result.stdout), argv.join(" ")).not.toMatch(STATUS_WORD);
    }
    const out = plain((await sandbox.run("list")).stdout);
    for (const words of [
      "held by hold",
      "waiting for alice",
      "assigned alice",
      "blocked by b1",
      "open 0/1",
      "closable",
      "parked",
      "backlog",
      "working",
      "ready",
    ]) {
      expect(out).toContain(words);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Session commands                                                         */
/* ------------------------------------------------------------------------ */

describe("heartbeat", () => {
  it("is a usage error without a session, and writes nothing", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("heartbeat", "--json");
    expect(result.code).toBe(ExitCode.Usage);
    expect(envelope(result).error.message).toContain("TASKS_SESSION");
    expect(await sandbox.exists(".tasks/.locks")).toBe(false);
  });

  it("touches the registry of the local and every listed tree", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const backend = await sandbox.project("backend", "../backend", {});
    const backendTasks = path.join(backend, ".tasks");

    const result = await sandbox.run("heartbeat", "--session", "s1", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<HeartbeatJson>()).toEqual({
      session: "s1",
      touched: [sandbox.tasksDir, backendTasks],
    });
    for (const tasksDir of [sandbox.tasksDir, backendTasks]) {
      expect(await readSession(tasksDir, "s1")).toMatchObject({
        exists: true,
        ended: false,
      });
    }
  });

  it("takes the session from TASKS_SESSION", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const backend = await sandbox.project("backend", "../backend", {});
    const result = await sandbox.runWith(
      { env: { TASKS_SESSION: "s2" } },
      "heartbeat",
    );
    expect(result.code).toBe(ExitCode.Success);
    expect(plain(result.stdout)).toContain("session s2 is alive in 2 trees");
    expect((await readSession(path.join(backend, ".tasks"), "s2")).exists).toBe(
      true,
    );
  });

  it("keeps a claim live that a previous run left to age", async () => {
    sandbox = await treeSandbox({
      session_timeout_minutes: 30,
      tasks: {
        a: { status: "IN_PROGRESS", claimed_session: "s1", state: true },
      },
    });
    await sandbox.run("heartbeat", "--session", "s1");
    await sandbox.age(".tasks/.locks/sessions/s1", 60);
    const stale = await sandbox.run("show", "a", "--json");
    expect(stale.json<ShowJson>().liveness).toBe("orphaned");

    await sandbox.run("heartbeat", "--session", "s1");
    const live = await sandbox.run("show", "a", "--json");
    expect(live.json<ShowJson>().liveness).toBe("live");
  });
});

describe("session-end", () => {
  async function claimsInTwoTrees(): Promise<string> {
    sandbox = await treeSandbox({
      tasks: {
        a: { status: "IN_PROGRESS", claimed_session: "s1", state: true },
        b: { status: "IN_PROGRESS", claimed_session: "s0", state: true },
      },
    });
    return sandbox.project("backend", "../backend", {
      tasks: { x: { status: "IN_PROGRESS", claimed_session: "s1" } },
    });
  }

  it("marks the session ended in every tree and lists its claims, qualified", async () => {
    const backend = await claimsInTwoTrees();
    const before = Date.now();
    const result = await sandbox.run(
      "session-end",
      "--session",
      "s1",
      "--json",
    );
    expect(result.code).toBe(ExitCode.Success);

    const json = result.json<SessionEndJson>();
    expect(json).toMatchObject({ session: "s1", claims: ["a", "backend:x"] });
    expect(Date.parse(json.ended)).toBeGreaterThanOrEqual(before - 1000);
    for (const tasksDir of [sandbox.tasksDir, path.join(backend, ".tasks")]) {
      expect(await readSession(tasksDir, "s1")).toMatchObject({ ended: true });
    }
    expect(await sandbox.read(".tasks/.locks/sessions/s1")).toBe("ended\n");

    // Orphaned at once, without waiting for the timeout.
    const shown = await sandbox.run("show", "a", "--json");
    expect(shown.json<ShowJson>().liveness).toBe("orphaned");
  });

  it("is cleared by a later command of the same session", async () => {
    const backend = await claimsInTwoTrees();
    await sandbox.run("session-end", "--session", "s1");
    expect((await sandbox.run("list", "--session", "s1")).code).toBe(
      ExitCode.Success,
    );
    for (const tasksDir of [sandbox.tasksDir, path.join(backend, ".tasks")]) {
      expect(await readSession(tasksDir, "s1")).toMatchObject({
        exists: true,
        ended: false,
      });
    }
    const shown = await sandbox.run("show", "a", "--json");
    expect(shown.json<ShowJson>().liveness).toBe("live");
  });

  it("exits 0 for a session that holds no claim", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run(
      "session-end",
      "--session",
      "s9",
      "--json",
    );
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<SessionEndJson>().claims).toEqual([]);
    expect(
      plain((await sandbox.run("session-end", "--session", "s9")).stdout),
    ).toContain("it held no claims");
  });

  it("is a usage error without a session", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const result = await sandbox.run("session-end", "--json");
    expect(result.code).toBe(ExitCode.Usage);
    expect(envelope(result).error.code).toBe("USAGE");
  });

  it("prints the claims it orphaned", async () => {
    await claimsInTwoTrees();
    const out = plain(
      (await sandbox.run("session-end", "--session", "s1")).stdout,
    );
    expect(out).toContain("session s1 ended at");
    expect(out).toContain("orphaned claims: a, backend:x");
  });
});

describe("session-check", () => {
  it("passes for a claim taken from PAUSED, which carries its state.md", async () => {
    sandbox = await treeSandbox({
      tasks: {
        resumed: { status: "IN_PROGRESS", claimed_session: "s1", state: true },
      },
    });
    const result = await sandbox.session("s1")("session-check", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<SessionCheckJson>()).toEqual({
      ok: true,
      session: "s1",
      violations: [],
      warnings: [],
    });
    expect(
      plain((await sandbox.session("s1")("session-check")).stdout),
    ).toContain("every claimed task has a state.md");
  });

  it("fails with exit 4 and the violations for a claim without state.md", async () => {
    sandbox = await treeSandbox({
      tasks: {
        fresh: { status: "IN_PROGRESS", claimed_session: "s1" },
        resumed: { status: "IN_PROGRESS", claimed_session: "s1", state: true },
        elsewhere: { status: "IN_PROGRESS", claimed_session: "s0" },
      },
    });
    await sandbox.project("backend", "../backend", {
      tasks: { x: { status: "IN_PROGRESS", claimed_session: "s1" } },
    });
    const result = await sandbox.session("s1")("session-check", "--json");
    expect(result.code).toBe(ExitCode.Conflict);
    // The verdict is the command's output, not an error envelope.
    expect(result.stderr).toBe("");
    expect(result.json<SessionCheckJson>()).toEqual({
      ok: false,
      session: "s1",
      violations: [
        { id: "fresh", kind: "missing-state" },
        { id: "backend:x", kind: "missing-state" },
      ],
      warnings: [],
    });

    const text = await sandbox.session("s1")("session-check");
    expect(text.code).toBe(ExitCode.Conflict);
    expect(plain(text.stdout)).toContain("fresh: claimed without a state.md");
  });

  it("covers the actor's claims without a session when none is known", async () => {
    sandbox = await treeSandbox({
      tasks: {
        terminal: { status: "IN_PROGRESS" },
        "with-session": { status: "IN_PROGRESS", claimed_session: "s1" },
        "alice-terminal": { status: "IN_PROGRESS", claimed_by: "alice" },
      },
    });
    const own = await sandbox.run("session-check", "--json");
    expect(own.code).toBe(ExitCode.Conflict);
    expect(own.json<SessionCheckJson>()).toMatchObject({
      session: null,
      violations: [{ id: "terminal", kind: "missing-state" }],
    });

    const alice = await sandbox.run("session-check", "--as", "alice", "--json");
    expect(alice.json<SessionCheckJson>().violations).toEqual([
      { id: "alice-terminal", kind: "missing-state" },
    ]);
  });

  it("warns, without failing, about a state.md older than the claim or the last entry", async () => {
    const now = Date.now();
    const claimedAt = formatIso(new Date(now - 30 * 60_000));
    const logged = formatIso(new Date(now - 10 * 60_000));
    sandbox = await treeSandbox({
      tasks: {
        stale: {
          status: "IN_PROGRESS",
          claimed_session: "s1",
          claimed_at: claimedAt,
          state: true,
          log: `## ${logged} tester s:s1\nnote: moved on\n`,
        },
      },
    });
    await sandbox.age(".tasks/stale/state.md", 60);

    const result = await sandbox.session("s1")("session-check", "--json");
    expect(result.code).toBe(ExitCode.Success);
    const json = result.json<SessionCheckJson>();
    expect(json.ok).toBe(true);
    expect(json.warnings.map((warning) => warning.kind)).toEqual([
      "state-older-than-claim",
      "state-older-than-log",
    ]);
    expect(json.warnings.every((warning) => warning.id === "stale")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* Paths no other suite runs                                                */
/* ------------------------------------------------------------------------ */

describe("human output not covered elsewhere", () => {
  it("claim --next prints the task it took", async () => {
    sandbox = await treeSandbox({ tasks: { a: {}, b: { status: "BACKLOG" } } });
    const result = await sandbox.session("s1")("claim", "--next");
    expect(result.code).toBe(ExitCode.Success);
    expect(plain(result.stdout)).toBe("✓ claim a: TODO → IN_PROGRESS\n");
  });

  it("handoff prints the transition and whom the task now waits for", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "IN_PROGRESS", state: true }, "a/part": {} },
    });
    const result = await sandbox.run("handoff", "a", "alice", "-m", "review");
    expect(result.code).toBe(ExitCode.Success);
    expect(plain(result.stdout)).toBe(
      "✓ handoff a to alice: IN_PROGRESS → PAUSED\n  now holds 1 task\n",
    );
  });

  it("after add, list and rm speak of finishes_after", async () => {
    sandbox = await treeSandbox({
      tasks: { epic: {}, part: {}, dropped: { status: "CANCELLED" } },
    });

    const added = await sandbox.run("after", "add", "epic", "part", "dropped");
    expect(added.code).toBe(ExitCode.Success);
    expect(plain(added.stdout)).toBe(
      "✓ after add epic: part, dropped\n  finishes after: part, dropped\n",
    );

    const listed = await sandbox.run("after", "list", "epic");
    expect(listed.code).toBe(ExitCode.Success);
    const rows = plain(listed.stdout).split("\n");
    expect(rows[0]).toBe("epic finishes_after");
    // A cancelled join satisfies the finish gate; an open one does not.
    expect(rows.find((row) => row.includes("part"))).toMatch(
      /part\s+no\s+not-done \(TODO\)/,
    );
    expect(rows.find((row) => row.includes("dropped"))).toMatch(
      /dropped\s+yes\s+CANCELLED/,
    );

    const removed = await sandbox.run("after", "rm", "epic", "part");
    expect(removed.code).toBe(ExitCode.Success);
    expect(plain(removed.stdout)).toBe(
      "✓ after rm epic: part\n  finishes after: dropped\n",
    );
  });
});

describe("skill install", () => {
  const skillDir = path.join(SKILLS_RELATIVE_DIR, SKILL_NAME);

  it("installs the bundled skill and reports the files as JSON", async () => {
    sandbox = await treeSandbox({});
    const result = await sandbox.run("skill", "install", "--json");
    expect(result.code).toBe(ExitCode.Success);
    const json = result.json<{
      installed: boolean;
      dir: string;
      files: string[];
    }>();
    const dir = path.join(sandbox.dir, skillDir);
    expect(json).toMatchObject({ installed: true, dir });
    expect(json.files).toEqual(
      expect.arrayContaining([
        path.join(dir, "SKILL.md"),
        path.join(dir, "reference", "convention.md"),
      ]),
    );
    const skill = await sandbox.read(path.join(skillDir, "SKILL.md"));
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: tasks");
  });

  it("leaves an existing install alone, since it may have been edited", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(path.join(skillDir, "SKILL.md"), "edited by hand\n");

    const json = await sandbox.run("skill", "install", "--json");
    expect(json.code).toBe(ExitCode.Success);
    expect(json.json()).toEqual({
      installed: false,
      dir: path.join(sandbox.dir, skillDir),
      files: [],
      skipped: "exists",
    });
    const human = await sandbox.run("skill", "install");
    expect(plain(human.stdout)).toBe(
      `• Skill already installed at ${skillDir}. Use --force to refresh.\n`,
    );
    expect(await sandbox.read(path.join(skillDir, "SKILL.md"))).toBe(
      "edited by hand\n",
    );
  });

  it("refreshes an install with --force and lists what it wrote", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(path.join(skillDir, "SKILL.md"), "stale\n");

    const result = await sandbox.run("skill", "install", "--force");
    expect(result.code).toBe(ExitCode.Success);
    const lines = plain(result.stdout).trimEnd().split("\n");
    expect(lines[0]).toBe(`✓ Installed the tasks skill at ${skillDir}`);
    expect(lines.slice(1).map((line) => line.trim())).toEqual(
      expect.arrayContaining([
        path.join(skillDir, "SKILL.md"),
        path.join(skillDir, "reference", "convention.md"),
      ]),
    );
    expect(await sandbox.read(path.join(skillDir, "SKILL.md"))).toContain(
      "name: tasks",
    );
  });

  it("installs at the root of the tree from a subdirectory, and where it runs without one", async () => {
    sandbox = await treeSandbox({});
    await sandbox.write(path.join("src", "deep", ".keep"), "");
    const below = await sandbox.runWith(
      { cwd: path.join("src", "deep") },
      "skill",
      "install",
      "--json",
    );
    expect(below.code).toBe(ExitCode.Success);
    expect(below.json<{ dir: string }>().dir).toBe(
      path.join(sandbox.dir, skillDir),
    );

    // The parent of the project has no tree: the skill lands where this runs.
    const outside = await sandbox.runWith(
      { cwd: ".." },
      "skill",
      "install",
      "--json",
    );
    expect(outside.code).toBe(ExitCode.Success);
    expect(outside.json<{ dir: string }>().dir).toBe(
      path.join(path.dirname(sandbox.dir), skillDir),
    );
  });

  it("writes the session's heartbeat into the tree and the trees it lists", async () => {
    sandbox = await treeSandbox({ projects: { backend: "../backend" } });
    await sandbox.project("backend", "../backend", {});
    const result = await sandbox.run(
      "skill",
      "install",
      "--json",
      "--session",
      "s7",
    );
    expect(result.code).toBe(ExitCode.Success);
    expect(await sandbox.exists(".tasks/.locks/sessions/s7")).toBe(true);
    expect(await sandbox.exists("../backend/.tasks/.locks/sessions/s7")).toBe(
      true,
    );
  });
});

describe("command groups", () => {
  it("refuse a bare group as a usage error instead of printing help", async () => {
    sandbox = await treeSandbox({});
    for (const group of ["dep", "after", "skill", "hooks"]) {
      const result = await sandbox.run(group);
      expect({ group, code: result.code }).toEqual({
        group,
        code: ExitCode.Usage,
      });
      expect(result.stderr).toContain(`${group} needs a subcommand`);
      // Under --json the envelope carries the details, option and all.
      const json = await sandbox.run(group, "--json");
      expect(json.code).toBe(ExitCode.Usage);
      expect(json.stdout).toBe("");
      expect(
        json.json<{ error: { code: string; details: unknown } }>().error,
      ).toMatchObject({
        code: "USAGE",
        details: { command: group, subcommands: expect.any(Array) },
      });
    }
  });
});
