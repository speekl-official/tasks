import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VERSION, buildCli } from "../src/cli.js";
import { ExitCode } from "../src/errors.js";
import { initializedSandbox, makeSandbox, type Sandbox } from "./helpers.js";

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

describe("tasks init", () => {
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  it("scaffolds the convention files", async () => {
    const result = await sandbox.run("init");
    expect(result.code).toBe(ExitCode.Success);

    expect(await sandbox.exists(".tasks/config.yml")).toBe(true);
    expect(await sandbox.exists(".tasks/README.md")).toBe(true);
    expect(await sandbox.exists(".tasks/.gitignore")).toBe(true);
    expect(await sandbox.exists(".tasks/.locks")).toBe(true);
  });

  it("ignores locks via a self-contained gitignore", async () => {
    await sandbox.run("init");
    expect(await sandbox.read(".tasks/.gitignore")).toContain(".locks/");
  });

  it("refuses to reinitialize without --force", async () => {
    await sandbox.run("init");
    const result = await sandbox.run("init");
    expect(result.code).toBe(ExitCode.Conflict);
  });

  it("reports a missing tree as not found, not a crash", async () => {
    const result = await sandbox.run("list");
    expect(result.code).toBe(ExitCode.NotFound);
    expect(result.stderr).toContain(".tasks");
  });
});

describe("tasks new", () => {
  beforeEach(async () => {
    sandbox = await initializedSandbox();
  });

  it("creates a task in a phase directory it auto-creates", async () => {
    const result = await sandbox.run(
      "new",
      "auth",
      "Rework the login flow",
      "--json",
    );
    expect(result.code).toBe(ExitCode.Success);

    const task = result.json<{ id: string; phase: string; status: string }>();
    expect(task.id).toBe("rework-the-login-flow");
    expect(task.phase).toBe("auth");
    expect(task.status).toBe("PENDING");
    expect(await sandbox.exists(".tasks/auth/rework-the-login-flow.md")).toBe(
      true,
    );
  });

  it("scaffolds the three body sections", async () => {
    await sandbox.run("new", "auth", "Login");
    const file = await sandbox.read(".tasks/auth/login.md");
    expect(file).toContain("## Description");
    expect(file).toContain("## Acceptance criteria");
    expect(file).toContain("## Notes");
  });

  it("honours an explicit --id", async () => {
    await sandbox.run("new", "auth", "Something long", "--id", "short");
    expect(await sandbox.exists(".tasks/auth/short.md")).toBe(true);
  });

  it("refuses a duplicate id", async () => {
    await sandbox.run("new", "auth", "Login");
    const result = await sandbox.run("new", "other", "Login");
    expect(result.code).toBe(ExitCode.Conflict);
  });

  it("keeps archived ids reserved", async () => {
    await sandbox.run("new", "auth", "Login");
    await sandbox.run("delete", "login");
    const result = await sandbox.run("new", "auth", "Login");
    expect(result.code).toBe(ExitCode.Conflict);
    expect(result.stderr).toContain("archived");
  });
});

describe("status transitions", () => {
  beforeEach(async () => {
    sandbox = await initializedSandbox();
    await sandbox.run("new", "auth", "Login");
  });

  it("refuses to skip straight to DONE", async () => {
    const result = await sandbox.run("status", "login", "DONE");
    expect(result.code).toBe(ExitCode.Conflict);
    expect(result.stderr).toContain("Illegal transition");
  });

  it("allows reopening a completed task via claim, recording the new owner", async () => {
    await sandbox.run("claim", "login", "--as", "agent-1");
    await sandbox.run("status", "login", "DONE");

    const result = await sandbox.run(
      "claim",
      "login",
      "--as",
      "agent-2",
      "--json",
    );
    expect(result.code).toBe(ExitCode.Success);

    const task = result.json<{ status: string; claimed_by: string }>();
    expect(task.status).toBe("IN_PROGRESS");
    expect(task.claimed_by).toBe("agent-2");
  });

  it("points at claim rather than silently reopening without an owner", async () => {
    await sandbox.run("claim", "login");
    await sandbox.run("status", "login", "DONE");

    const result = await sandbox.run("status", "login", "IN_PROGRESS");
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain("tasks claim");
  });

  it("routes claims through `tasks claim` so metadata is recorded", async () => {
    const result = await sandbox.run("status", "login", "IN_PROGRESS");
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain("tasks claim");
  });

  it("rejects an unknown status as a usage error", async () => {
    const result = await sandbox.run("status", "login", "SHIPPED");
    expect(result.code).toBe(ExitCode.Usage);
  });

  it("clears claim metadata when leaving the claimed status", async () => {
    await sandbox.run("claim", "login", "--as", "agent-1");
    const result = await sandbox.run("status", "login", "DONE", "--json");
    const task = result.json<{ claimed_by: string | null }>();
    expect(task.claimed_by).toBeNull();
  });
});

describe("tasks claim", () => {
  beforeEach(async () => {
    sandbox = await initializedSandbox();
    await sandbox.run("new", "auth", "Login");
  });

  it("records who claimed it and when", async () => {
    const result = await sandbox.run(
      "claim",
      "login",
      "--as",
      "agent-1",
      "--json",
    );
    const task = result.json<{
      claimed_by: string;
      claimed_at: string;
      status: string;
    }>();

    expect(task.status).toBe("IN_PROGRESS");
    expect(task.claimed_by).toBe("agent-1");
    expect(task.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("refuses a second claim", async () => {
    await sandbox.run("claim", "login", "--as", "agent-1");
    const result = await sandbox.run("claim", "login", "--as", "agent-2");

    expect(result.code).toBe(ExitCode.Conflict);
    expect(result.stderr).toContain("agent-1");
  });

  it("refuses to claim a blocked task", async () => {
    await sandbox.run("new", "auth", "Schema");
    await sandbox.run("dep", "add", "login", "schema");

    const result = await sandbox.run("claim", "login");
    expect(result.code).toBe(ExitCode.Conflict);
    expect(result.stderr).toContain("blocked by");
  });

  it("claims a blocked task with --force", async () => {
    await sandbox.run("new", "auth", "Schema");
    await sandbox.run("dep", "add", "login", "schema");

    expect((await sandbox.run("claim", "login", "--force")).code).toBe(
      ExitCode.Success,
    );
  });

  it("releases back to the ready pool", async () => {
    await sandbox.run("claim", "login");
    const result = await sandbox.run("release", "login", "--json");
    const task = result.json<{ status: string; claimed_by: string | null }>();

    expect(task.status).toBe("PENDING");
    expect(task.claimed_by).toBeNull();
  });
});

describe("tasks ready", () => {
  beforeEach(async () => {
    sandbox = await initializedSandbox();
  });

  it("exits 0 with an empty list when nothing is ready", async () => {
    const result = await sandbox.run("ready", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<{ count: number }>().count).toBe(0);
  });

  it("hides tasks whose dependencies are unfinished", async () => {
    await sandbox.run("new", "auth", "Schema");
    await sandbox.run("new", "auth", "Login");
    await sandbox.run("dep", "add", "login", "schema");

    const result = await sandbox.run("ready", "--json");
    const ids = result
      .json<{ tasks: { id: string }[] }>()
      .tasks.map((t) => t.id);
    expect(ids).toEqual(["schema"]);
  });

  it("unblocks a dependent once its dependency is done", async () => {
    await sandbox.run("new", "auth", "Schema");
    await sandbox.run("new", "auth", "Login");
    await sandbox.run("dep", "add", "login", "schema");
    await sandbox.run("claim", "schema");
    await sandbox.run("status", "schema", "DONE");

    const result = await sandbox.run("ready", "--json");
    const ids = result
      .json<{ tasks: { id: string }[] }>()
      .tasks.map((t) => t.id);
    expect(ids).toEqual(["login"]);
  });

  it("treats a dangling dependency as blocking, never as satisfied", async () => {
    await sandbox.run("new", "auth", "Schema");
    await sandbox.run("new", "auth", "Login");
    await sandbox.run("dep", "add", "login", "schema");
    await sandbox.run("delete", "schema", "--force", "--purge");

    const result = await sandbox.run("ready", "--json");
    const ids = result
      .json<{ tasks: { id: string }[] }>()
      .tasks.map((t) => t.id);
    expect(ids).not.toContain("login");
  });

  it("treats an archived dependency as blocking", async () => {
    await sandbox.run("new", "auth", "Schema");
    await sandbox.run("new", "auth", "Login");
    await sandbox.run("dep", "add", "login", "schema");
    await sandbox.run("delete", "schema", "--force");

    const result = await sandbox.run("ready", "--json");
    const ids = result
      .json<{ tasks: { id: string }[] }>()
      .tasks.map((t) => t.id);
    expect(ids).not.toContain("login");
  });

  it("scopes to active_phase by default and --all overrides", async () => {
    await sandbox.run("new", "auth", "One");
    await sandbox.run("new", "billing", "Two");
    await sandbox.write(
      ".tasks/config.yml",
      "version: 1\nactive_phase: auth\n",
    );

    const scoped = await sandbox.run("ready", "--json");
    expect(
      scoped.json<{ tasks: { id: string }[] }>().tasks.map((t) => t.id),
    ).toEqual(["one"]);

    const all = await sandbox.run("ready", "--all", "--json");
    expect(
      all.json<{ tasks: { id: string }[] }>().tasks.map((t) => t.id),
    ).toEqual(["one", "two"]);
  });
});

describe("tasks dep", () => {
  beforeEach(async () => {
    sandbox = await initializedSandbox();
    await sandbox.run("new", "auth", "A");
    await sandbox.run("new", "auth", "B");
  });

  it("refuses a dependency on a nonexistent task", async () => {
    const result = await sandbox.run("dep", "add", "a", "ghost");
    expect(result.code).toBe(ExitCode.NotFound);
  });

  it("refuses a self-dependency", async () => {
    const result = await sandbox.run("dep", "add", "a", "a");
    expect(result.code).toBe(ExitCode.Usage);
  });

  it("refuses to create a cycle", async () => {
    await sandbox.run("dep", "add", "a", "b");
    const result = await sandbox.run("dep", "add", "b", "a");

    expect(result.code).toBe(ExitCode.Conflict);
    expect(result.stderr).toContain("cycle");
  });

  it("adds and removes dependencies idempotently", async () => {
    await sandbox.run("dep", "add", "a", "b");
    await sandbox.run("dep", "add", "a", "b");

    const listed = await sandbox.run("dep", "list", "a", "--json");
    expect(listed.json<{ count: number }>().count).toBe(1);

    await sandbox.run("dep", "rm", "a", "b");
    const after = await sandbox.run("dep", "list", "a", "--json");
    expect(after.json<{ count: number }>().count).toBe(0);
  });

  it("accepts a cross-repo ref and reports it unresolved when absent", async () => {
    const added = await sandbox.run(
      "dep",
      "add",
      "a",
      "../elsewhere:remote-task",
    );
    expect(added.code).toBe(ExitCode.Success);

    const listed = await sandbox.run("dep", "list", "a", "--json");
    const deps = listed.json<{
      dependencies: { reason: string; satisfied: boolean }[];
    }>();
    expect(deps.dependencies[0]?.satisfied).toBe(false);
    expect(deps.dependencies[0]?.reason).toBe("unresolved-project");
  });

  it("rejects an absolute cross-repo path", async () => {
    const result = await sandbox.run("dep", "add", "a", "/somewhere:task");
    expect(result.code).toBe(ExitCode.Usage);
  });
});

describe("tasks move and delete", () => {
  beforeEach(async () => {
    sandbox = await initializedSandbox();
    await sandbox.run("new", "auth", "Login");
  });

  it("relocates the file and updates frontmatter together", async () => {
    const result = await sandbox.run("move", "login", "billing", "--json");
    expect(result.json<{ phase: string }>().phase).toBe("billing");

    expect(await sandbox.exists(".tasks/auth/login.md")).toBe(false);
    expect(await sandbox.read(".tasks/billing/login.md")).toContain(
      "phase: billing",
    );
  });

  it("archives by default and excludes the task from queries", async () => {
    await sandbox.run("delete", "login");

    expect(await sandbox.exists(".tasks/.archive/login.md")).toBe(true);
    const list = await sandbox.run("list", "--all", "--json");
    expect(list.json<{ count: number }>().count).toBe(0);
  });

  it("refuses to delete a task with dependents", async () => {
    await sandbox.run("new", "auth", "Other");
    await sandbox.run("dep", "add", "other", "login");

    const result = await sandbox.run("delete", "login");
    expect(result.code).toBe(ExitCode.Conflict);
    expect(result.stderr).toContain("other");
  });

  it("purges permanently rather than archiving", async () => {
    await sandbox.run("delete", "login", "--purge");
    expect(await sandbox.exists(".tasks/.archive/login.md")).toBe(false);
    expect(await sandbox.exists(".tasks/auth/login.md")).toBe(false);
  });
});

describe("tasks validate", () => {
  beforeEach(async () => {
    sandbox = await initializedSandbox();
    await sandbox.run("new", "auth", "Login");
  });

  it("passes a clean tree", async () => {
    const result = await sandbox.run("validate", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<{ ok: boolean }>().ok).toBe(true);
  });

  it("detects phase drift from a hand-moved file", async () => {
    const contents = await sandbox.read(".tasks/auth/login.md");
    await sandbox.write(".tasks/billing/login.md", contents);

    const result = await sandbox.run("validate", "--json");
    const findings = result.json<{ findings: { kind: string }[] }>().findings;
    expect(findings.some((f) => f.kind === "phase-drift")).toBe(true);
  });

  it("repairs phase drift with --fix, letting the directory win", async () => {
    const contents = await sandbox.read(".tasks/auth/login.md");
    await sandbox.write(".tasks/billing/login.md", contents);
    await sandbox.run("delete", "login", "--purge");

    await sandbox.run("validate", "--fix");
    expect(await sandbox.read(".tasks/billing/login.md")).toContain(
      "phase: billing",
    );
  });

  it("reports discovered paths with native separators", async () => {
    // fast-glob yields posix separators on every platform. If they reach a
    // Task, `--fix` sees its destination as a different file and deletes the
    // one it just repaired.
    const result = await sandbox.run("show", "login", "--json");
    expect(result.json<{ path: string }>().path).toBe(
      path.join(sandbox.dir, ".tasks", "auth", "login.md"),
    );
  });

  it("detects an id/filename mismatch", async () => {
    const contents = await sandbox.read(".tasks/auth/login.md");
    await sandbox.write(".tasks/auth/renamed.md", contents);
    await sandbox.run("delete", "login", "--purge");

    const result = await sandbox.run("validate", "--json");
    const findings = result.json<{ findings: { kind: string }[] }>().findings;
    expect(findings.some((f) => f.kind === "filename-mismatch")).toBe(true);
  });

  it("detects a hand-edited cycle and exits nonzero", async () => {
    await sandbox.run("new", "auth", "Other");
    await sandbox.run("dep", "add", "login", "other");

    const other = await sandbox.read(".tasks/auth/other.md");
    await sandbox.write(
      ".tasks/auth/other.md",
      other.replace("depends_on: []", "depends_on: [login]"),
    );

    const result = await sandbox.run("validate", "--json");
    expect(result.code).toBe(ExitCode.Conflict);
    expect(
      result
        .json<{ findings: { kind: string }[] }>()
        .findings.some((f) => f.kind === "cycle"),
    ).toBe(true);
  });

  it("reports no index finding when _index.md does not exist", async () => {
    const result = await sandbox.run("validate", "--json");
    const findings = result.json<{ findings: { kind: string }[] }>().findings;
    expect(findings.some((f) => f.kind === "stale-index")).toBe(false);
  });

  it("passes when _index.md is up to date", async () => {
    await sandbox.run("reindex");

    const result = await sandbox.run("validate", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<{ ok: boolean }>().ok).toBe(true);
  });

  it("warns, without failing, when _index.md is stale", async () => {
    await sandbox.run("reindex");
    await sandbox.run("new", "auth", "Other");

    const result = await sandbox.run("validate", "--json");
    expect(result.code).toBe(ExitCode.Success);

    const payload = result.json<{
      ok: boolean;
      findings: { kind: string; severity: string }[];
    }>();
    expect(payload.ok).toBe(true);
    expect(payload.findings).toContainEqual(
      expect.objectContaining({ kind: "stale-index", severity: "warning" }),
    );
  });

  it("regenerates a stale _index.md with --fix", async () => {
    await sandbox.run("reindex");
    await sandbox.run("new", "auth", "Other");

    const result = await sandbox.run("validate", "--fix", "--json");
    const payload = result.json<{
      fixed: string[];
      findings: { kind: string }[];
    }>();
    expect(payload.fixed.some((f) => f.startsWith("stale-index"))).toBe(true);
    expect(payload.findings.some((f) => f.kind === "stale-index")).toBe(false);
    expect(await sandbox.read(".tasks/_index.md")).toContain("other");

    const after = await sandbox.run("validate", "--json");
    expect(
      after
        .json<{ findings: { kind: string }[] }>()
        .findings.some((f) => f.kind === "stale-index"),
    ).toBe(false);
  });

  it("warns about a dependency that can never be satisfied", async () => {
    await sandbox.run("new", "auth", "Other");
    await sandbox.run("dep", "add", "login", "other");
    await sandbox.run("delete", "other", "--force", "--purge");

    const result = await sandbox.run("validate", "--json");
    const findings = result.json<{
      findings: { kind: string; severity: string }[];
    }>().findings;
    expect(findings.some((f) => f.kind === "dependency-missing")).toBe(true);
  });
});

describe("agent-facing contract", () => {
  beforeEach(async () => {
    sandbox = await initializedSandbox();
  });

  it("emits errors as JSON on stderr when --json is used", async () => {
    const result = await sandbox.run("show", "ghost", "--json");
    expect(result.code).toBe(ExitCode.NotFound);
    expect(result.stdout).toBe("");

    const payload = JSON.parse(result.stderr) as { error: { code: string } };
    expect(payload.error.code).toBe("NOT_FOUND");
  });

  it("keeps stdout clean and parseable on success", async () => {
    await sandbox.run("new", "auth", "Login");
    const result = await sandbox.run("list", "--json");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("regenerates the index only on demand", async () => {
    await sandbox.run("new", "auth", "Login");
    expect(await sandbox.exists(".tasks/_index.md")).toBe(false);

    await sandbox.run("reindex");
    expect(await sandbox.read(".tasks/_index.md")).toContain("login");
  });
});

describe("tasks --version", () => {
  it("reports the published package.json version", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };

    expect(VERSION).toBe(pkg.version);
  });
});

describe("agent skill", () => {
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  it("installs alongside the scaffold so an agent finds the CLI unprompted", async () => {
    const result = await sandbox.run("init");
    expect(result.code).toBe(ExitCode.Success);

    expect(await sandbox.exists(".claude/skills/tasks/SKILL.md")).toBe(true);
    expect(
      await sandbox.exists(".claude/skills/tasks/reference/convention.md"),
    ).toBe(true);
  });

  it("is skipped by --no-skill", async () => {
    await sandbox.run("init", "--no-skill");
    expect(await sandbox.exists(".claude/skills/tasks")).toBe(false);
    expect(await sandbox.exists(".tasks/config.yml")).toBe(true);
  });

  it("reports what it installed under --json", async () => {
    const result = await sandbox.run("init", "--json");
    const payload = result.json<{
      skill: { installed: boolean; files: string[] };
    }>();

    expect(payload.skill.installed).toBe(true);
    expect(payload.skill.files.some((f) => f.endsWith("SKILL.md"))).toBe(true);
  });

  it("installs into a project that was initialized before the skill existed", async () => {
    await sandbox.run("init", "--no-skill");

    const result = await sandbox.run("skill", "install", "--json");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.json<{ installed: boolean }>().installed).toBe(true);
    expect(await sandbox.exists(".claude/skills/tasks/SKILL.md")).toBe(true);
  });

  it("leaves an existing install alone, since the user may have edited it", async () => {
    await sandbox.run("init");
    await sandbox.write(".claude/skills/tasks/SKILL.md", "edited by hand");

    const result = await sandbox.run("skill", "install", "--json");
    expect(
      result.json<{ installed: boolean; skipped?: string }>(),
    ).toMatchObject({
      installed: false,
      skipped: "exists",
    });
    expect(await sandbox.read(".claude/skills/tasks/SKILL.md")).toBe(
      "edited by hand",
    );
  });

  it("refreshes an install with --force, for use after a CLI upgrade", async () => {
    await sandbox.run("init");
    await sandbox.write(".claude/skills/tasks/SKILL.md", "stale");

    const result = await sandbox.run("skill", "install", "--force", "--json");
    expect(result.json<{ installed: boolean }>().installed).toBe(true);
    expect(await sandbox.read(".claude/skills/tasks/SKILL.md")).toContain(
      "name: tasks",
    );
  });

  it("ships a skill whose frontmatter an agent runtime can read", async () => {
    await sandbox.run("init");
    const content = await sandbox.read(".claude/skills/tasks/SKILL.md");

    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: tasks");
    expect(content).toContain("description:");
  });

  it("documents only commands the CLI actually has", async () => {
    await sandbox.run("init");
    const content = await sandbox.read(".claude/skills/tasks/SKILL.md");

    const registered = new Set(buildCli().commands.map((c) => c.name()));
    // Guards the drift that makes a stale skill worse than no skill: the CLI
    // renames a command, the skill keeps telling agents to run the old one.
    const documented = [...content.matchAll(/`tasks ([a-z-]+)/g)].map(
      (m) => m[1]!,
    );

    expect(documented.length).toBeGreaterThan(5);
    for (const name of new Set(documented)) {
      expect({ name, registered: registered.has(name) }).toEqual({
        name,
        registered: true,
      });
    }
  });
});
