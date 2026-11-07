import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../src/cli.js";
import { SKILLS_RELATIVE_DIR, SKILL_NAME } from "../src/core/skill.js";
import type {
  CollectionJson,
  LogEntriesJson,
  TaskWithDerivedJson,
} from "../src/core/types.js";
import { SITUATIONS } from "../src/core/types.js";
import { readLog } from "../src/core/workspace.js";
import type { TreeSpec } from "./fixtures.js";
import type { CliResult, Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

/**
 * The specification's CLI contract → Commands table, row by row, against the
 * program `buildCli()` builds: every command and every option a row names,
 * `-C`, `--as` and `--session` accepted after any command name and honoured
 * by every command, `--json` on every command that produces output, and a
 * `--help` that exits 0 everywhere. Command and argument names are not
 * contract, so arguments are compared by shape (required, optional,
 * variadic) and options by their long flag and whether they take a value.
 */

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

/* ------------------------------------------------------------------------ */
/* The table                                                                */
/* ------------------------------------------------------------------------ */

interface Entry {
  /** The row of the spec's table, as it is written there. */
  row: string;
  /** The command path: `["dep", "add"]`. */
  path: string[];
  /** Positional arguments in commander's notation; names do not matter. */
  args: string[];
  /** The options the row names: `--flag`, or `--flag <value>`. */
  options: string[];
}

const TRANSITION_ROW =
  "schedule, defer, claim [--next [--scope <path>]], pause -m, release, done -m, cancel -m, reopen -m, handoff <actor> -m, assign <actor>, unassign, priority <level>";
const DEP_ROW =
  "dep add|rm|list <task> [<ref>…] and after add|rm|list <task> [<ref>…]";
const ARCHIVE_ROW =
  "archive <task> [--force], archive --resolved-before <when> | --all-resolved, restore <path>, purge <path>";
const LOG_ROW =
  'log <task> "<text>", log --since <duration|timestamp> [--local]';

/** A transition that requires a message, `--force` on all twelve. */
function transition(name: string, args: string[], message: boolean): Entry {
  return {
    row: TRANSITION_ROW,
    path: [name],
    args,
    options: [...(message ? ["-m, --message <text>"] : []), "--force"],
  };
}

const TABLE: Entry[] = [
  { row: "init", path: ["init"], args: [], options: [] },
  {
    row: "new <path> <title…> [--backlog] [--assign <actor>] [--priority <level>]",
    path: ["new"],
    args: ["<path>", "<title...>"],
    options: ["--backlog", "--assign <actor>", "--priority <level>"],
  },
  { row: "show <task>", path: ["show"], args: ["<task>"], options: [] },
  { row: "resume <task>", path: ["resume"], args: ["<task>"], options: [] },
  {
    row: "ready [--scope <path>] [--all] [--local]",
    path: ["ready"],
    args: [],
    options: ["--scope <path>", "--all", "--local"],
  },
  {
    row: "mine [--as <actor>] [--local]",
    path: ["mine"],
    args: [],
    options: ["--local"],
  },
  {
    row: "actors [--local]",
    path: ["actors"],
    args: [],
    options: ["--local"],
  },
  {
    row: "list [--<situation>], tree",
    path: ["list"],
    args: [],
    options: SITUATIONS.map((word) => `--${word}`),
  },
  { row: "list [--<situation>], tree", path: ["tree"], args: [], options: [] },
  transition("schedule", ["<task>"], false),
  transition("defer", ["<task>"], false),
  {
    row: TRANSITION_ROW,
    path: ["claim"],
    args: ["[task]"],
    options: ["--next", "--scope <path>", "--force"],
  },
  transition("pause", ["<task>"], true),
  transition("release", ["<task>"], false),
  transition("done", ["<task>"], true),
  transition("cancel", ["<task>"], true),
  transition("reopen", ["<task>"], true),
  transition("handoff", ["<task>", "<actor>"], true),
  transition("assign", ["<task>", "<actor>"], false),
  transition("unassign", ["<task>"], false),
  transition("priority", ["<task>", "<level>"], false),
  ...["dep", "after"].flatMap((name): Entry[] => [
    {
      row: DEP_ROW,
      path: [name, "add"],
      args: ["<task>", "<ref...>"],
      options: [],
    },
    {
      row: DEP_ROW,
      path: [name, "rm"],
      args: ["<task>", "<ref...>"],
      options: [],
    },
    { row: DEP_ROW, path: [name, "list"], args: ["<task>"], options: [] },
  ]),
  {
    row: "move <task|group> <destination>",
    path: ["move"],
    args: ["<task>", "<destination>"],
    options: [],
  },
  {
    row: ARCHIVE_ROW,
    path: ["archive"],
    args: ["[task]"],
    options: ["--force", "--resolved-before [when]", "--all-resolved"],
  },
  { row: ARCHIVE_ROW, path: ["restore"], args: ["<path>"], options: [] },
  { row: ARCHIVE_ROW, path: ["purge"], args: ["<path>"], options: [] },
  { row: "delete <task>", path: ["delete"], args: ["<task>"], options: [] },
  {
    row: LOG_ROW,
    path: ["log"],
    args: ["[task]", "[text...]"],
    options: ["--since <when>", "--local"],
  },
  {
    row: "state <task> [--edit]",
    path: ["state"],
    args: ["<task>"],
    options: ["--edit"],
  },
  { row: "heartbeat", path: ["heartbeat"], args: [], options: [] },
  { row: "session-end", path: ["session-end"], args: [], options: [] },
  {
    row: "session-check [--as <actor>]",
    path: ["session-check"],
    args: [],
    options: [],
  },
  { row: "validate [--fix]", path: ["validate"], args: [], options: ["--fix"] },
  { row: "reindex", path: ["reindex"], args: [], options: [] },
  {
    row: "migrate [<alias>] [--map OLD=NEW …] [--map-phase OLD=NEW …]",
    path: ["migrate"],
    args: ["[alias]"],
    options: ["--map <mapping>", "--map-phase <mapping>"],
  },
];

/** The commands of this CLI that the spec's table does not list. */
const BEYOND_THE_TABLE = ["skill", "hooks"];

function find(program: Command, commandPath: string[]): Command {
  let command = program;
  for (const name of commandPath) {
    const next = command.commands.find((sub) => sub.name() === name);
    if (next === undefined) {
      throw new Error(`no command ${commandPath.join(" ")}`);
    }
    command = next;
  }
  return command;
}

/** `<task>` → `<>`, `[text...]` → `[...]`: the shape a user types. */
function shape(arg: string): string {
  const variadic = arg.includes("...") ? "..." : "";
  return arg.startsWith("<") ? `<${variadic}>` : `[${variadic}]`;
}

function declaredShape(command: Command): string[] {
  return command.registeredArguments.map((arg) => {
    const variadic = arg.variadic ? "..." : "";
    return arg.required ? `<${variadic}>` : `[${variadic}]`;
  });
}

interface FlagShape {
  long: string;
  short: string | null;
  value: boolean;
}

function flagShape(flags: string): FlagShape {
  const long = /--[a-z-]+/.exec(flags)?.[0] ?? flags;
  const short = /(?:^|\s)(-[a-zA-Z]),/.exec(flags)?.[1] ?? null;
  return { long, short, value: /[<[]/.test(flags) };
}

function declaredFlag(command: Command, long: string): FlagShape | null {
  const option = command.options.find((candidate) => candidate.long === long);
  if (option === undefined) return null;
  return {
    long,
    short: option.short ?? null,
    value: option.required || option.optional,
  };
}

/** Every command path beneath `command`, the commands with subcommands too. */
function commandPaths(command: Command, prefix: string[] = []): string[][] {
  return command.commands.flatMap((sub) => {
    const here = [...prefix, sub.name()];
    return [here, ...commandPaths(sub, here)];
  });
}

/** The commands a user runs: those with no subcommands of their own. */
function leafPaths(program: Command): string[][] {
  return commandPaths(program).filter(
    (commandPath) => find(program, commandPath).commands.length === 0,
  );
}

describe("the command table", () => {
  it("registers exactly the commands of the table, and the ones beyond it", () => {
    const program = buildCli();
    const tableNames = new Set(TABLE.map((entry) => entry.path[0]!));
    expect(program.commands.map((command) => command.name()).sort()).toEqual(
      [...tableNames, ...BEYOND_THE_TABLE].sort(),
    );
    // Every leaf of the table's commands is an entry of the table.
    const listed = new Set(TABLE.map((entry) => entry.path.join(" ")));
    for (const leaf of leafPaths(program)) {
      if (BEYOND_THE_TABLE.includes(leaf[0]!)) continue;
      expect(listed).toContain(leaf.join(" "));
    }
  });

  it.each(TABLE.map((entry) => [entry.path.join(" "), entry] as const))(
    "%s has the arguments and options of its row, and --json",
    (_name, entry) => {
      const command = find(buildCli(), entry.path);
      expect(declaredShape(command)).toEqual(entry.args.map(shape));
      for (const flags of [...entry.options, "--json"]) {
        const want = flagShape(flags);
        const have = declaredFlag(command, want.long);
        expect({ row: entry.row, flag: have }).toEqual({
          row: entry.row,
          flag: { ...want, short: want.short ?? have?.short ?? null },
        });
      }
    },
  );

  it("lets --map and --map-phase repeat", () => {
    const migrate = find(buildCli(), ["migrate"]);
    migrate.parseOptions([
      "--map",
      "WAITING=PAUSED",
      "--map",
      "REVIEW=PAUSED",
      "--map-phase",
      "v1_0=v1-0",
      "--map-phase",
      "v2_0=v2-0",
    ]);
    expect(migrate.opts()).toMatchObject({
      map: ["WAITING=PAUSED", "REVIEW=PAUSED"],
      mapPhase: ["v1_0=v1-0", "v2_0=v2-0"],
    });
  });

  it("declares -C, --as and --session once, on the program", () => {
    const program = buildCli();
    expect(declaredFlag(program, "--dir")).toEqual({
      long: "--dir",
      short: "-C",
      value: true,
    });
    for (const long of ["--as", "--session"]) {
      expect(declaredFlag(program, long)).toMatchObject({ value: true });
    }
    // No command shadows them with an option of its own.
    for (const commandPath of commandPaths(program)) {
      const command = find(program, commandPath);
      for (const long of ["--dir", "--as", "--session"]) {
        expect({ commandPath, flag: declaredFlag(command, long) }).toEqual({
          commandPath,
          flag: null,
        });
      }
    }
  });

  it.each(commandPaths(buildCli()).map((commandPath) => commandPath.join(" ")))(
    "%s --help exits 0 and lists -C, --as and --session",
    async (name) => {
      sandbox = await treeSandbox({});
      const commandPath = name.split(" ");
      const result = await sandbox.run(...commandPath, "--help");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: tasks ${name}`);
      for (const flag of [
        "-C, --dir <dir>",
        "--as <actor>",
        "--session <token>",
      ]) {
        expect(result.stdout).toContain(flag);
      }
      if (find(buildCli(), commandPath).commands.length === 0) {
        expect(result.stdout).toContain("--json");
      }
    },
  );
});

/* ------------------------------------------------------------------------ */
/* Every command, run with the global options after its name                */
/* ------------------------------------------------------------------------ */

/**
 * The tree every run starts from. Its claims belong to `agent` in session
 * `s1`, the identity every run takes with `--as agent --session s1`, so that
 * each command has something it may legitimately do.
 */
const FIXTURE: TreeSpec = {
  tasks: {
    todo: { created: "2026-01-01T00:00:00Z" },
    backlog: { status: "BACKLOG" },
    claimed: {
      status: "IN_PROGRESS",
      claimed_by: "agent",
      claimed_session: "s1",
      state: true,
    },
    // A claim without a session, as a terminal leaves it: the agent's own.
    bare: { status: "IN_PROGRESS", claimed_by: "agent" },
    finished: { status: "DONE" },
    assigned: { assignee: "agent", created: "2026-01-02T00:00:00Z" },
    target: { status: "DONE" },
    linked: {
      depends_on: ["target"],
      finishes_after: ["target"],
      created: "2026-01-03T00:00:00Z",
    },
  },
  archived: { old: { status: "DONE" } },
};

const V1_TREE = fileURLToPath(
  new URL("./fixtures/v1-tree/.tasks", import.meta.url),
);

interface Run {
  /** The command and its arguments, global options left out. */
  argv: string[];
  /** The directory `-C` names, relative to the sandbox root. */
  dir?: string;
  /** Extra setup: a directory for `init`, a v1 tree for `migrate`. */
  setup?: (s: Sandbox) => Promise<void>;
  /** Standard input of the run that succeeds. */
  stdin?: string;
  /** The log the command appends to: its newest entry names the identity. */
  log?: (json: unknown) => string;
  /** What else shows that `--as agent` was honoured. */
  check?: (json: unknown, s: Sandbox) => Promise<void> | void;
}

function taskLog(id: string): () => string {
  return () => `.tasks/${id}/log.md`;
}

/** A collection in which the task assigned to `agent` is ready for it. */
function readyForAgent(json: unknown): void {
  const task = (json as CollectionJson).tasks.find((t) => t.id === "assigned");
  expect(task?.ready).toBe(true);
}

function feedStdin(text: string): void {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from([
      Buffer.from(text, "utf8"),
    ]) as unknown as typeof process.stdin,
  );
}

const RUNS: Run[] = [
  {
    argv: ["init", "--no-skill"],
    dir: "fresh",
    setup: async (s) => fs.mkdir(path.join(s.root, "fresh")),
    check: (json) =>
      expect(json).toMatchObject({ actor: "agent", via: "tester" }),
  },
  {
    argv: ["new", "fresh-task", "A", "fresh", "task"],
    log: taskLog("fresh-task"),
  },
  {
    argv: ["show", "assigned"],
    check: (json) => expect((json as TaskWithDerivedJson).ready).toBe(true),
  },
  {
    argv: ["resume", "assigned"],
    check: (json) => expect((json as TaskWithDerivedJson).ready).toBe(true),
  },
  { argv: ["ready"], check: readyForAgent },
  {
    argv: ["mine"],
    check: (json) =>
      expect((json as CollectionJson).tasks.map((t) => t.id).sort()).toEqual([
        "assigned",
        "bare",
        "claimed",
      ]),
  },
  {
    argv: ["actors"],
    check: (json) =>
      expect(json).toMatchObject({ actor: "agent", via: "tester" }),
  },
  { argv: ["list"], check: readyForAgent },
  { argv: ["tree"], check: readyForAgent },
  {
    argv: ["heartbeat"],
    check: (json) => expect(json).toMatchObject({ session: "s1" }),
  },
  {
    argv: ["session-end"],
    check: (json) =>
      expect(json).toMatchObject({ session: "s1", claims: ["claimed"] }),
  },
  {
    argv: ["session-check"],
    check: (json) =>
      expect(json).toMatchObject({ ok: true, session: "s1", violations: [] }),
  },
  { argv: ["schedule", "backlog"], log: taskLog("backlog") },
  { argv: ["defer", "todo"], log: taskLog("todo") },
  { argv: ["claim", "todo"], log: taskLog("todo") },
  {
    argv: ["claim", "--next"],
    log: (json) => `.tasks/${(json as TaskWithDerivedJson).id}/log.md`,
    check: (json) =>
      expect(json).toMatchObject({
        claimed_by: "agent",
        claimed_session: "s1",
      }),
  },
  { argv: ["pause", "claimed", "-m", "stopping"], log: taskLog("claimed") },
  { argv: ["release", "bare"], log: taskLog("bare") },
  { argv: ["done", "todo", "-m", "built"], log: taskLog("todo") },
  { argv: ["cancel", "todo", "-m", "dropped"], log: taskLog("todo") },
  { argv: ["reopen", "finished", "-m", "again"], log: taskLog("finished") },
  {
    argv: ["handoff", "claimed", "alice", "-m", "review it"],
    log: taskLog("claimed"),
  },
  { argv: ["assign", "todo", "alice"], log: taskLog("todo") },
  { argv: ["unassign", "assigned"], log: taskLog("assigned") },
  { argv: ["priority", "todo", "high"], log: taskLog("todo") },
  { argv: ["dep", "add", "todo", "target"], log: taskLog("todo") },
  { argv: ["dep", "rm", "linked", "target"], log: taskLog("linked") },
  {
    argv: ["dep", "list", "linked"],
    check: (json) => expect(json).toMatchObject({ field: "depends_on" }),
  },
  { argv: ["after", "add", "todo", "target"], log: taskLog("todo") },
  { argv: ["after", "rm", "linked", "target"], log: taskLog("linked") },
  {
    argv: ["after", "list", "linked"],
    check: (json) => expect(json).toMatchObject({ field: "finishes_after" }),
  },
  { argv: ["move", "todo", "moved"], log: taskLog("moved") },
  {
    argv: ["archive", "finished"],
    log: () => ".tasks/.archive/finished/log.md",
  },
  { argv: ["restore", "old"], log: taskLog("old") },
  {
    argv: ["purge", "old"],
    check: async (_json, s) =>
      expect(await s.exists(".tasks/.archive/old")).toBe(false),
  },
  {
    argv: ["delete", "todo"],
    check: async (_json, s) =>
      expect(await s.exists(".tasks/todo")).toBe(false),
  },
  { argv: ["log", "todo", "a", "narrative", "note"], log: taskLog("todo") },
  {
    argv: ["log", "--since", "1h"],
    setup: async (s) => {
      await s.write(
        ".tasks/todo/log.md",
        `## ${new Date().toISOString().slice(0, 19)}Z agent s:s1\nnew: TODO\n`,
      );
    },
    check: (json) =>
      expect((json as LogEntriesJson).entries.map((e) => e.task)).toEqual([
        "todo",
      ]),
  },
  {
    argv: ["state", "todo"],
    stdin: "## Done\n\n## Next\n\nShip it.\n",
    check: async (_json, s) =>
      expect(await s.read(".tasks/todo/state.md")).toBe(
        "## Done\n\n## Next\n\nShip it.\n",
      ),
  },
  {
    argv: ["validate"],
    check: (json) => expect(json).toMatchObject({ ok: true }),
  },
  {
    argv: ["reindex"],
    check: (json) => expect(json).toMatchObject({ written: true }),
  },
  {
    argv: ["migrate"],
    dir: "legacy",
    setup: async (s) =>
      fs.cp(V1_TREE, path.join(s.root, "legacy", ".tasks"), {
        recursive: true,
      }),
  },
];

/** Every file under `dir` with its contents, to show nothing was written. */
async function filesUnder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${path.relative(dir, full)}/`] = "";
        await walk(full);
      } else {
        out[path.relative(dir, full)] = await fs.readFile(full, "utf8");
      }
    }
  };
  await walk(dir);
  return out;
}

function usageEnvelope(result: CliResult): unknown {
  expect(result.stdout).toBe("");
  return (JSON.parse(result.stderr) as { error: { code: string } }).error.code;
}

describe("every command", () => {
  it("runs where no tree is found without -C", async () => {
    sandbox = await treeSandbox(FIXTURE);
    const result = await sandbox.runWith(
      { cwd: sandbox.root },
      "list",
      "--json",
    );
    expect(result.code).toBe(3);
  });

  it("of the table has a run below", () => {
    const run = new Set(
      RUNS.map((entry) =>
        entry.argv[0] === "dep" || entry.argv[0] === "after"
          ? entry.argv.slice(0, 2).join(" ")
          : entry.argv[0],
      ),
    );
    expect([...run].sort()).toEqual(
      TABLE.map((entry) => entry.path.join(" ")).sort(),
    );
  });

  it.each(RUNS.map((entry) => [entry.argv.join(" "), entry] as const))(
    "%s takes -C, --as and --session after its name and honours them",
    async (_name, entry) => {
      const s = await treeSandbox(FIXTURE);
      sandbox = s;
      const dir = entry.dir ?? "repo";
      const outside = { cwd: s.root };
      await entry.setup?.(s);

      // Run from outside every tree, so that only -C can find one; a value
      // that fails the actor pattern is a usage error that writes nothing.
      const before = await filesUnder(s.root);
      for (const bad of [
        ["--as", "two words", "--session", "s1"],
        ["--as", "agent", "--session", "bad token"],
      ]) {
        const refused = await s.runWith(
          outside,
          ...entry.argv,
          "-C",
          dir,
          ...bad,
          "--json",
        );
        expect({ bad, code: refused.code }).toEqual({ bad, code: 2 });
        expect(usageEnvelope(refused)).toBe("USAGE");
      }
      expect(await filesUnder(s.root)).toEqual(before);
      if (entry.stdin !== undefined) feedStdin(entry.stdin);

      const result = await s.runWith(
        outside,
        ...entry.argv,
        "-C",
        dir,
        "--as",
        "agent",
        "--session",
        "s1",
        "--json",
      );
      expect({ stderr: result.stderr, code: result.code }).toEqual({
        stderr: "",
        code: 0,
      });
      const json = JSON.parse(result.stdout) as unknown;

      // --session: the heartbeat of the tree -C named.
      expect(
        await s.exists(path.join(s.root, dir, ".tasks/.locks/sessions/s1")),
      ).toBe(true);
      // --as: the entry the command wrote names the principal, the operator
      // and the session.
      if (entry.log !== undefined) {
        const log = path.join(s.root, dir, entry.log(json));
        const newest = (await readLog(path.dirname(log))).at(-1);
        expect(newest).toMatchObject({
          actor: "agent",
          via: "tester",
          session: "s1",
        });
      }
      await entry.check?.(json, s);
    },
  );

  it("skill install, beyond the table, takes the global options like every other command", async () => {
    const s = await treeSandbox({});
    sandbox = s;
    const outside = { cwd: s.root };
    const install = (...globals: string[]) =>
      s.runWith(
        outside,
        "skill",
        "install",
        "-C",
        "repo",
        ...globals,
        "--json",
      );
    const skill = path.join(SKILLS_RELATIVE_DIR, SKILL_NAME);

    const invalidActor = (await install("--as", "two words")).code;
    const invalidSession = (await install("--session", "bad token")).code;
    for (const dir of [s.dir, s.root]) {
      await fs.rm(path.join(dir, skill), { recursive: true, force: true });
    }
    const valid = await install("--as", "agent", "--session", "s1");
    expect({
      invalidActor,
      invalidSession,
      valid: valid.code,
      // Into the project -C names, as `init` installs it.
      underC: await s.exists(path.join(skill, "SKILL.md")),
      inTheWorkingDirectory: await s.exists(path.join("..", skill)),
      heartbeat: await s.exists(".tasks/.locks/sessions/s1"),
    }).toEqual({
      invalidActor: 2,
      invalidSession: 2,
      valid: 0,
      underC: true,
      inTheWorkingDirectory: false,
      heartbeat: true,
    });
  });

  it("hooks install, beyond the table, takes the global options like every other command", async () => {
    const s = await treeSandbox({});
    sandbox = s;
    const outside = { cwd: s.root };
    const install = (...globals: string[]) =>
      s.runWith(
        outside,
        "hooks",
        "install",
        "-C",
        "repo",
        ...globals,
        "--json",
      );
    const settings = path.join(".claude", "settings.json");

    const invalidActor = (await install("--as", "two words")).code;
    const invalidSession = (await install("--session", "bad token")).code;
    const writtenByInvalid =
      (await s.exists(settings)) || (await s.exists(path.join("..", settings)));
    const valid = await install("--as", "agent", "--session", "s1");
    expect({
      invalidActor,
      invalidSession,
      writtenByInvalid,
      valid: valid.code,
      // At the root of the tree -C names.
      underC: await s.exists(settings),
      inTheWorkingDirectory: await s.exists(path.join("..", settings)),
      heartbeat: await s.exists(".tasks/.locks/sessions/s1"),
    }).toEqual({
      invalidActor: 2,
      invalidSession: 2,
      writtenByInvalid: false,
      valid: 0,
      underC: true,
      inTheWorkingDirectory: false,
      heartbeat: true,
    });
  });
});
