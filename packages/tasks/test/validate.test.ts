import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type {
  FindingJson,
  FindingKind,
  ValidationJson,
} from "../src/core/types.js";
import { formatIso } from "../src/core/time.js";
import { addProjectAlias, renderSpec } from "./fixtures.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

interface Validation {
  code: number;
  result: ValidationJson;
  stderr: string;
}

async function validate(...args: string[]): Promise<Validation> {
  const out = await sandbox.run("validate", "--json", ...args);
  return {
    code: out.code,
    result: JSON.parse(out.stdout) as ValidationJson,
    stderr: out.stderr,
  };
}

/** A finding without its message, for exact comparison. */
type Summary = Omit<FindingJson, "message">;

function summary(result: ValidationJson): Summary[] {
  return result.findings.map(({ severity, kind, task }) => ({
    severity,
    kind,
    task,
  }));
}

function ofKind(result: ValidationJson, kind: FindingKind): FindingJson[] {
  return result.findings.filter((finding) => finding.kind === kind);
}

function error(kind: FindingKind, task: string | null): Summary {
  return { severity: "error", kind, task };
}

function warning(kind: FindingKind, task: string | null): Summary {
  return { severity: "warning", kind, task };
}

/** Every file and directory under `root`, with the contents of each file. */
async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) {
        out.set(`${relative}/`, "");
        await walk(full);
      } else {
        out.set(relative, await fs.readFile(full, "utf8"));
      }
    }
  };
  await walk(root);
  return out;
}

const CONFLICTED_LOG = [
  "## 2026-01-01T00:00:00Z tester",
  "new: TODO",
  "",
  "<<<<<<< HEAD",
  "## 2026-01-02T00:00:00Z tester",
  "one side",
  "=======",
  "## 2026-01-02T00:00:00Z other",
  "the other side",
  ">>>>>>> branch",
  "",
].join("\n");

describe("validate", () => {
  it("passes a clean tree with ok, exit 0 and every manifest counted", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": { status: "DONE" },
        "epic/b": { status: "PAUSED", state: true },
        working: { status: "IN_PROGRESS" },
        later: { status: "BACKLOG" },
      },
      archived: { old: { status: "DONE" } },
    });

    const { code, result, stderr } = await validate();
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(result).toEqual({ ok: true, checked: 6, fixed: [], findings: [] });

    const human = await sandbox.run("validate");
    expect(human.code).toBe(0);
    expect(stripVTControlCharacters(human.stdout).trim()).toBe(
      "✓ no findings · 6 tasks checked",
    );
  });

  it("counts live and archived manifests, parsed or not", async () => {
    sandbox = await treeSandbox({
      tasks: { a: {}, b: {} },
      archived: { d: { status: "DONE" } },
    });
    await sandbox.write(".tasks/c/task.md", "no frontmatter\n");
    await sandbox.write(".tasks/task.md", "---\nstatus: TODO\n---\n");
    await sandbox.write(".tasks/.archive/e/task.md", "garbage\n");

    expect((await validate()).result.checked).toBe(6);
  });

  it("exits 0 with ok on warnings alone", async () => {
    sandbox = await treeSandbox({
      tasks: { p: { status: "PAUSED" }, t: { state: true } },
    });

    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(summary(result)).toEqual([
      warning("paused-without-state", "p"),
      warning("todo-with-state", "t"),
    ]);
  });

  it("exits 4 on an error with the findings still on stdout", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { claimed_by: "someone" }, p: { status: "PAUSED" } },
    });

    const out = await sandbox.run("validate", "--json");
    expect(out.code).toBe(4);
    expect(out.stderr).toBe("");
    const result = JSON.parse(out.stdout) as ValidationJson;
    expect(result.ok).toBe(false);
    expect(summary(result)).toEqual([
      error("claim-fields", "a"),
      warning("paused-without-state", "p"),
    ]);
  });

  it("lists errors before warnings in its human output", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "PAUSED" }, z: { claimed_by: "someone" } },
    });

    const out = await sandbox.run("validate");
    expect(out.code).toBe(4);
    const lines = stripVTControlCharacters(out.stdout).split("\n");
    expect(lines[0]).toMatch(
      /^✗ z: TODO, but claimed_by is someone.*\[claim-fields\]$/,
    );
    expect(lines[1]).toMatch(
      /^! a: is PAUSED without a state\.md.*\[paused-without-state\]$/,
    );
    expect(lines).toContain("1 error, 1 warning · 2 tasks checked");
  });

  it("writes nothing", async () => {
    sandbox = await treeSandbox({
      tasks: {
        a: { status: "PAUSED", extra: { reviewer: "someone" } },
        b: { depends_on: ["nowhere"], claimed_by: "someone" },
        w: { status: "IN_PROGRESS", claimed_session: "s1" },
      },
    });
    await sandbox.write(".tasks/index.md", "stale\n");
    await sandbox.write(".tasks/.locks/sessions/s1", "");
    await sandbox.age(".tasks/.locks/sessions/s1", 31);
    const before = await snapshotFiles(sandbox.dir);

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(await snapshotFiles(sandbox.dir)).toEqual(before);
  });
});

describe("errors", () => {
  it("reports a manifest that cannot be parsed, live, archived or at the root", async () => {
    sandbox = await treeSandbox({ tasks: { fine: {} } });
    await sandbox.write(".tasks/broken/task.md", "# no frontmatter\n");
    await sandbox.write(".tasks/.archive/gone/task.md", "garbage\n");
    await sandbox.write(".tasks/task.md", "---\nstatus: TODO\n---\n");

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(result.ok).toBe(false);
    expect(summary(result)).toEqual([
      error("malformed", null),
      error("malformed", "broken"),
      error("malformed", "gone"),
    ]);
    const [root, broken, gone] = result.findings;
    expect(root!.message).toContain(".tasks/task.md");
    expect(broken!.message).toContain(".tasks/broken/task.md");
    expect(broken!.message).toContain("does not begin with a `---` line");
    expect(gone!.message).toContain(".tasks/.archive/gone/task.md");
  });

  it("reports a status outside the lifecycle as unknown-status", async () => {
    sandbox = await treeSandbox({ tasks: { fine: {} } });
    await sandbox.write(
      ".tasks/odd/task.md",
      renderSpec("odd", {}).replace("status: TODO", "status: DOING"),
    );

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([error("unknown-status", "odd")]);
    expect(result.findings[0]!.message).toContain('"DOING"');
  });

  it("reports a priority outside the four levels as unknown-priority", async () => {
    sandbox = await treeSandbox({ tasks: { fine: {} } });
    await sandbox.write(
      ".tasks/odd/task.md",
      renderSpec("odd", {}).replace("priority: normal", "priority: whenever"),
    );

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([error("unknown-priority", "odd")]);
    expect(result.findings[0]!.message).toContain('"whenever"');
  });

  it("reports claim fields that disagree with the status", async () => {
    sandbox = await treeSandbox({
      tasks: {
        unclaimed: { status: "IN_PROGRESS", claimed_by: null },
        bare: { status: "IN_PROGRESS", claimed_by: null, claimed_at: null },
        todo: { claimed_by: "someone" },
        done: { status: "DONE", claimed_session: "s1" },
        fine: { status: "IN_PROGRESS" },
        free: { status: "IN_PROGRESS", claimed_session: null },
      },
    });

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([
      error("claim-fields", "bare"),
      error("claim-fields", "done"),
      error("claim-fields", "todo"),
      error("claim-fields", "unclaimed"),
    ]);
    const message = (task: string) =>
      result.findings.find((finding) => finding.task === task)!.message;
    expect(message("bare")).toContain("claimed_by and claimed_at are null");
    expect(message("unclaimed")).toContain("claimed_by is null");
    expect(message("todo")).toContain("claimed_by is someone");
    expect(message("done")).toContain("claimed_session is s1");
  });

  it("reports a reference that does not parse, and only as malformed-ref", async () => {
    sandbox = await treeSandbox({
      tasks: {
        a: { depends_on: ["Bad Ref"], finishes_after: ["/abs:x"] },
      },
    });

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([
      error("malformed-ref", "a"),
      error("malformed-ref", "a"),
    ]);
    expect(result.findings[0]!.message).toContain('depends_on entry "Bad Ref"');
    expect(result.findings[1]!.message).toContain(
      'finishes_after entry "/abs:x"',
    );
  });

  it("reports each cycle of the gate graph once", async () => {
    sandbox = await treeSandbox({
      tasks: {
        a: { depends_on: ["b"] },
        b: { depends_on: ["a"] },
        self: { finishes_after: ["self"] },
        fine: { depends_on: ["a"] },
      },
    });

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([
      error("cycle", "a"),
      error("cycle", "self"),
    ]);
    expect(result.findings[0]!.message).toContain("a → b → a");
    expect(result.findings[1]!.message).toContain("waits for itself");
  });

  it("reports a dependency on an ancestor under its own name, not as a cycle too", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: {},
        "epic/a": { depends_on: ["epic"] },
        "epic/a/x": { finishes_after: ["epic"] },
        // Through a group, the parent is still epic.
        "epic/g/b": { finishes_after: ["epic"] },
        // A dependency on a descendant runs down the same chain.
        "epic/a/x/y": { depends_on: ["epic/a"] },
        "epic/a/x/y/z": {},
        top: { depends_on: ["top/deep/leaf"] },
        "top/deep": {},
        "top/deep/leaf": { depends_on: ["top"] },
      },
    });

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([
      error("ancestor-dependency", "epic/a"),
      error("ancestor-dependency", "epic/a/x"),
      error("ancestor-dependency", "epic/a/x/y"),
      error("ancestor-dependency", "epic/g/b"),
      error("ancestor-dependency", "top/deep/leaf"),
    ]);
    expect(result.findings[0]!.message).toContain(
      "depends on its own ancestor epic",
    );
    expect(result.findings[1]!.message).toContain(
      "finishes after its own ancestor epic",
    );
  });

  it("keeps a cycle that the ancestor dependencies do not explain", async () => {
    sandbox = await treeSandbox({
      tasks: {
        p: {},
        "p/c": { depends_on: ["q"] },
        q: { depends_on: ["p"] },
        // The local tree, reached through a project path: a cycle, but not a
        // local reference to an ancestor.
        epic: {},
        "epic/b": { depends_on: ["../repo:epic"] },
        // A sibling's dependency closes a cycle that would outlive moving
        // `side/a` out of `side`: reported beside the ancestor dependency.
        side: {},
        "side/a": { depends_on: ["side"] },
        "side/b": { depends_on: ["side/a"] },
      },
    });

    const { result } = await validate();
    expect(summary(result)).toEqual([
      error("cycle", "epic"),
      error("cycle", "p"),
      error("cycle", "side"),
      error("ancestor-dependency", "side/a"),
    ]);
    expect(result.findings[0]!.message).toContain("epic → epic/b → epic");
    expect(result.findings[1]!.message).toContain("p → p/c → q → p");
    expect(result.findings[2]!.message).toContain(
      "side → side/b → side/a → side",
    );
  });

  it("reports a cycle through a listed project under qualified ids", async () => {
    sandbox = await treeSandbox({
      tasks: { loop: { depends_on: ["../backend:back"] } },
    });
    await sandbox.project("backend", "../backend", {
      tasks: { back: { depends_on: ["../repo:loop"] } },
    });

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([error("cycle", "loop")]);
    expect(result.findings[0]!.message).toContain("loop → backend:back → loop");
  });

  it("reports a resolved task with a live open or malformed descendant", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "DONE" },
        "epic/a": {},
        "epic/b": { status: "DONE" },
        "epic/b/c": { status: "CANCELLED" },
        closed: { status: "CANCELLED" },
        "closed/x": { status: "DONE" },
      },
    });
    await sandbox.write(".tasks/epic/m/task.md", "no frontmatter\n");

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(ofKind(result, "resolved-with-open-descendant")).toEqual([
      expect.objectContaining({ severity: "error", task: "epic" }),
    ]);
    const message = ofKind(result, "resolved-with-open-descendant")[0]!.message;
    expect(message).toContain("is DONE");
    expect(message).toContain("epic/a (TODO)");
    expect(message).toContain("epic/m (malformed task.md");
    expect(message).toContain("counts as open");
  });

  it("reports an open descendant of a BACKLOG task that is not BACKLOG", async () => {
    sandbox = await treeSandbox({
      tasks: {
        epic: { status: "BACKLOG" },
        "epic/a": {},
        "epic/b": { status: "BACKLOG" },
        "epic/b/c": { status: "PAUSED", state: true },
        "epic/d": { status: "CANCELLED" },
        "epic/e": { status: "BACKLOG", state: true },
      },
    });

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([
      error("backlog-invariant", "epic/a"),
      error("backlog-invariant", "epic/b/c"),
    ]);
    expect(result.findings[0]!.message).toContain(
      "is TODO under the BACKLOG task epic",
    );
    expect(result.findings[1]!.message).toContain(
      "is PAUSED under the BACKLOG task epic/b",
    );
    expect(result.findings[1]!.message).toContain("schedule epic");
  });

  it("reports a live task at the path of an archived one", async () => {
    sandbox = await treeSandbox({
      tasks: { x: {}, y: {} },
      archived: { x: { status: "DONE" }, z: { status: "DONE" } },
    });

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([error("archived-path-conflict", "x")]);
    expect(result.findings[0]!.message).toContain(".tasks/.archive/x");
  });

  it("reports the trace of an interrupted move both ways", async () => {
    sandbox = await treeSandbox({
      tasks: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {} },
      archived: { old: { status: "DONE" } },
    });
    // A copy of `a` whose source was never removed.
    await sandbox.write(".tasks/b/.moving", "a\n");
    // A copy that finished but kept its marker.
    await sandbox.write(".tasks/c/.moving", "gone\n");
    // A marker that names nothing a move could have come from.
    await sandbox.write(".tasks/d/.moving", "../../escape\n");
    // A restore out of the archive, interrupted.
    await sandbox.write(".tasks/e/.moving", ".archive/old\n");
    // A group copied while its source group still exists.
    await sandbox.write(".tasks/grp/.moving", "a\n");

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([
      error("duplicate-id", null),
      error("duplicate-id", "b"),
      error("duplicate-id", "c"),
      error("duplicate-id", "d"),
      error("duplicate-id", "e"),
    ]);
    const [group, twice, stale, bogus, restored] = result.findings;
    expect(group!.message).toContain("grp (.tasks/grp)");
    expect(twice!.message).toContain("same task twice");
    expect(twice!.message).toContain("a (.tasks/a)");
    expect(twice!.message).toContain("b (.tasks/b)");
    expect(stale!.message).toContain("gone");
    expect(stale!.message).toContain("no longer exists");
    expect(bogus!.message).toContain("does not name the source of a move");
    expect(restored!.message).toContain("archived old (.tasks/.archive/old)");
  });

  it("reports conflict markers in a log, live or archived", async () => {
    sandbox = await treeSandbox({
      tasks: {
        a: { log: CONFLICTED_LOG },
        b: { log: "## 2026-01-01T00:00:00Z tester\nnew: TODO\n" },
      },
      archived: { old: { status: "DONE", log: "<<<<<<< ours\n" } },
    });

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([
      error("log-conflict-markers", "a"),
      error("log-conflict-markers", "old"),
    ]);
    expect(result.findings[0]!.message).toContain("line 4");
    expect(result.findings[1]!.message).toContain(
      "archived at .tasks/.archive/old",
    );
  });
});

describe("warnings", () => {
  it("reports PAUSED without a state.md", async () => {
    sandbox = await treeSandbox({
      tasks: { p: { status: "PAUSED" }, q: { status: "PAUSED", state: true } },
    });

    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(summary(result)).toEqual([warning("paused-without-state", "p")]);
  });

  it("reports TODO with a state.md", async () => {
    sandbox = await treeSandbox({ tasks: { t: { state: true }, u: {} } });

    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(summary(result)).toEqual([warning("todo-with-state", "t")]);
  });

  it("reports references of open tasks that can never be satisfied", async () => {
    sandbox = await treeSandbox({
      tasks: {
        gone: { status: "CANCELLED" },
        waiting: { status: "IN_PROGRESS" },
        a: { depends_on: ["gone", "nowhere", "old", "waiting"] },
        // A cancelled target satisfies a finish gate.
        b: { finishes_after: ["gone"] },
        c: { status: "BACKLOG", finishes_after: ["nowhere"] },
        // A resolved task waits at no gate.
        closed: { status: "DONE", depends_on: ["nowhere", "gone"] },
      },
      archived: { old: { status: "DONE" } },
    });

    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(summary(result)).toEqual([
      warning("unsatisfiable-ref", "a"),
      warning("unsatisfiable-ref", "a"),
      warning("unsatisfiable-ref", "a"),
      warning("unsatisfiable-ref", "c"),
    ]);
    const messages = result.findings.map((finding) => finding.message);
    expect(messages[0]).toMatch(
      /^depends on gone, .*CANCELLED.*\(cancelled\)$/,
    );
    expect(messages[1]).toMatch(/^depends on nowhere, .*\(missing\)$/);
    expect(messages[2]).toMatch(/^depends on old, .*archived.*\(archived\)$/);
    expect(messages[3]).toMatch(/^finishes after nowhere, .*\(missing\)$/);
  });

  it("leaves a malformed target to the error on the target itself", async () => {
    sandbox = await treeSandbox({ tasks: { d: { depends_on: ["broken"] } } });
    await sandbox.write(".tasks/broken/task.md", "no frontmatter\n");

    const { code, result } = await validate();
    expect(code).toBe(4);
    expect(summary(result)).toEqual([error("malformed", "broken")]);
  });

  it("reports orphaned claims and sessions without a heartbeat, never a claim without a session", async () => {
    sandbox = await treeSandbox({
      tasks: {
        orphaned: { status: "IN_PROGRESS", claimed_session: "s1" },
        ended: { status: "IN_PROGRESS", claimed_session: "s2" },
        unknown: { status: "IN_PROGRESS", claimed_session: "s3" },
        live: { status: "IN_PROGRESS", claimed_session: "s4" },
        terminal: { status: "IN_PROGRESS" },
      },
    });
    await sandbox.write(".tasks/.locks/sessions/s1", "");
    await sandbox.age(".tasks/.locks/sessions/s1", 31);
    await sandbox.write(".tasks/.locks/sessions/s2", "ended\n");
    await sandbox.write(".tasks/.locks/sessions/s4", "");

    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(summary(result)).toEqual([
      warning("claim-liveness", "ended"),
      warning("claim-liveness", "orphaned"),
      warning("claim-liveness", "unknown"),
    ]);
    const [ended, orphaned, unknown] = result.findings;
    expect(ended!.message).toContain("session s2, which ended at");
    expect(orphaned!.message).toContain("session s1, last seen");
    expect(orphaned!.message).toContain("30-minute timeout");
    expect(orphaned!.message).toContain("orphaned");
    expect(unknown!.message).toContain("no heartbeat file");
  });

  it("reports every frontmatter key the convention does not define", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { extra: { reviewer: "someone", id: "a" } }, b: {} },
    });

    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(summary(result)).toEqual([
      warning("unknown-key", "a"),
      warning("unknown-key", "a"),
    ]);
    expect(result.findings[0]!.message).toContain('"reviewer"');
    expect(result.findings[1]!.message).toContain('"id"');
    expect(result.findings[1]!.message).toContain("v1");
  });

  it("warns about resolved subtrees older than archive_resolved_after_days", async () => {
    sandbox = await treeSandbox({
      tasks: {
        old: { status: "DONE" },
        "old/x": { status: "CANCELLED" },
        fresh: { status: "DONE", updated: formatIso(new Date()) },
        open: {},
      },
    });
    // No threshold configured: no finding.
    expect(summary((await validate()).result)).toEqual([]);

    await sandbox.write(
      ".tasks/config.yml",
      "version: 2\narchive_resolved_after_days: 30\n",
    );
    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(summary(result)).toEqual([warning("resolved-unarchived", null)]);
    expect(result.findings[0]!.message).toMatch(
      /^2 resolved tasks are older than 30 days and not archived \(old\)/,
    );
    expect(result.findings[0]!.message).toContain(
      "`tasks archive --resolved-before`",
    );
  });

  it("warns when two aliases lead to the same tree", async () => {
    sandbox = await treeSandbox({
      tasks: { a: {} },
      projects: { backend: "../backend" },
    });
    await sandbox.project("backend", "../backend", { tasks: { x: {} } });
    await addProjectAlias(sandbox.tasksDir, "api", "../backend");

    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(summary(result)).toEqual([warning("duplicate-project", null)]);
    expect(result.findings[0]!.message).toContain("backend and api");
  });

  it("reports every listed project that is unavailable, and the references into it", async () => {
    sandbox = await treeSandbox({
      tasks: {
        a: { depends_on: ["../legacy:a"] },
        b: { finishes_after: ["../ghost:x"] },
      },
    });
    await sandbox.project("legacy", "../legacy", {
      tasks: { a: { status: "DONE" } },
    });
    await sandbox.write("../legacy/.tasks/config.yml", "version: 1\n");
    await addProjectAlias(sandbox.tasksDir, "ghost", "../ghost");
    await sandbox.project("future", "../future", {});
    await sandbox.write("../future/.tasks/config.yml", "version: 3\n");
    await sandbox.write("../plain/README.md", "no tree here\n");
    await addProjectAlias(sandbox.tasksDir, "plain", "../plain");
    await sandbox.project("broken", "../broken", {});
    await sandbox.write(
      "../broken/.tasks/config.yml",
      "version: 2\nstatuses: [a]\n",
    );
    await sandbox.project("backend", "../backend", { tasks: { x: {} } });

    const { code, result } = await validate();
    expect(code).toBe(0);
    expect(summary(result)).toEqual([
      warning("unsatisfiable-ref", "a"),
      warning("unsatisfiable-ref", "b"),
      warning("project-unavailable", null),
      warning("project-unavailable", null),
      warning("project-unavailable", null),
      warning("project-unavailable", null),
      warning("project-unavailable", null),
    ]);
    const messages = result.findings.map((finding) => finding.message);
    expect(messages[0]).toMatch(
      /^depends on \.\.\/legacy:a, .*\(unsupported-version\)$/,
    );
    expect(messages[1]).toMatch(
      /^finishes after \.\.\/ghost:x, .*\(not-checked-out\)$/,
    );
    // In configuration order.
    expect(messages[2]).toContain(
      "project legacy (../legacy) is a .tasks v1 tree",
    );
    expect(messages[2]).toContain("`tasks migrate legacy`");
    expect(messages[3]).toContain(
      "project ghost (../ghost) is not checked out",
    );
    expect(messages[4]).toContain(
      "project future (../future) declares version 3",
    );
    expect(messages[5]).toContain(
      "project plain (../plain) does not lead to a .tasks tree",
    );
    expect(messages[6]).toContain("project broken (../broken) cannot be read");
    expect(messages[6]).toContain('unknown key "statuses"');
  });

  it("reports an index.md that is out of date, and none once regenerated", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.write(".tasks/index.md", "stale\n");

    const stale = await validate();
    expect(stale.code).toBe(0);
    expect(summary(stale.result)).toEqual([warning("index-stale", null)]);
    expect(stale.result.findings[0]!.message).toContain(".tasks/index.md");

    expect((await sandbox.run("reindex")).code).toBe(0);
    expect((await validate()).result.findings).toEqual([]);
  });
});

describe("archived manifests", () => {
  it("are held to the rules about the file, never to those about the live tree", async () => {
    sandbox = await treeSandbox({
      tasks: { live: {} },
      archived: {
        paused: { status: "PAUSED" },
        todo: { status: "TODO", state: true },
        waits: { status: "DONE", depends_on: ["nowhere"] },
        claimed: { status: "DONE", claimed_by: "someone" },
        keyed: { status: "DONE", extra: { reviewer: "someone" } },
        refs: { status: "DONE", depends_on: ["Bad Ref"] },
        epic: { status: "DONE" },
        "epic/open": {},
      },
    });

    const { result } = await validate();
    expect(summary(result)).toEqual([
      error("claim-fields", "claimed"),
      error("malformed-ref", "refs"),
      warning("unknown-key", "keyed"),
    ]);
    for (const finding of result.findings) {
      expect(finding.message).toMatch(/^archived at \.tasks\/\.archive\//);
    }
  });
});

describe("validate --fix", () => {
  it("regenerates a stale index.md, reports it and drops the warning", async () => {
    sandbox = await treeSandbox({
      tasks: { epic: {}, "epic/a": { status: "DONE" }, b: {} },
    });
    await sandbox.write(".tasks/index.md", "stale\n");
    const manifests = ["epic", "epic/a", "b"].map(
      (id) => `.tasks/${id}/task.md`,
    );
    const before = await Promise.all(
      manifests.map((file) => sandbox.read(file)),
    );

    const { code, result } = await validate("--fix");
    expect(code).toBe(0);
    expect(result).toEqual({
      ok: true,
      checked: 3,
      fixed: ["index.md"],
      findings: [],
    });
    const index = await sandbox.read(".tasks/index.md");
    expect(index).not.toContain("stale");
    expect(index).toContain("[epic/a](epic/a/)");
    expect(
      await Promise.all(manifests.map((file) => sandbox.read(file))),
    ).toEqual(before);

    // Already current: nothing to fix, nothing rewritten.
    const again = await validate("--fix");
    expect(again.result.fixed).toEqual([]);
    expect(await sandbox.read(".tasks/index.md")).toBe(index);
  });

  it("keeps every other finding, computed before the fix", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { status: "PAUSED" }, b: { claimed_by: "someone" } },
    });
    await sandbox.write(".tasks/index.md", "stale\n");

    const { code, result } = await validate("--fix");
    expect(code).toBe(4);
    expect(result.fixed).toEqual(["index.md"]);
    expect(summary(result)).toEqual([
      error("claim-fields", "b"),
      warning("paused-without-state", "a"),
    ]);
  });

  it("writes nothing when index.md does not exist", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const before = await snapshotFiles(sandbox.dir);

    const { code, result } = await validate("--fix");
    expect(code).toBe(0);
    expect(result).toEqual({ ok: true, checked: 1, fixed: [], findings: [] });
    expect(await snapshotFiles(sandbox.dir)).toEqual(before);
  });

  it("says what it fixed in its human output", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await sandbox.write(".tasks/index.md", "stale\n");

    const out = await sandbox.run("validate", "--fix");
    expect(out.code).toBe(0);
    const lines = stripVTControlCharacters(out.stdout).trim().split("\n");
    expect(lines).toEqual([
      "✓ fixed index.md",
      "✓ no findings · 1 task checked",
    ]);
  });
});

describe("reindex", () => {
  it("creates index.md, and a second run writes the same bytes", async () => {
    sandbox = await treeSandbox({ tasks: { a: {}, "a/b": {} } });

    const first = await sandbox.run("reindex");
    expect(first.code).toBe(0);
    expect(stripVTControlCharacters(first.stdout).trim()).toBe(
      "✓ wrote .tasks/index.md",
    );
    const index = await sandbox.read(".tasks/index.md");
    expect(index).toContain("[a/b](a/b/)");

    const second = await sandbox.run("reindex", "--json");
    expect(second.code).toBe(0);
    expect(second.json()).toEqual({
      path: path.join(sandbox.tasksDir, "index.md"),
      written: true,
    });
    expect(await sandbox.read(".tasks/index.md")).toBe(index);
  });

  it("names the file relative to the project root from anywhere inside it", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    await fs.mkdir(path.join(sandbox.dir, "src", "deep"), { recursive: true });

    const out = await sandbox.runWith({ cwd: "src/deep" }, "reindex");
    expect(out.code).toBe(0);
    expect(stripVTControlCharacters(out.stdout).trim()).toBe(
      "✓ wrote .tasks/index.md",
    );
    expect(await sandbox.exists(".tasks/index.md")).toBe(true);
  });

  it("renders an empty tree and leaves the manifests alone", async () => {
    sandbox = await treeSandbox({});
    expect((await sandbox.run("reindex")).code).toBe(0);
    expect(await sandbox.read(".tasks/index.md")).toContain("_No tasks yet._");

    await sandbox.tree({ tasks: { a: { extra: { reviewer: "someone" } } } });
    const manifest = await sandbox.read(".tasks/a/task.md");
    expect((await sandbox.run("reindex")).code).toBe(0);
    expect(await sandbox.read(".tasks/a/task.md")).toBe(manifest);
    expect(await sandbox.read(".tasks/index.md")).toContain("[a](a/)");
  });
});
