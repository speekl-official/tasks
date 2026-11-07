import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeBody, parseTaskFile } from "../src/core/frontmatter.js";
import type {
  MigrateJson,
  MigrationProblem,
} from "../src/core/migrate/migrate.js";
import {
  parsePhaseMappings,
  parseStatusMappings,
} from "../src/core/migrate/migrate.js";
import {
  parseV1Config,
  parseV1Reference,
  parseV1TaskFile,
  v1ReadmeTemplate,
} from "../src/core/migrate/v1.js";
import { readmeTemplate } from "../src/core/templates.js";
import type { FindingJson, Status, ValidationJson } from "../src/core/types.js";
import { ExitCode } from "../src/errors.js";
import { FIXTURE_TIME, addProjectAlias } from "./fixtures.js";
import type { CliResult, Sandbox } from "./helpers.js";
import { makeSandbox } from "./helpers.js";

/**
 * `migrate` runs against copies: the fixture is a verbatim copy of the
 * repository's own v1 tree, and every test copies it (or writes a small v1
 * tree) into a sandbox first. Nothing here ever touches a tree in place.
 */
const FIXTURE = fileURLToPath(
  new URL("./fixtures/v1-tree/.tasks", import.meta.url),
);

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function plain(text: string): string {
  return stripVTControlCharacters(text);
}

function errorOf(result: CliResult): ErrorJson["error"] {
  expect(result.stdout).toBe("");
  return (JSON.parse(result.stderr) as ErrorJson).error;
}

function problemsOf(result: CliResult): MigrationProblem[] {
  expect(result.code).toBe(ExitCode.Usage);
  const details = errorOf(result).details as { problems: MigrationProblem[] };
  return details.problems;
}

function migrated(result: CliResult): MigrateJson {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(ExitCode.Success);
  return result.json<MigrateJson>();
}

async function fixtureSandbox(): Promise<Sandbox> {
  sandbox = await makeSandbox();
  await fs.cp(FIXTURE, sandbox.tasksDir, { recursive: true });
  return sandbox;
}

/** Every file under `dir` with its contents, for before/after comparison. */
async function snapshotFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = await fs.readFile(full, "utf8");
    }
  };
  await walk(dir);
  return out;
}

/* ------------------------------------------------------------------------ */
/* Writing v1 trees                                                         */
/* ------------------------------------------------------------------------ */

interface V1TaskSpec {
  id?: string;
  phase?: string;
  status?: string;
  depends_on?: string[];
  created?: string;
  updated?: string;
  claimed_by?: string | null;
  claimed_at?: string | null;
  extra?: Record<string, unknown>;
  body?: string;
}

interface V1TreeSpec {
  /** The raw `config.yml`; v1's minimal one by default. */
  config?: string;
  /** `<phase>/<file>` (without `.md`) → task. */
  tasks?: Record<string, V1TaskSpec>;
  /** `<file>` (without `.md`) → task; `phase` defaults to `archive`. */
  archived?: Record<string, V1TaskSpec>;
  /** The README; v1's scaffold by default, none with `null`. */
  readme?: string | null;
}

/** v1's own quoting: plain when a slug-like scalar, JSON-quoted otherwise. */
function v1Scalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    ? value
    : JSON.stringify(value);
}

/** A task file as the v1 CLI wrote one. */
function v1Source(id: string, phase: string, spec: V1TaskSpec): string {
  const nullable = (value: string | null | undefined, quote: boolean) =>
    value === null || value === undefined
      ? "null"
      : quote
        ? JSON.stringify(value)
        : v1Scalar(value);
  const lines = [
    `id: ${v1Scalar(spec.id ?? id)}`,
    `phase: ${v1Scalar(spec.phase ?? phase)}`,
    `status: ${v1Scalar(spec.status ?? "PENDING")}`,
    `depends_on: [${(spec.depends_on ?? []).map(v1Scalar).join(", ")}]`,
    `created: ${JSON.stringify(spec.created ?? FIXTURE_TIME)}`,
    `updated: ${JSON.stringify(spec.updated ?? FIXTURE_TIME)}`,
    `claimed_by: ${nullable(spec.claimed_by, false)}`,
    `claimed_at: ${nullable(spec.claimed_at, true)}`,
    ...Object.entries(spec.extra ?? {}).map(
      ([key, value]) => `${key}: ${JSON.stringify(value)}`,
    ),
  ];
  const body = spec.body ?? `# Task ${spec.id ?? id}\n\n## Notes\n`;
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

async function writeV1Tree(tasksDir: string, spec: V1TreeSpec): Promise<void> {
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(
    path.join(tasksDir, "config.yml"),
    spec.config ?? "version: 1\n",
  );
  await fs.writeFile(path.join(tasksDir, ".gitignore"), ".locks/\n");
  if (spec.readme !== null) {
    await fs.writeFile(
      path.join(tasksDir, "README.md"),
      spec.readme ?? v1ReadmeTemplate(),
    );
  }
  for (const [key, task] of Object.entries(spec.tasks ?? {})) {
    const [phase, file, ...rest] = key.split("/");
    if (phase === undefined || file === undefined || rest.length > 0) {
      throw new Error(`A v1 task key is <phase>/<file>, got "${key}".`);
    }
    await fs.mkdir(path.join(tasksDir, phase), { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, phase, `${file}.md`),
      v1Source(file, phase, task),
    );
  }
  for (const [file, task] of Object.entries(spec.archived ?? {})) {
    await fs.mkdir(path.join(tasksDir, ".archive"), { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, ".archive", `${file}.md`),
      v1Source(file, task.phase ?? "archive", task),
    );
  }
}

async function v1Sandbox(spec: V1TreeSpec): Promise<Sandbox> {
  sandbox = await makeSandbox();
  await writeV1Tree(sandbox.tasksDir, spec);
  return sandbox;
}

async function manifest(s: Sandbox, relative: string) {
  return parseTaskFile(await s.read(relative));
}

async function validation(s: Sandbox): Promise<ValidationJson> {
  const result = await s.run("validate", "--json");
  return JSON.parse(result.stdout) as ValidationJson;
}

function kinds(findings: FindingJson[]) {
  return findings.map(({ severity, kind, task }) => ({ severity, kind, task }));
}

/* ------------------------------------------------------------------------ */
/* The repository's own tree                                                */
/* ------------------------------------------------------------------------ */

/** The fixture task by task: v1 `<phase>/<id>.md` → v2 status and gate. */
const FIXTURE_TASKS: Record<string, { status: Status; depends_on: string[] }> =
  {
    "agent/claude-skill": {
      status: "TODO",
      depends_on: ["release/publish-v1"],
    },
    "commands/check": { status: "TODO", depends_on: ["commands/note"] },
    "commands/completions": { status: "TODO", depends_on: [] },
    "commands/config-cmd": { status: "TODO", depends_on: [] },
    "commands/edit": { status: "TODO", depends_on: [] },
    "commands/note": { status: "TODO", depends_on: [] },
    "commands/restore": { status: "TODO", depends_on: [] },
    "commands/stats": { status: "TODO", depends_on: [] },
    "integrity/config-migrations": { status: "TODO", depends_on: [] },
    "integrity/index-staleness": { status: "DONE", depends_on: [] },
    "monorepo/cross-tree": { status: "TODO", depends_on: [] },
    "release/publish-v1": {
      status: "TODO",
      // The v1 tree already names a task it no longer holds.
      depends_on: [
        "release/versioning",
        "release/release-workflow",
        "cross-platform-ci",
      ],
    },
    "release/release-workflow": {
      status: "TODO",
      depends_on: ["release/versioning"],
    },
    "release/versioning": { status: "DONE", depends_on: [] },
    "website/docs-site": {
      status: "DONE",
      depends_on: ["release/publish-v1"],
    },
  };

/** The v1 file's frontmatter and body, split independently of the reader. */
async function fixtureFile(id: string) {
  const source = await fs.readFile(path.join(FIXTURE, `${id}.md`), "utf8");
  const close = source.indexOf("\n---\n", 4);
  const data = yaml.load(source.slice(4, close), {
    schema: yaml.JSON_SCHEMA,
  }) as Record<string, unknown>;
  return { data, body: source.slice(close + 5) };
}

describe("migrate: the repository's own v1 tree", () => {
  it("is the tree the fixture copies: 15 tasks, 12 PENDING, 3 DONE, the scaffold README", async () => {
    const statuses: Record<string, number> = {};
    for (const id of Object.keys(FIXTURE_TASKS)) {
      const { data } = await fixtureFile(id);
      const status = String(data.status);
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
    expect(statuses).toEqual({ PENDING: 12, DONE: 3 });
    const readme = await fs.readFile(path.join(FIXTURE, "README.md"), "utf8");
    expect(readme).toBe(v1ReadmeTemplate());
  });

  it("migrates every task to <phase>/<id>/task.md with its fields mapped and its body kept", async () => {
    const s = await fixtureSandbox();
    const result = migrated(await s.run("migrate", "--json"));
    expect(result.tasks).toBe(15);
    expect(result.archived).toBe(0);

    for (const [id, expected] of Object.entries(FIXTURE_TASKS)) {
      const v1 = await fixtureFile(id);
      expect(await s.exists(`.tasks/${id}.md`)).toBe(false);
      const parsed = await manifest(s, `.tasks/${id}/task.md`);
      expect(parsed.frontmatter).toEqual({
        status: expected.status,
        priority: "normal",
        depends_on: expected.depends_on,
        finishes_after: [],
        assignee: null,
        claimed_by: null,
        claimed_at: null,
        claimed_session: null,
        created: v1.data.created,
        updated: v1.data.updated,
      });
      // `id` and `phase` are gone, and nothing else was added.
      expect(parsed.extra).toEqual([]);
      expect(parsed.body).toBe(normalizeBody(v1.body));
    }

    const tree = await s.loadTree();
    expect(tree.tasks.map((task) => task.id).sort()).toEqual(
      Object.keys(FIXTURE_TASKS).sort(),
    );
    expect(tree.malformed).toEqual([]);
  });

  it("rewrites config.yml, replaces the scaffold README, swaps _index.md for index.md", async () => {
    const s = await fixtureSandbox();
    const gitignore = await s.read(".tasks/.gitignore");
    migrated(await s.run("migrate", "--json"));

    expect(await s.read(".tasks/config.yml")).toBe("version: 2\n");
    expect(await s.read(".tasks/README.md")).toBe(readmeTemplate());
    expect(await s.exists(".tasks/_index.md")).toBe(false);
    expect(await s.read(".tasks/index.md")).toContain(
      "[release/publish-v1](release/publish-v1/)",
    );
    expect(await s.read(".tasks/.gitignore")).toBe(gitignore);

    // The generated index is what `reindex` writes: nothing is stale.
    const index = await s.read(".tasks/index.md");
    expect((await s.run("reindex")).code).toBe(ExitCode.Success);
    expect(await s.read(".tasks/index.md")).toBe(index);
  });

  it("validates clean apart from the dangling reference the v1 tree already had", async () => {
    const s = await fixtureSandbox();
    migrated(await s.run("migrate", "--json"));
    const result = await validation(s);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(15);
    expect(kinds(result.findings)).toEqual([
      {
        severity: "warning",
        kind: "unsatisfiable-ref",
        task: "release/publish-v1",
      },
    ]);
    expect(result.findings[0]!.message).toContain("cross-platform-ci");
  });

  it("reports everything it did as JSON", async () => {
    const s = await fixtureSandbox();
    const result = migrated(await s.run("migrate", "--json"));
    expect(Object.keys(result)).toEqual([
      "tree",
      "tasks",
      "archived",
      "phases",
      "statuses",
      "rewritten",
      "unrewritten",
      "readme",
      "scope",
      "consequences",
    ]);
    expect(result).toMatchObject({
      tree: s.tasksDir,
      phases: {
        agent: "agent",
        commands: "commands",
        integrity: "integrity",
        monorepo: "monorepo",
        release: "release",
        website: "website",
      },
      statuses: { PENDING: "TODO", IN_PROGRESS: "IN_PROGRESS", DONE: "DONE" },
      readme: "replaced",
      scope: null,
    });
    const local = (task: string, from: string, to: string) => ({
      project: null,
      task,
      field: "depends_on",
      from,
      to,
    });
    expect(result.rewritten).toEqual([
      local("agent/claude-skill", "publish-v1", "release/publish-v1"),
      local("commands/check", "note", "commands/note"),
      local("release/publish-v1", "versioning", "release/versioning"),
      local(
        "release/publish-v1",
        "release-workflow",
        "release/release-workflow",
      ),
      local("release/release-workflow", "versioning", "release/versioning"),
      local("website/docs-site", "publish-v1", "release/publish-v1"),
    ]);
    expect(result.unrewritten).toEqual([
      {
        project: null,
        task: "release/publish-v1",
        field: "depends_on",
        ref: "cross-platform-ci",
      },
    ]);
    expect(result.consequences).toHaveLength(1);
    expect(result.consequences[0]).toContain(
      "release/publish-v1 depends_on cross-platform-ci",
    );
  });

  it("prints a summary and the kept reference as a ! line", async () => {
    const s = await fixtureSandbox();
    const result = await s.run("migrate");
    expect(result.code).toBe(ExitCode.Success);
    const text = plain(result.stdout);
    expect(text).toContain("to .tasks v2: 15 tasks");
    expect(text).toContain("PENDING → TODO");
    expect(text).toContain("6 rewritten, 1 kept as written");
    expect(text).toContain("replaced with the v2 scaffold");
    expect(text).toContain("generated; _index.md removed");
    expect(text).toMatch(
      /^! kept as written.*release\/publish-v1 depends_on cross-platform-ci$/m,
    );
  });

  it("migrates once: a second run is a usage error naming the v2 tree", async () => {
    const s = await fixtureSandbox();
    migrated(await s.run("migrate", "--json"));
    const before = await snapshotFiles(s.tasksDir);

    const again = await s.run("migrate", "--json");
    expect(again.code).toBe(ExitCode.Usage);
    const error = errorOf(again);
    expect(error.message).toContain("already a .tasks v2 tree");
    expect(error.details).toMatchObject({ tasksDir: s.tasksDir, version: 2 });
    expect(await snapshotFiles(s.tasksDir)).toEqual(before);
  });

  it("records a session's heartbeat in the tree it upgraded", async () => {
    const s = await fixtureSandbox();
    migrated(await s.run("migrate", "--json", "--session", "s1"));
    expect(await s.exists(".tasks/.locks/sessions/s1")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* Version gate                                                             */
/* ------------------------------------------------------------------------ */

describe("migrate: which trees it accepts", () => {
  it("refuses a v2 tree", async () => {
    sandbox = await makeSandbox();
    await sandbox.initV2();
    const result = await sandbox.run("migrate");
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain("already a .tasks v2 tree");
  });

  it("refuses a tree of an unsupported version without touching it", async () => {
    const s = await v1Sandbox({ tasks: { "a/x": {}, "a/y": {} } });
    await s.write(".tasks/config.yml", "version: 3\n");
    const before = await snapshotFiles(s.tasksDir);
    const result = await s.run("migrate", "--json");
    expect(result.code).toBe(ExitCode.Usage);
    expect(errorOf(result).details).toMatchObject({ version: 3 });
    expect(await snapshotFiles(s.tasksDir)).toEqual(before);
    expect(await s.exists(".tasks/.locks")).toBe(false);
  });

  it("fails as not found without a tree", async () => {
    sandbox = await makeSandbox();
    const result = await sandbox.run("migrate");
    expect(result.code).toBe(ExitCode.NotFound);
  });

  it("migrates a tree without config.yml, which is v1 by default", async () => {
    const s = await v1Sandbox({ tasks: { "work/x": {}, "work/y": {} } });
    await fs.rm(path.join(s.tasksDir, "config.yml"));
    const result = migrated(await s.run("migrate", "--json"));
    expect(result.tasks).toBe(2);
    expect(await s.read(".tasks/config.yml")).toBe("version: 2\n");
  });

  it("is the one command a v1 tree allows", async () => {
    const s = await v1Sandbox({ tasks: { "work/x": {} } });
    const listed = await s.run("list");
    expect(listed.code).toBe(ExitCode.Usage);
    expect(listed.stderr).toContain("tasks migrate");
    migrated(await s.run("migrate", "--json"));
    expect((await s.run("list")).code).toBe(ExitCode.Success);
  });
});

/* ------------------------------------------------------------------------ */
/* Refusals                                                                 */
/* ------------------------------------------------------------------------ */

describe("migrate: refusals before anything is written", () => {
  it("refuses phases with a dot or an underscore, naming them, until --map-phase renames them", async () => {
    const s = await v1Sandbox({
      tasks: {
        "v1.0/alpha": {},
        "my_phase/beta": { depends_on: ["alpha"] },
        "fine/gamma": {},
      },
    });
    await s.write(".tasks/v1.0/notes.txt", "kept with the phase\n");
    const before = await snapshotFiles(s.tasksDir);

    const refused = await s.run("migrate", "--json");
    const problems = problemsOf(refused);
    expect(problems.map((p) => [p.kind, "phase" in p && p.phase])).toEqual([
      ["unmapped-phase", "my_phase"],
      ["unmapped-phase", "v1.0"],
    ]);
    expect(errorOf(refused).message).toContain("--map-phase v1.0=<name>");
    expect(await snapshotFiles(s.tasksDir)).toEqual(before);

    const result = migrated(
      await s.run(
        "migrate",
        "--map-phase",
        "v1.0=v1-0",
        "--map-phase",
        "my_phase=my-phase",
        "--json",
      ),
    );
    expect(result.phases).toEqual({
      fine: "fine",
      my_phase: "my-phase",
      "v1.0": "v1-0",
    });
    expect(await s.exists(".tasks/v1.0")).toBe(false);
    expect(await s.exists(".tasks/my_phase")).toBe(false);
    expect(await s.read(".tasks/v1-0/notes.txt")).toBe("kept with the phase\n");
    expect(
      (await manifest(s, ".tasks/my-phase/beta/task.md")).frontmatter,
    ).toMatchObject({ depends_on: ["v1-0/alpha"] });
    expect(await s.exists(".tasks/v1-0/alpha/task.md")).toBe(true);
  });

  it("refuses a --map-phase for a phase the tree does not have, and one onto an existing phase", async () => {
    const s = await v1Sandbox({ tasks: { "a.b/x": {}, "c/y": {} } });
    const unknown = problemsOf(
      await s.run(
        "migrate",
        "--map-phase",
        "a.b=ab",
        "--map-phase",
        "nope=n",
        "--json",
      ),
    );
    expect(unknown).toEqual([
      expect.objectContaining({
        kind: "unknown-mapping",
        option: "--map-phase",
        old: "nope",
      }),
    ]);

    const merge = problemsOf(
      await s.run("migrate", "--map-phase", "a.b=c", "--json"),
    );
    expect(merge).toEqual([expect.objectContaining({ kind: "collision" })]);
    expect(merge[0]!.message).toContain("would both become");
  });

  it("refuses a status outside the roles until --map names it, then maps it", async () => {
    const s = await v1Sandbox({
      config:
        "version: 1\nstatuses: [PENDING, IN_PROGRESS, REVIEW, DONE]\nroles:\n  done: DONE\n",
      tasks: {
        "work/a": { status: "REVIEW" },
        "work/b": { status: "REVIEW" },
        "work/c": { status: "DONE" },
      },
    });
    const before = await snapshotFiles(s.tasksDir);
    const refused = await s.run("migrate", "--json");
    const problems = problemsOf(refused);
    expect(problems).toEqual([
      expect.objectContaining({
        kind: "unmapped-status",
        status: "REVIEW",
        paths: [
          path.join(s.tasksDir, "work", "a.md"),
          path.join(s.tasksDir, "work", "b.md"),
        ],
      }),
    ]);
    expect(errorOf(refused).message).toContain("--map REVIEW=<status>");
    expect(await snapshotFiles(s.tasksDir)).toEqual(before);

    const result = migrated(
      await s.run("migrate", "--map", "REVIEW=TODO", "--json"),
    );
    expect(result.statuses).toEqual({
      PENDING: "TODO",
      IN_PROGRESS: "IN_PROGRESS",
      REVIEW: "TODO",
      DONE: "DONE",
    });
    expect(
      (await manifest(s, ".tasks/work/a/task.md")).frontmatter.status,
    ).toBe("TODO");
  });

  it("lets --map override a role's status", async () => {
    const s = await v1Sandbox({
      tasks: { "work/someday": {}, "work/done": { status: "DONE" } },
    });
    const result = migrated(
      await s.run("migrate", "--map", "PENDING=BACKLOG", "--json"),
    );
    expect(result.statuses).toEqual({
      PENDING: "BACKLOG",
      IN_PROGRESS: "IN_PROGRESS",
      DONE: "DONE",
    });
    expect(
      (await manifest(s, ".tasks/work/someday/task.md")).frontmatter.status,
    ).toBe("BACKLOG");
    expect((await validation(s)).findings).toEqual([]);
  });

  it("renames a phase whose name differs only in case", async () => {
    const s = await v1Sandbox({ tasks: { "Backlog/x": {}, "work/y": {} } });
    const result = migrated(
      await s.run("migrate", "--map-phase", "Backlog=backlog", "--json"),
    );
    expect(result.phases).toEqual({ Backlog: "backlog", work: "work" });
    const entries = await fs.readdir(s.tasksDir);
    expect(entries).toContain("backlog");
    expect(entries).not.toContain("Backlog");
    expect(await s.exists(".tasks/backlog/x/task.md")).toBe(true);
  });

  it("maps a status whose two roles disagree only through --map", async () => {
    // Two statuses: v1's default roles put claimed and done on the second.
    const s = await v1Sandbox({
      config: "version: 1\nstatuses: [OPEN, CLOSED]\n",
      tasks: { "work/a": { status: "CLOSED" }, "work/b": { status: "OPEN" } },
    });
    const problems = problemsOf(await s.run("migrate", "--json"));
    expect(problems).toEqual([
      expect.objectContaining({ kind: "unmapped-status", status: "CLOSED" }),
    ]);
    expect(problems[0]!.message).toContain("ambiguous");

    const result = migrated(
      await s.run("migrate", "--map", "CLOSED=DONE", "--json"),
    );
    expect(result.statuses).toEqual({ OPEN: "TODO", CLOSED: "DONE" });
  });

  it("refuses a --map to a status v2 does not have, and a malformed mapping", async () => {
    const s = await v1Sandbox({ tasks: { "work/a": {} } });
    const before = await snapshotFiles(s.tasksDir);

    const invalid = await s.run(
      "migrate",
      "--map",
      "REVIEW=IN_REVIEW",
      "--json",
    );
    expect(invalid.code).toBe(ExitCode.Usage);
    expect(errorOf(invalid).details).toMatchObject({
      option: "--map",
      value: "REVIEW=IN_REVIEW",
    });

    const shapeless = await s.run("migrate", "--map", "REVIEW", "--json");
    expect(shapeless.code).toBe(ExitCode.Usage);

    const badPhase = await s.run("migrate", "--map-phase", "a=B_c", "--json");
    expect(badPhase.code).toBe(ExitCode.Usage);

    const unknown = problemsOf(
      await s.run("migrate", "--map", "NOPE=TODO", "--json"),
    );
    expect(unknown).toEqual([
      expect.objectContaining({ kind: "unknown-mapping", old: "NOPE" }),
    ]);
    expect(await snapshotFiles(s.tasksDir)).toEqual(before);
  });

  it("refuses a claimed_by that is not an actor, naming the task", async () => {
    const s = await v1Sandbox({
      tasks: {
        "work/a": {
          status: "IN_PROGRESS",
          claimed_by: "Jane Doe",
          claimed_at: "2026-08-01T10:00:00Z",
        },
        "work/b": {},
      },
    });
    const before = await snapshotFiles(s.tasksDir);
    const problems = problemsOf(await s.run("migrate", "--json"));
    expect(problems).toEqual([
      expect.objectContaining({
        kind: "invalid-value",
        path: path.join(s.tasksDir, "work", "a.md"),
        field: "claimed_by",
        value: "Jane Doe",
      }),
    ]);
    expect(await snapshotFiles(s.tasksDir)).toEqual(before);
  });

  it("refuses claim fields that disagree with the mapped status", async () => {
    const s = await v1Sandbox({
      tasks: {
        "work/claimed": { status: "IN_PROGRESS" },
        "work/done": {
          status: "DONE",
          claimed_by: "agent",
          claimed_at: "2026-08-01T10:00:00Z",
        },
      },
    });
    const problems = problemsOf(await s.run("migrate", "--json"));
    expect(problems.map((p) => p.kind)).toEqual([
      "claim-fields",
      "claim-fields",
    ]);
    expect(problems.map((p) => "path" in p && path.basename(p.path))).toEqual([
      "claimed.md",
      "done.md",
    ]);
  });

  it("refuses values v2 cannot hold: a timestamp, an id, a key v2 defines", async () => {
    const s = await v1Sandbox({
      tasks: {
        "work/a": { created: "2026-08-01" },
        "work/b": { id: "Bad_Id" },
        "work/c": { extra: { priority: "high" } },
      },
    });
    const problems = problemsOf(await s.run("migrate", "--json"));
    expect(
      problems.map((p) => [p.kind, "field" in p ? p.field : null]),
    ).toEqual([
      ["invalid-value", "id"],
      ["invalid-value", "created"],
      ["invalid-value", "priority"],
    ]);
  });

  it("migrates nothing around a malformed v1 file", async () => {
    const s = await v1Sandbox({ tasks: { "work/a": {}, "work/b": {} } });
    await s.write(".tasks/work/broken.md", "# no frontmatter\n");
    await s.write(".tasks/work/half.md", "---\nid: half\nphase: work\n---\n");
    const before = await snapshotFiles(s.tasksDir);

    const result = await s.run("migrate", "--json");
    const problems = problemsOf(result);
    expect(problems.map((p) => [p.kind, "path" in p && p.path])).toEqual([
      ["malformed", path.join(s.tasksDir, "work", "broken.md")],
      ["malformed", path.join(s.tasksDir, "work", "half.md")],
    ]);
    expect(errorOf(result).message).toContain("nothing was written");
    expect(await snapshotFiles(s.tasksDir)).toEqual(before);

    const text = await s.run("migrate");
    expect(plain(text.stderr)).toContain("work/broken.md does not parse");
  });

  it("refuses a destination that already exists and two archived tasks with one id", async () => {
    const s = await v1Sandbox({
      tasks: { "work/a": {}, "work/b": {} },
      archived: {
        old: { id: "old", phase: "work" },
        "old-copy": { id: "old", phase: "other" },
      },
    });
    await s.write(".tasks/work/a/screenshot.png", "png");
    await s.write(".tasks/index.md", "# my own index\n");
    const problems = problemsOf(await s.run("migrate", "--json"));
    expect(problems.map((p) => p.kind)).toEqual([
      "duplicate-id",
      "collision",
      "collision",
    ]);
    expect(problems[0]).toMatchObject({ id: "old" });
    expect(problems[1]).toMatchObject({
      path: path.join(s.tasksDir, "work", "a"),
    });
    expect(problems[2]).toMatchObject({
      path: path.join(s.tasksDir, "index.md"),
    });
  });

  it("refuses two live tasks with one id, and an archived task at a live task's path", async () => {
    const s = await v1Sandbox({
      tasks: {
        "a/twin": {},
        "b/other": { id: "twin" },
        "work/kept": {},
      },
      archived: { kept: { phase: "work", status: "DONE" } },
    });
    const problems = problemsOf(await s.run("migrate", "--json"));
    expect(problems).toEqual([
      expect.objectContaining({
        kind: "duplicate-id",
        id: "twin",
        paths: [
          path.join(s.tasksDir, "a", "twin.md"),
          path.join(s.tasksDir, "b", "other.md"),
        ],
      }),
      expect.objectContaining({
        kind: "collision",
        path: path.join(s.tasksDir, ".archive", "work", "kept"),
      }),
    ]);
    expect(problems[1]!.message).toContain("reserves an archived task's path");
  });

  it("lists every problem of every kind in one error", async () => {
    const s = await v1Sandbox({
      tasks: {
        "v1.0/a": { status: "REVIEW" },
        "work/b": { claimed_by: "two words" },
      },
    });
    const problems = problemsOf(await s.run("migrate", "--json"));
    expect(problems.map((p) => p.kind)).toEqual([
      "unmapped-phase",
      "unmapped-status",
      "invalid-value",
      "claim-fields",
    ]);
  });

  it("refuses a phase reached through a symbolic link, which v2 would not follow", async () => {
    const s = await v1Sandbox({ tasks: { "work/a": {} } });
    const elsewhere = path.join(s.root, "elsewhere");
    await writeV1Tree(elsewhere, { tasks: { "linked/z": {} } });
    await fs.symlink(
      path.join(elsewhere, "linked"),
      path.join(s.tasksDir, "linked"),
    );
    const problems = problemsOf(await s.run("migrate", "--json"));
    expect(problems).toEqual([
      expect.objectContaining({
        kind: "malformed",
        path: path.join(s.tasksDir, "linked"),
      }),
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* What the migration carries over                                          */
/* ------------------------------------------------------------------------ */

describe("migrate: claims, statuses and the files beside the tasks", () => {
  it("keeps an IN_PROGRESS claim without a session and says what that means", async () => {
    const s = await v1Sandbox({
      tasks: {
        "work/a": {
          status: "IN_PROGRESS",
          claimed_by: "agent",
          claimed_at: "2026-08-01T10:00:00Z",
        },
      },
    });
    const result = await s.run("migrate");
    expect(result.code).toBe(ExitCode.Success);
    expect(
      (await manifest(s, ".tasks/work/a/task.md")).frontmatter,
    ).toMatchObject({
      status: "IN_PROGRESS",
      claimed_by: "agent",
      claimed_at: "2026-08-01T10:00:00Z",
      claimed_session: null,
    });
    expect(plain(result.stdout)).toMatch(
      /^! IN_PROGRESS with claimed_session: null.*--force: work\/a$/m,
    );

    const shown = await s.run("show", "work/a", "--json");
    expect(shown.json<{ liveness: string }>().liveness).toBe("unknown");
    // A null session is a person's claim, not a finding.
    expect((await validation(s)).findings).toEqual([]);
  });

  it("maps a status to PAUSED and reports the missing state.md", async () => {
    const s = await v1Sandbox({
      config: "version: 1\nstatuses: [PENDING, IN_PROGRESS, BLOCKED, DONE]\n",
      tasks: { "work/a": { status: "BLOCKED" }, "work/b": {} },
    });
    const result = await s.run("migrate", "--map", "BLOCKED=PAUSED");
    expect(result.code).toBe(ExitCode.Success);
    expect(plain(result.stdout)).toMatch(
      /^! PAUSED without a state\.md.*: work\/a$/m,
    );
    expect(kinds((await validation(s)).findings)).toEqual([
      { severity: "warning", kind: "paused-without-state", task: "work/a" },
    ]);
  });

  it("keeps an edited README and reports it", async () => {
    const s = await v1Sandbox({
      tasks: { "work/a": {} },
      readme: `${v1ReadmeTemplate()}\nOur own conventions.\n`,
    });
    const result = migrated(await s.run("migrate", "--json"));
    expect(result.readme).toBe("kept");
    expect(await s.read(".tasks/README.md")).toContain("Our own conventions.");
    expect(result.consequences).toEqual([
      expect.stringContaining("README.md was edited"),
    ]);
  });

  it("replaces a CRLF checkout of the scaffold", async () => {
    const s = await v1Sandbox({
      tasks: { "work/a": {} },
      readme: v1ReadmeTemplate().replace(/\n/g, "\r\n"),
    });
    expect(migrated(await s.run("migrate", "--json")).readme).toBe("replaced");
    expect(await s.read(".tasks/README.md")).toBe(readmeTemplate());
  });

  it("leaves an absent README absent", async () => {
    const s = await v1Sandbox({ tasks: { "work/a": {} }, readme: null });
    expect(migrated(await s.run("migrate", "--json")).readme).toBe("absent");
    expect(await s.exists(".tasks/README.md")).toBe(false);
  });

  it("turns active_phase into scope, through --map-phase", async () => {
    const s = await v1Sandbox({
      config: "version: 1\nactive_phase: v2.x\n",
      tasks: { "v2.x/a": {} },
    });
    const result = migrated(
      await s.run("migrate", "--map-phase", "v2.x=next", "--json"),
    );
    expect(result.scope).toBe("next");
    expect(await s.read(".tasks/config.yml")).toBe("version: 2\nscope: next\n");
  });

  it("drops an active_phase that names no phase directory, with a warning", async () => {
    const s = await v1Sandbox({
      config: "version: 1\nactive_phase: gone\n",
      tasks: { "work/a": {} },
    });
    const dropped = migrated(await s.run("migrate", "--json"));
    expect(dropped.scope).toBeNull();
    expect(dropped.consequences).toEqual([
      'no scope: active_phase "gone" names no phase directory of the tree',
    ]);
    expect(await s.read(".tasks/config.yml")).toBe("version: 2\n");
  });

  it("moves archived tasks under .archive/<phase>/ and points references at them", async () => {
    const s = await v1Sandbox({
      tasks: { "work/live": { depends_on: ["gone"] } },
      archived: { gone: { phase: "old", status: "DONE" } },
    });
    const result = migrated(await s.run("migrate", "--json"));
    expect(result.archived).toBe(1);
    expect(result.phases).toEqual({ old: "old", work: "work" });
    expect(await s.exists(".tasks/.archive/gone.md")).toBe(false);
    expect(
      (await manifest(s, ".tasks/.archive/old/gone/task.md")).frontmatter
        .status,
    ).toBe("DONE");
    expect(
      (await manifest(s, ".tasks/work/live/task.md")).frontmatter.depends_on,
    ).toEqual(["old/gone"]);
    // Archived, so still blocking, as it was in v1.
    const shown = await s.run("show", "work/live", "--json");
    expect(
      shown.json<{ blocked_by: Array<{ reason: string }> }>().blocked_by,
    ).toEqual([
      expect.objectContaining({ ref: "old/gone", reason: "archived" }),
    ]);
  });

  it("keeps unknown frontmatter keys in their order", async () => {
    const s = await v1Sandbox({
      tasks: { "work/a": { extra: { estimate: 3, labels: ["x", "y"] } } },
    });
    migrated(await s.run("migrate", "--json"));
    const parsed = await manifest(s, ".tasks/work/a/task.md");
    expect(parsed.extra).toEqual([
      ["estimate", 3],
      ["labels", ["x", "y"]],
    ]);
    expect(kinds((await validation(s)).findings)).toEqual([
      { severity: "warning", kind: "unknown-key", task: "work/a" },
      { severity: "warning", kind: "unknown-key", task: "work/a" },
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* References across trees                                                  */
/* ------------------------------------------------------------------------ */

describe("migrate: references to and from other trees", () => {
  it("rewrites an external reference into a v1 or a v2 tree that holds the id, and keeps one it cannot resolve", async () => {
    const s = await v1Sandbox({
      tasks: {
        "work/a": {
          depends_on: [
            "../old:zeta",
            "../lib:lib-task",
            "../nowhere:x",
            "../lib:absent",
            // A path back into the tree being migrated resolves there too.
            "../repo:b",
          ],
        },
        "work/b": {},
      },
    });
    await writeV1Tree(path.join(s.root, "old", ".tasks"), {
      tasks: { "stuff/zeta": { status: "DONE" } },
    });
    const lib = path.join(s.root, "lib", ".tasks");
    await fs.mkdir(path.join(lib, "group", "lib-task"), { recursive: true });
    await fs.writeFile(path.join(lib, "config.yml"), "version: 2\n");
    await fs.writeFile(
      path.join(lib, "group", "lib-task", "task.md"),
      `---\nstatus: DONE\ncreated: "${FIXTURE_TIME}"\nupdated: "${FIXTURE_TIME}"\n---\n`,
    );

    const result = migrated(await s.run("migrate", "--json"));
    expect(
      (await manifest(s, ".tasks/work/a/task.md")).frontmatter.depends_on,
    ).toEqual([
      "../old:stuff/zeta",
      "../lib:group/lib-task",
      "../nowhere:x",
      "../lib:absent",
      "../repo:work/b",
    ]);
    expect(result.rewritten.map((ref) => ref.to)).toEqual([
      "../old:stuff/zeta",
      "../lib:group/lib-task",
      "../repo:work/b",
    ]);
    expect(result.unrewritten).toEqual([
      {
        project: null,
        task: "work/a",
        field: "depends_on",
        ref: "../nowhere:x",
      },
      {
        project: null,
        task: "work/a",
        field: "depends_on",
        ref: "../lib:absent",
      },
    ]);
  });

  it("lists bare-id references into it held by a tree it can read but not write", async () => {
    const s = await v1Sandbox({
      tasks: { "work/alpha": { depends_on: ["../lib:lib-task"] } },
    });
    const lib = path.join(s.root, "lib", ".tasks");
    await fs.mkdir(path.join(lib, "lib-task"), { recursive: true });
    await fs.writeFile(path.join(lib, "config.yml"), "version: 2\n");
    const libTask = `---\nstatus: TODO\npriority: normal\ndepends_on: ["../repo:alpha"]\nfinishes_after: []\nassignee: null\nclaimed_by: null\nclaimed_at: null\nclaimed_session: null\ncreated: "${FIXTURE_TIME}"\nupdated: "${FIXTURE_TIME}"\n---\n`;
    await fs.writeFile(path.join(lib, "lib-task", "task.md"), libTask);

    const result = migrated(await s.run("migrate", "--json"));
    expect(result.unrewritten).toEqual([
      {
        project: "../lib",
        task: "lib-task",
        field: "depends_on",
        ref: "../repo:alpha",
      },
    ]);
    expect(
      await fs.readFile(path.join(lib, "lib-task", "task.md"), "utf8"),
    ).toBe(libTask);
    expect(result.consequences[0]).toContain(
      "../lib:lib-task depends_on ../repo:alpha",
    );
  });

  it("migrates a listed v1 project from a v2 tracker and rewrites the tracker's references into it", async () => {
    sandbox = await makeSandbox();
    const s = sandbox;
    await s.tree({
      tasks: {
        epic: {
          depends_on: ["../backend:publish-v1", "../backend:versioning"],
          finishes_after: ["../backend:cross-tree"],
        },
        local: { depends_on: ["epic"] },
      },
    });
    const backend = path.join(s.root, "backend");
    await fs.cp(FIXTURE, path.join(backend, ".tasks"), { recursive: true });
    await addProjectAlias(s.tasksDir, "backend", "../backend");
    // An index the migration has to bring up to date.
    expect((await s.run("reindex")).code).toBe(ExitCode.Success);
    expect(await s.read(".tasks/index.md")).toContain("unsupported-version");

    const result = migrated(await s.run("migrate", "backend", "--json"));
    expect(result.tree).toBe(path.join(backend, ".tasks"));
    expect(result.tasks).toBe(15);
    expect(result.rewritten.filter((ref) => ref.project === null)).toEqual([
      {
        project: null,
        task: "epic",
        field: "depends_on",
        from: "../backend:publish-v1",
        to: "../backend:release/publish-v1",
      },
      {
        project: null,
        task: "epic",
        field: "depends_on",
        from: "../backend:versioning",
        to: "../backend:release/versioning",
      },
      {
        project: null,
        task: "epic",
        field: "finishes_after",
        from: "../backend:cross-tree",
        to: "../backend:monorepo/cross-tree",
      },
    ]);
    expect(
      result.rewritten.filter((ref) => ref.project === "backend"),
    ).toHaveLength(6);
    expect(result.unrewritten).toEqual([
      {
        project: "backend",
        task: "release/publish-v1",
        field: "depends_on",
        ref: "cross-platform-ci",
      },
    ]);
    expect(result.consequences[0]).toContain(
      "backend:release/publish-v1 depends_on cross-platform-ci",
    );

    const epic = await manifest(s, ".tasks/epic/task.md");
    expect(epic.frontmatter.depends_on).toEqual([
      "../backend:release/publish-v1",
      "../backend:release/versioning",
    ]);
    expect(epic.frontmatter.finishes_after).toEqual([
      "../backend:monorepo/cross-tree",
    ]);
    expect(epic.frontmatter.updated).not.toBe(FIXTURE_TIME);
    expect(
      (await manifest(s, ".tasks/local/task.md")).frontmatter.updated,
    ).toBe(FIXTURE_TIME);

    expect(
      await fs.readFile(path.join(backend, ".tasks", "config.yml"), "utf8"),
    ).toBe("version: 2\n");
    expect(await s.read(".tasks/index.md")).not.toContain(
      "unsupported-version",
    );
    expect((await validation(s)).findings).toEqual([]);
    const shown = await s.run("show", "backend:publish-v1", "--json");
    expect(shown.json<{ id: string }>().id).toBe("backend:release/publish-v1");

    // The project's index.md reads as the project sees itself: fresh there.
    const own = await s.runWith({ cwd: backend }, "validate", "--json");
    expect(kinds((JSON.parse(own.stdout) as ValidationJson).findings)).toEqual([
      {
        severity: "warning",
        kind: "unsatisfiable-ref",
        task: "release/publish-v1",
      },
    ]);
  });

  it("carries references through a phase rename, including paths an earlier migration resolved", async () => {
    sandbox = await makeSandbox();
    const s = sandbox;
    // `../backend:commands/note` is what migrating a tree that depended on
    // the v1 backend wrote: the backend's phase as it was then.
    await s.tree({
      tasks: {
        epic: {
          depends_on: ["../backend:note", "../backend:commands/note"],
        },
      },
    });
    const backend = path.join(s.root, "backend");
    await writeV1Tree(path.join(backend, ".tasks"), {
      tasks: {
        "commands/note": {},
        "commands/check": { depends_on: ["note"] },
      },
    });
    await addProjectAlias(s.tasksDir, "backend", "../backend");

    const result = migrated(
      await s.run(
        "migrate",
        "backend",
        "--map-phase",
        "commands=cli",
        "--json",
      ),
    );
    expect(result.phases).toEqual({ commands: "cli" });
    expect(
      (await manifest(s, ".tasks/epic/task.md")).frontmatter.depends_on,
    ).toEqual(["../backend:cli/note", "../backend:cli/note"]);
    expect(
      result.rewritten.map((ref) => [ref.project, ref.task, ref.to]),
    ).toEqual([
      ["backend", "cli/check", "cli/note"],
      [null, "epic", "../backend:cli/note"],
      [null, "epic", "../backend:cli/note"],
    ]);
  });

  it("refuses an alias that is unknown, already v2, or not checked out", async () => {
    sandbox = await makeSandbox();
    const s = sandbox;
    await s.tree({ tasks: { a: {} } });
    await s.project("modern", "../modern", { tasks: { b: {} } });
    await addProjectAlias(s.tasksDir, "absent", "../absent");

    const unknown = await s.run("migrate", "nope", "--json");
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(errorOf(unknown).details).toMatchObject({ alias: "nope" });

    const modern = await s.run("migrate", "modern", "--json");
    expect(modern.code).toBe(ExitCode.Usage);
    expect(errorOf(modern).message).toContain("already a .tasks v2 tree");

    const absent = await s.run("migrate", "absent", "--json");
    expect(absent.code).toBe(ExitCode.NotFound);
    expect(errorOf(absent).details).toMatchObject({
      reason: "not-checked-out",
    });
  });

  it("needs a v2 tree to run in when it names an alias", async () => {
    const s = await v1Sandbox({ tasks: { "work/a": {} } });
    const result = await s.run("migrate", "backend", "--json");
    expect(result.code).toBe(ExitCode.Usage);
    expect(errorOf(result).details).toMatchObject({ version: 1 });
  });
});

/* ------------------------------------------------------------------------ */
/* The v1 reader and the option parsers                                     */
/* ------------------------------------------------------------------------ */

describe("migrate: the frozen v1 reader", () => {
  it("defaults statuses and roles as v1 did", () => {
    expect(parseV1Config("", "config.yml")).toEqual({
      activePhase: null,
      statuses: ["PENDING", "IN_PROGRESS", "DONE"],
      roles: { ready: "PENDING", claimed: "IN_PROGRESS", done: "DONE" },
    });
    expect(
      parseV1Config(
        "version: 1\nactive_phase: q1\nstatuses: [A, B, C, D]\n",
        "config.yml",
      ),
    ).toEqual({
      activePhase: "q1",
      statuses: ["A", "B", "C", "D"],
      roles: { ready: "A", claimed: "B", done: "D" },
    });
  });

  it("refuses a configuration v1 refused", () => {
    expect(() =>
      parseV1Config("statuses: [A, B]\nroles:\n  ready: Z\n", "config.yml"),
    ).toThrow(/roles\.ready is "Z"/);
    expect(() => parseV1Config("unknown: 1\n", "config.yml")).toThrow(
      /config\.yml/,
    );
    expect(() =>
      parseV1Config(
        "statuses: [A, B, C]\nroles:\n  ready: A\n  claimed: C\n",
        "config.yml",
      ),
    ).toThrow(/could never claim/);
  });

  it("splits a task file with a byte-order mark or CRLF line endings, and reports a missing delimiter", () => {
    const parsed = parseV1TaskFile(
      '\uFEFF---\r\nid: a\r\nphase: p\r\nstatus: PENDING\r\ncreated: "2026-01-01T00:00:00Z"\r\nupdated: "2026-01-01T00:00:00Z"\r\nnote: kept\r\n---\r\n\r\n# A\r\n',
    );
    expect(parsed).toMatchObject({
      ok: true,
      fields: { id: "a", phase: "p", depends_on: [], claimed_by: null },
      extra: [["note", "kept"]],
      body: "\r\n# A\r\n",
    });
    expect(parseV1TaskFile("# just a body\n")).toMatchObject({ ok: false });
    expect(parseV1TaskFile("---\nid: a\n")).toEqual({
      ok: false,
      message: "the frontmatter has no closing --- line",
    });
    expect(parseV1TaskFile("---\nid: a\n---\n")).toMatchObject({
      ok: false,
      message: expect.stringContaining("phase"),
    });
  });

  it("reads references as v1 did: a bare id, or a relative path and an id", () => {
    expect(parseV1Reference("note")).toEqual({ kind: "local", id: "note" });
    expect(parseV1Reference(" ../api:token ")).toEqual({
      kind: "external",
      projectPath: "../api",
      id: "token",
    });
    expect(parseV1Reference("/abs:token")).toBeNull();
    expect(parseV1Reference("Not An Id")).toBeNull();
    expect(parseV1Reference(":x")).toBeNull();
  });

  it("parses repeatable mappings and refuses conflicting ones", () => {
    expect(parseStatusMappings(["A=TODO", "B=PAUSED", "A=TODO"])).toEqual(
      new Map([
        ["A", "TODO"],
        ["B", "PAUSED"],
      ]),
    );
    expect(() => parseStatusMappings(["A=TODO", "A=DONE"])).toThrow(/twice/);
    expect(parsePhaseMappings(["a=b=c"])).toEqual(new Map([["a=b", "c"]]));
    expect(() => parsePhaseMappings(["a="])).toThrow(/OLD=NEW/);
  });
});
