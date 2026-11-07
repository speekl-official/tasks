import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { HooksInstallJson } from "../src/commands/hooks.js";
import { ExitCode } from "../src/errors.js";
import type { CliResult, Sandbox } from "./helpers.js";
import { makeSandbox, treeSandbox } from "./helpers.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

/** The settings file, relative to the project root. */
const SETTINGS = path.join(".claude", "settings.json");

const EVENTS = ["SessionStart", "PostToolUse", "Stop", "SessionEnd"];

const GUIDE = fileURLToPath(
  new URL(
    "../../../apps/docs/content/docs/guides/harness.mdx",
    import.meta.url,
  ),
);

const V1_TREE = fileURLToPath(
  new URL("./fixtures/v1-tree/.tasks", import.meta.url),
);

interface Hook {
  type: string;
  command: string;
  [key: string]: unknown;
}

interface Entry {
  matcher?: string;
  hooks: Hook[];
}

interface Settings {
  hooks: Record<string, Entry[]>;
  [key: string]: unknown;
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

/** Colour depends on the terminal the suite runs in; the words do not. */
function plain(text: string): string {
  return stripVTControlCharacters(text);
}

/** The block the harness guide tells people to paste, as the page has it. */
async function guideText(): Promise<string> {
  const page = await fs.readFile(GUIDE, "utf8");
  const block = /^```json title="\.claude\/settings\.json"\n([\s\S]*?)\n```$/m
    .exec(page)
    ?.at(1);
  if (block === undefined) {
    throw new Error(`${GUIDE} has no .claude/settings.json block`);
  }
  return block;
}

/** The guide's block, its actor `agent` replaced as the guide says to. */
async function guideBlock(actor = "agent"): Promise<Settings> {
  const text = await guideText();
  return JSON.parse(
    text.replaceAll("TASKS_ACTOR=agent", `TASKS_ACTOR=${actor}`),
  ) as Settings;
}

/** The entries the guide gives `event`. */
async function documented(event: string, actor = "agent"): Promise<Entry[]> {
  const entries = (await guideBlock(actor)).hooks[event];
  if (entries === undefined) throw new Error(`the guide has no ${event}`);
  return entries;
}

async function settings(s: Sandbox): Promise<Settings> {
  return JSON.parse(await s.read(SETTINGS)) as Settings;
}

function install(s: Sandbox, ...args: string[]): Promise<CliResult> {
  return s.run("hooks", "install", ...args);
}

function command(text: string): Entry {
  return { hooks: [{ type: "command", command: text }] };
}

describe("hooks install", () => {
  it("writes exactly the block of the harness guide for actor agent", async () => {
    // The guard that keeps the command and the guide from drifting apart.
    sandbox = await treeSandbox({});
    const result = await install(sandbox, "--json");
    expect(result.code).toBe(ExitCode.Success);
    const text = await guideText();
    expect(await settings(sandbox)).toEqual(JSON.parse(text));
    expect(await sandbox.read(SETTINGS)).toBe(`${text}\n`);
  });

  it("creates .claude/settings.json with the four events, and says so", async () => {
    sandbox = await treeSandbox({});
    expect(await sandbox.exists(".claude")).toBe(false);

    const result = await install(sandbox, "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<HooksInstallJson>()).toEqual({
      installed: true,
      file: path.join(sandbox.dir, SETTINGS),
      actor: "agent",
      written: EVENTS,
      kept: [],
    });
    const written = await settings(sandbox);
    expect(Object.keys(written)).toEqual(["hooks"]);
    expect(Object.keys(written.hooks)).toEqual(EVENTS);
    for (const event of EVENTS) {
      expect(written.hooks[event]).toEqual(await documented(event));
    }

    await fs.rm(path.join(sandbox.dir, ".claude"), { recursive: true });
    const human = await install(sandbox);
    expect(human.code).toBe(ExitCode.Success);
    expect(plain(human.stdout)).toBe(
      "✓ Installed the SessionStart, PostToolUse, Stop and SessionEnd hooks in .claude/settings.json for actor agent\n",
    );
  });

  it("changes nothing on a second run and reports it as skipped", async () => {
    sandbox = await treeSandbox({});
    await install(sandbox);
    const before = await sandbox.read(SETTINGS);

    const again = await install(sandbox, "--json");
    expect(again.code).toBe(ExitCode.Success);
    expect(again.json<HooksInstallJson>()).toEqual({
      installed: false,
      file: path.join(sandbox.dir, SETTINGS),
      actor: "agent",
      written: [],
      kept: EVENTS,
      skipped: "exists",
    });
    const human = await install(sandbox);
    expect(human.code).toBe(ExitCode.Success);
    expect(plain(human.stdout)).toBe(
      "• Hooks already installed in .claude/settings.json. Use --force to refresh them.\n",
    );
    const forced = await install(sandbox, "--force");
    expect(forced.code).toBe(ExitCode.Success);
    expect(plain(forced.stdout)).toBe(
      "• Hooks already installed in .claude/settings.json, as documented for actor agent.\n",
    );
    expect(await sandbox.read(SETTINGS)).toBe(before);
  });

  it("does not rewrite a file that already holds the hooks, formatting included", async () => {
    sandbox = await treeSandbox({});
    const text = JSON.stringify(await guideBlock(), null, 4);
    await sandbox.write(SETTINGS, text);

    for (const args of [[], ["--force"]]) {
      const result = await install(sandbox, ...args, "--json");
      expect(result.code).toBe(ExitCode.Success);
      expect(result.json<HooksInstallJson>()).toMatchObject({
        installed: false,
        kept: EVENTS,
        skipped: "exists",
      });
    }
    expect(await sandbox.read(SETTINGS)).toBe(text);
  });

  it("keeps every other setting, event and entry, each in its place", async () => {
    sandbox = await treeSandbox({});
    const prettier: Entry = {
      matcher: "Write|Edit",
      hooks: [
        {
          type: "command",
          command: "jq -r .tool_input.file_path | xargs npx prettier --write",
          timeout: 30,
          statusMessage: "Formatting with Prettier...",
        },
      ],
    };
    const announce = command("say done");
    const guard: Entry = { matcher: "Bash", ...command("./guard.sh") };
    const before = {
      permissions: { allow: ["Bash(pnpm test)"] },
      hooks: {
        PreToolUse: [guard],
        PostToolUse: [prettier],
        Stop: [announce],
      },
      cleanupPeriodDays: 30,
    };
    // Four spaces and no final newline: a rewrite has two, and ends in one.
    await sandbox.write(SETTINGS, JSON.stringify(before, null, 4));

    const result = await install(sandbox, "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<HooksInstallJson>()).toMatchObject({
      installed: true,
      written: EVENTS,
      kept: [],
    });
    const after = await settings(sandbox);
    expect(after).toEqual({
      permissions: before.permissions,
      hooks: {
        PreToolUse: [guard],
        PostToolUse: [prettier, ...(await documented("PostToolUse"))],
        Stop: [announce, ...(await documented("Stop"))],
        SessionStart: await documented("SessionStart"),
        SessionEnd: await documented("SessionEnd"),
      },
      cleanupPeriodDays: 30,
    });
    // toEqual ignores the order of keys; the file keeps it, new events last.
    expect(Object.keys(after)).toEqual([
      "permissions",
      "hooks",
      "cleanupPeriodDays",
    ]);
    expect(Object.keys(after.hooks)).toEqual([
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionStart",
      "SessionEnd",
    ]);
    expect(await sandbox.read(SETTINGS)).toBe(
      `${JSON.stringify(after, null, 2)}\n`,
    );
  });

  it("keeps a tasks hook it finds, edited or not, and replaces it with --force", async () => {
    sandbox = await treeSandbox({});
    const file = path.join(sandbox.dir, SETTINGS);
    const first = command("say first");
    const last = command("say last");
    // A local install and another actor: still the Stop event's tasks hook.
    const edited = command(
      "TASKS_ACTOR=bot ./node_modules/.bin/tasks session-check --json; exit 0",
    );
    await sandbox.write(
      SETTINGS,
      JSON.stringify({ hooks: { Stop: [first, edited, last] } }),
    );

    const partial = await install(sandbox);
    expect(partial.code).toBe(ExitCode.Success);
    expect(plain(partial.stdout)).toBe(
      "✓ Installed the SessionStart, PostToolUse and SessionEnd hooks in .claude/settings.json for actor agent; kept the existing Stop hook (--force replaces it)\n",
    );
    expect((await settings(sandbox)).hooks.Stop).toEqual([first, edited, last]);
    const unforced = await sandbox.read(SETTINGS);

    const forced = await install(sandbox, "--force", "--json");
    expect(forced.code).toBe(ExitCode.Success);
    expect(forced.json<HooksInstallJson>()).toEqual({
      installed: true,
      file,
      actor: "agent",
      written: ["Stop"],
      kept: ["SessionStart", "PostToolUse", "SessionEnd"],
    });
    // In the place of the entry it replaces, between the same neighbours.
    expect((await settings(sandbox)).hooks.Stop).toEqual([
      first,
      ...(await documented("Stop")),
      last,
    ]);

    await sandbox.write(SETTINGS, unforced);
    const human = await install(sandbox, "--force");
    expect(plain(human.stdout)).toBe(
      "✓ Installed the Stop hook in .claude/settings.json for actor agent; the SessionStart, PostToolUse and SessionEnd hooks were up to date\n",
    );
  });

  it("with --force, leaves a hook that shares an entry with a tasks hook in it", async () => {
    sandbox = await treeSandbox({});
    const prettier: Hook = { type: "command", command: "npx prettier -w ." };
    const heartbeat: Hook = {
      type: "command",
      command: 'npx @speekl/tasks heartbeat --session "$(jq -r .session_id)"',
    };
    const foreign = command("say hi");
    const shared: Entry = {
      matcher: "Write|Edit",
      hooks: [prettier, heartbeat],
    };
    const duplicate: Entry = { hooks: [heartbeat] };
    await sandbox.write(
      SETTINGS,
      JSON.stringify({ hooks: { PostToolUse: [foreign, shared, duplicate] } }),
    );

    const kept = await install(sandbox, "--json");
    expect(kept.json<HooksInstallJson>()).toMatchObject({
      written: ["SessionStart", "Stop", "SessionEnd"],
      kept: ["PostToolUse"],
    });
    expect((await settings(sandbox)).hooks.PostToolUse).toEqual([
      foreign,
      shared,
      duplicate,
    ]);

    const forced = await install(sandbox, "--force", "--json");
    expect(forced.json<HooksInstallJson>()).toMatchObject({
      written: ["PostToolUse"],
    });
    // One tasks hook, where the first was; prettier stays in its entry.
    expect((await settings(sandbox)).hooks.PostToolUse).toEqual([
      foreign,
      ...(await documented("PostToolUse")),
      { matcher: "Write|Edit", hooks: [prettier] },
    ]);
  });

  it("puts --actor in all four commands", async () => {
    sandbox = await treeSandbox({});
    const result = await install(sandbox, "--actor", "claude", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<HooksInstallJson>()).toMatchObject({
      installed: true,
      actor: "claude",
      written: EVENTS,
    });

    const written = await settings(sandbox);
    for (const event of EVENTS) {
      const [entry] = written.hooks[event] ?? [];
      const text = entry?.hooks[0]?.command;
      expect(text).toContain("TASKS_ACTOR=claude");
      expect(text).not.toContain("TASKS_ACTOR=agent");
    }
    expect(written).toEqual(await guideBlock("claude"));
  });

  it("keeps another actor's hooks unless --force", async () => {
    sandbox = await treeSandbox({});
    await install(sandbox);

    const kept = await install(sandbox, "--actor", "claude", "--json");
    expect(kept.json<HooksInstallJson>()).toMatchObject({
      installed: false,
      actor: "claude",
      kept: EVENTS,
      skipped: "exists",
    });
    expect(await settings(sandbox)).toEqual(await guideBlock("agent"));

    const forced = await install(
      sandbox,
      "--actor",
      "claude",
      "--force",
      "--json",
    );
    expect(forced.json<HooksInstallJson>()).toMatchObject({
      installed: true,
      actor: "claude",
      written: EVENTS,
      kept: [],
    });
    expect(await settings(sandbox)).toEqual(await guideBlock("claude"));
  });

  it("refuses an --actor that is not an actor, and writes nothing", async () => {
    sandbox = await treeSandbox({});
    const result = await install(sandbox, "--actor", "two words", "--json");
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "USAGE",
        details: { field: "--actor", value: "two words" },
      },
    });
    expect(await sandbox.exists(".claude")).toBe(false);
  });

  it.each([
    ["is not JSON", '{ "hooks": '],
    ["holds no JSON object", "[]\n"],
    ["has hooks that are not an object", '{ "hooks": [] }\n'],
    ["has an event that is not a list", '{ "hooks": { "Stop": null } }\n'],
  ])(
    "refuses a settings file that %s, with exit 2, and leaves it alone",
    async (_case, text) => {
      sandbox = await treeSandbox({});
      const file = path.join(sandbox.dir, SETTINGS);
      await sandbox.write(SETTINGS, text);

      for (const args of [[], ["--force"]]) {
        const result = await install(sandbox, ...args, "--json");
        expect(result.code).toBe(ExitCode.Usage);
        expect(result.stdout).toBe("");
        const { error } = JSON.parse(result.stderr) as ErrorJson;
        expect(error.code).toBe("USAGE");
        expect(error.details.file).toBe(file);
        expect(error.message).toContain(file);
      }
      expect(await sandbox.read(SETTINGS)).toBe(text);
      expect(await fs.readdir(path.dirname(file))).toEqual(["settings.json"]);
    },
  );

  it("refuses a settings path that is a directory", async () => {
    sandbox = await treeSandbox({});
    await fs.mkdir(path.join(sandbox.dir, SETTINGS), { recursive: true });
    const result = await install(sandbox, "--json");
    expect(result.code).toBe(ExitCode.Usage);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { details: { file: path.join(sandbox.dir, SETTINGS) } },
    });
  });

  it("writes at the root of the tree it discovers, also from below it", async () => {
    sandbox = await treeSandbox({});
    await fs.mkdir(path.join(sandbox.dir, "src", "deep"), { recursive: true });

    const result = await sandbox.runWith(
      { cwd: path.join("src", "deep") },
      "hooks",
      "install",
    );
    expect(result.code).toBe(ExitCode.Success);
    expect(plain(result.stdout)).toContain(
      ` in ${path.join("..", "..", SETTINGS)} for actor agent`,
    );
    expect(await sandbox.exists(SETTINGS)).toBe(true);
    expect(await sandbox.exists(path.join("src", "deep", ".claude"))).toBe(
      false,
    );
  });

  it("is not found where there is no tree, and writes nothing", async () => {
    sandbox = await makeSandbox();
    const result = await install(sandbox, "--json");
    expect(result.code).toBe(ExitCode.NotFound);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(await sandbox.exists(".claude")).toBe(false);
  });

  it("installs beside a v1 tree, reading only its version and touching nothing", async () => {
    sandbox = await makeSandbox();
    await fs.cp(V1_TREE, sandbox.tasksDir, { recursive: true });

    const result = await sandbox.session("s1")("hooks", "install", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(await settings(sandbox)).toEqual(await guideBlock());
    // No heartbeat: a v1 tree has no session registry.
    expect(await sandbox.exists(".tasks/.locks/sessions/s1")).toBe(false);
  });
});

describe("hooks", () => {
  it("is a usage error without a subcommand, or with an unknown one", async () => {
    sandbox = await treeSandbox({});
    for (const argv of [["hooks"], ["hooks", "uninstall"]]) {
      const result = await sandbox.run(...argv);
      expect({ argv, code: result.code }).toEqual({
        argv,
        code: ExitCode.Usage,
      });
      expect(result.stdout).toBe("");
      expect(plain(result.stderr)).toContain(
        "hooks needs a subcommand: hooks install.",
      );
    }
    // A group declares no --json, so the parser refuses it: exit 2 as well.
    const json = await sandbox.run("hooks", "--json");
    expect(json.code).toBe(ExitCode.Usage);
    expect(json.stdout).toBe("");
    expect(JSON.parse(json.stderr)).toMatchObject({ error: { code: "USAGE" } });
    expect(await sandbox.exists(".claude")).toBe(false);
  });
});

describe("hooks install and the session registry", () => {
  it("writes the session's heartbeat into the tree and the trees it lists", async () => {
    sandbox = await treeSandbox({ projects: { backend: "../backend" } });
    await sandbox.project("backend", "../backend", {});
    const result = await sandbox.run(
      "hooks",
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
