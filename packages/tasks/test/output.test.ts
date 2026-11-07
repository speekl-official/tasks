import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type {
  DerivedTask,
  SnapshotTask,
  TreeSnapshot,
} from "../src/core/derive.js";
import { deriveTree } from "../src/core/derive.js";
import type { Tree } from "../src/core/tree.js";
import { loadTree } from "../src/core/tree.js";
import type {
  CollectionJson,
  LastEntryJson,
  ResolvedRef,
  StartGate,
  ValidationJson,
} from "../src/core/types.js";
import { TASKS_DIRNAME } from "../src/core/types.js";
import {
  renderCollectionFooter,
  renderDepList,
  renderLogEntries,
  renderMine,
  renderOverview,
  renderResume,
  renderSessionCheck,
  renderSessionEnd,
  renderShow,
  renderTransitionResult,
  renderTree,
  renderValidation,
} from "../src/output.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

/** Colour depends on the terminal the suite runs in; the words do not. */
function plain(text: string): string {
  return stripVTControlCharacters(text);
}

const ENTRY: LastEntryJson = {
  time: "2026-09-21T16:40:12Z",
  actor: "agent",
  via: null,
  session: "s0",
  text: "handoff alice: IN_PROGRESS → PAUSED\nSchema drafted; decide the rotation.",
};

function ref(stored: string, fields: Partial<ResolvedRef> = {}): ResolvedRef {
  return {
    ref: stored,
    project: null,
    id: stored,
    satisfied: false,
    reason: "not-done",
    status: "TODO",
    ...fields,
  };
}

const TOKENS = ref("../backend:api/tokens", {
  project: "backend",
  id: "api/tokens",
});

function snapshotOf(tree: Tree, project: string | null): TreeSnapshot {
  const starts: Record<string, StartGate> = {
    deploy: { satisfied: false, refs: [ref("auth-rework")] },
  };
  return {
    tree,
    project,
    tasks: tree.tasks.map(
      (task): SnapshotTask => ({
        task,
        project,
        start: starts[task.id] ?? { satisfied: true, refs: [] },
        finish:
          task.id === "auth-rework"
            ? { satisfied: false, open_children: [], refs: [TOKENS] }
            : { satisfied: true, open_children: [], refs: [] },
        liveness:
          task.frontmatter.status === "IN_PROGRESS"
            ? { liveness: "live", last_seen: "2026-09-21T16:00:00Z" }
            : null,
        lastEntry: task.id === "auth-rework/token-schema" ? ENTRY : null,
      }),
    ),
  };
}

/** A local tree and a listed project, derived as one aggregation. */
async function fixture(): Promise<{
  local: Map<string, DerivedTask>;
  foreign: Map<string, DerivedTask>;
}> {
  sandbox = await treeSandbox({
    tasks: {
      "auth-rework": {
        priority: "high",
        title: "Rework authentication",
        finishes_after: ["../backend:api/tokens"],
      },
      "auth-rework/audit": { status: "DONE", title: "Audit the claims" },
      "auth-rework/token-schema": {
        status: "PAUSED",
        state: true,
        assignee: "alice",
        title: "Design the token schema",
        body: "# Design the token schema\n\n## Notes\n\nKeep the legacy route.\n",
      },
      "auth-rework/phase/impl": {
        status: "IN_PROGRESS",
        claimed_session: "s1",
        title: "Implement refresh",
      },
      deploy: {
        assignee: "alice",
        title: "Deploy to production",
        depends_on: ["auth-rework"],
      },
    },
  });
  const root = await sandbox.project("backend", "../backend", {
    tasks: {
      "api/tokens": { title: "Token endpoint" },
      "api/tokens/tests": { status: "PAUSED", state: true, title: "Tests" },
    },
  });
  const local = deriveTree(
    snapshotOf(await sandbox.loadTree(), null),
    "tester",
  );
  const foreign = deriveTree(
    snapshotOf(
      await loadTree({ root, tasksDir: path.join(root, TASKS_DIRNAME) }),
      "backend",
    ),
    "tester",
  );
  return { local, foreign };
}

function get(map: Map<string, DerivedTask>, id: string): DerivedTask {
  const d = map.get(id);
  if (d === undefined) throw new Error(`no derived task ${id}`);
  return d;
}

/* ------------------------------------------------------------------------ */
/* Overviews                                                                */
/* ------------------------------------------------------------------------ */

describe("renderOverview", () => {
  it("shows id, situation, labels and title, never the stored status", async () => {
    const { local, foreign } = await fixture();
    const text = plain(
      renderOverview([...local.values(), ...foreign.values()], {
        project: true,
      }),
    );
    for (const words of [
      "ID",
      "SITUATION",
      "LABELS",
      "TITLE",
      "open 1/3",
      "active · high",
      "waiting for alice",
      "high (inherited) · live",
      "assigned alice",
      "blocked by auth-rework",
      "backend:api/tokens/tests",
      "Design the token schema",
    ]) {
      expect(text).toContain(words);
    }
    for (const status of ["BACKLOG", "TODO", "IN_PROGRESS", "PAUSED"]) {
      expect(text).not.toContain(status);
    }
  });

  it("leaves ids bare outside an aggregation, and names an empty list", async () => {
    const { foreign } = await fixture();
    const text = plain(renderOverview([...foreign.values()]));
    expect(text).toContain("api/tokens/tests");
    expect(text).not.toContain("backend:");
    expect(plain(renderOverview([]))).toBe("No tasks.");
    expect(plain(renderOverview([], { empty: "Nothing ready." }))).toBe(
      "Nothing ready.",
    );
  });
});

describe("renderTree", () => {
  it("nests by containment with names below the parent", async () => {
    const { local, foreign } = await fixture();
    const lines = plain(
      renderTree([...foreign.values(), ...local.values()], { project: true }),
    ).split("\n");
    const at = (start: string) => {
      const index = lines.findIndex((line) => line.startsWith(start));
      expect(index, start).toBeGreaterThan(-1);
      return index;
    };
    const epic = at("auth-rework ");
    const after = at("  ↳ after backend:api/tokens (not-done)");
    const audit = at("  audit ");
    const impl = at("  phase/impl ");
    const schema = at("  token-schema ");
    const deploy = at("deploy ");
    const tokens = at("backend:api/tokens ");
    const tests = at("  tests ");
    // Local first, then projects; a task's joins right under it.
    expect([epic, after, audit, impl, schema, deploy, tokens, tests]).toEqual(
      [...[epic, after, audit, impl, schema, deploy, tokens, tests]].sort(
        (a, b) => a - b,
      ),
    );
    expect(lines[schema]).toContain("waiting for alice");
    expect(lines[impl]).toContain("working");
  });

  it("nests under the nearest ancestor that is shown", async () => {
    const { local } = await fixture();
    const text = plain(
      renderTree([get(local, "auth-rework/phase/impl"), get(local, "deploy")]),
    );
    expect(text).toContain("\nauth-rework/phase/impl ");
    expect(plain(renderTree([]))).toBe("No tasks.");
  });
});

describe("renderMine", () => {
  it("puts each task's last entry, in full, beneath it", async () => {
    const { local } = await fixture();
    const lines = plain(
      renderMine([
        get(local, "auth-rework/token-schema"),
        get(local, "auth-rework/phase/impl"),
      ]),
    ).split("\n");
    const row = lines.findIndex((line) =>
      line.startsWith("auth-rework/token-schema"),
    );
    expect(lines.slice(row + 1, row + 4)).toEqual([
      "    2026-09-21T16:40:12Z agent s:s0",
      "    handoff alice: IN_PROGRESS → PAUSED",
      "    Schema drafted; decide the rotation.",
    ]);
    expect(lines[row + 4]).toMatch(/^auth-rework\/phase\/impl\s+working/);
    expect(plain(renderMine([]))).toContain("Nothing");
  });
});

/* ------------------------------------------------------------------------ */
/* One task                                                                 */
/* ------------------------------------------------------------------------ */

describe("renderShow", () => {
  it("prints the fields, the situation, the blockers and the body", async () => {
    const { local } = await fixture();
    const text = plain(
      renderShow(get(local, "deploy"), {
        body: "# Deploy to production\n\nRun the release script.\n",
        workspace: ["state.md", "log.md"],
        referenced_by: ["auth-rework"],
      }),
    );
    for (const words of [
      "Deploy to production  deploy",
      "status",
      "TODO",
      "assigned alice · blocked by auth-rework",
      "Blocked by",
      "not-done (TODO)",
      "referenced by",
      "state.md, log.md",
      "Run the release script.",
    ]) {
      expect(text).toContain(words);
    }
  });

  it("shows the claim with its session and liveness", async () => {
    const { local } = await fixture();
    const text = plain(
      renderShow(get(local, "auth-rework/phase/impl"), {
        body: "",
        workspace: [],
        referenced_by: [],
      }),
    );
    expect(text).toContain(
      "tester since 2026-01-01T00:00:00Z · session s1 · live",
    );
    expect(text).toContain("normal (effective high)");
  });
});

describe("renderResume", () => {
  it("prints ancestors, children, workspace, state.md and the last entry", async () => {
    const { local } = await fixture();
    const text = plain(
      renderResume(get(local, "auth-rework/token-schema"), {
        ancestors: [
          {
            id: "auth-rework",
            title: "Rework authentication",
            status: "TODO",
            workspace: ["design.md", "plan.md"],
          },
        ],
        children: [get(local, "auth-rework/audit")],
        workspace: ["state.md", "design.md"],
        state: "## Done\n\n- drafted\n\n## Next\n\n- decide rotation\n",
        referenced_by: ["deploy"],
      }),
    );
    const order = [
      "Design the token schema  auth-rework/token-schema",
      "Ancestors",
      "auth-rework  TODO  Rework authentication  design.md, plan.md",
      "Children",
      "auth-rework/audit  DONE  done  Audit the claims",
      "Workspace",
      "state.md, design.md",
      "state.md\n## Done\n\n- drafted",
      "Last entry",
      "handoff alice: IN_PROGRESS → PAUSED",
    ].map((words) => text.indexOf(words));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("says when there is no state.md yet", async () => {
    const { local } = await fixture();
    const text = plain(
      renderResume(get(local, "deploy"), {
        ancestors: [],
        children: [],
        workspace: [],
        state: null,
        referenced_by: [],
      }),
    );
    expect(text).toContain("No state.md yet");
    expect(text).not.toContain("Ancestors");
    expect(text).not.toContain("Last entry");
  });
});

/* ------------------------------------------------------------------------ */
/* Other results                                                            */
/* ------------------------------------------------------------------------ */

describe("renderLogEntries", () => {
  it("prints each entry under its heading", () => {
    const text = plain(
      renderLogEntries([
        { task: "auth/x", ...ENTRY },
        {
          task: "backend:api/y",
          time: "2026-09-22T08:02:41Z",
          actor: "alice",
          via: "agent",
          session: null,
          text: "done: PAUSED → DONE\nAPPLY.",
        },
      ]),
    );
    expect(text).toContain("2026-09-21T16:40:12Z agent s:s0  auth/x");
    expect(text).toContain(
      "2026-09-22T08:02:41Z alice via agent  backend:api/y",
    );
    expect(text).toContain("  done: PAUSED → DONE\n  APPLY.");
    expect(plain(renderLogEntries([]))).toBe("No log entries.");
  });
});

describe("renderValidation", () => {
  const findings: ValidationJson["findings"] = [
    {
      severity: "warning",
      kind: "index-stale",
      task: null,
      message: "index.md is out of date",
    },
    {
      severity: "error",
      kind: "cycle",
      task: "a/b",
      message: "a/b → c → a/b",
    },
  ];

  it("lists errors before warnings, with a count", () => {
    const text = plain(
      renderValidation({ ok: false, checked: 41, fixed: [], findings }),
    );
    const error = text.indexOf("✗ a/b: a/b → c → a/b [cycle]");
    const warning = text.indexOf("! index.md is out of date [index-stale]");
    expect(error).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(error);
    expect(text).toContain("1 error, 1 warning · 41 tasks checked");
  });

  it("says so when clean, and names what it fixed", () => {
    const text = plain(
      renderValidation({
        ok: true,
        checked: 1,
        fixed: ["index.md"],
        findings: [],
      }),
    );
    expect(text).toContain("✓ fixed index.md");
    expect(text).toContain("✓ no findings · 1 task checked");
  });
});

describe("session output", () => {
  it("reports the session check", () => {
    const failed = plain(
      renderSessionCheck({
        ok: false,
        session: "s1",
        violations: [{ id: "auth/x", kind: "missing-state" }],
        warnings: [
          {
            id: "auth/y",
            kind: "state-older-than-log",
            message: "state.md is older than the last log entry",
          },
        ],
      }),
    );
    expect(failed).toContain("✗ auth/x: claimed without a state.md");
    expect(failed).toContain("! auth/y: state.md is older");
    expect(failed).toContain("session s1: 1 claimed task without a state.md");

    const passed = plain(
      renderSessionCheck({
        ok: true,
        session: null,
        violations: [],
        warnings: [],
      }),
    );
    expect(passed).toContain("✓ claims without a session: every claimed task");
  });

  it("reports the session end and the claims it orphaned", () => {
    expect(
      plain(
        renderSessionEnd({
          session: "s1",
          ended: "2026-09-22T08:02:41Z",
          claims: ["auth/x", "auth/y"],
        }),
      ),
    ).toBe(
      "✓ session s1 ended at 2026-09-22T08:02:41Z\n  orphaned claims: auth/x, auth/y",
    );
    expect(
      plain(
        renderSessionEnd({
          session: "s1",
          ended: "2026-09-22T08:02:41Z",
          claims: [],
        }),
      ),
    ).toContain("it held no claims");
  });
});

describe("renderDepList", () => {
  it("tells satisfied references from the others", () => {
    const text = plain(
      renderDepList([
        ref("auth/x", { satisfied: true, reason: null, status: "DONE" }),
        ref("auth/y", { reason: "cancelled", status: "CANCELLED" }),
        ref("gone", { reason: "missing", status: null }),
      ]),
    );
    for (const words of [
      "REFERENCE",
      "SATISFIED",
      "DETAIL",
      "auth/x",
      "yes",
      "DONE",
      "cancelled (CANCELLED)",
      "missing",
    ]) {
      expect(text).toContain(words);
    }
    expect(text.match(/\bno\b/g)).toHaveLength(2);
    expect(plain(renderDepList([]))).toBe("No references.");
  });
});

describe("renderCollectionFooter", () => {
  it("counts the tasks and flags malformed manifests", () => {
    const collection: CollectionJson<unknown> = {
      scope: "auth",
      projects: ["backend", "cli"],
      count: 3,
      tasks: [],
      malformed: [
        { path: "/abs/.tasks/bad/task.md", message: "no frontmatter" },
      ],
      unavailable: [],
    };
    expect(plain(renderCollectionFooter(collection))).toBe(
      "3 tasks · scope auth · projects backend, cli\n! malformed /abs/.tasks/bad/task.md: no frontmatter",
    );
    expect(
      plain(
        renderCollectionFooter({
          scope: null,
          projects: [],
          count: 1,
          tasks: [],
          malformed: [],
          unavailable: [],
        }),
      ),
    ).toBe("1 task");
  });
});

describe("renderTransitionResult", () => {
  it("prints one line for the transition and what else it did", async () => {
    const { local } = await fixture();
    const { json } = get(local, "auth-rework/token-schema");
    expect(
      plain(
        renderTransitionResult(json, {
          command: "cancel",
          from: "PAUSED",
          to: "CANCELLED",
          cascaded: ["auth-rework/token-schema/part"],
          dependents: ["deploy", "backend:api/tokens"],
          holds: 3,
        }),
      ),
    ).toBe(
      [
        "✓ cancel auth-rework/token-schema: PAUSED → CANCELLED",
        "  cascaded to auth-rework/token-schema/part",
        "  ! stranded dependents: deploy, backend:api/tokens",
        "  now holds 3 tasks",
      ].join("\n"),
    );
    expect(
      plain(
        renderTransitionResult(json, {
          command: "handoff",
          from: "IN_PROGRESS",
          to: "PAUSED",
          holds: 1,
        }),
      ),
    ).toBe(
      "✓ handoff auth-rework/token-schema to alice: IN_PROGRESS → PAUSED\n  now holds 1 task",
    );
    expect(
      plain(renderTransitionResult(json, { command: "assign", holds: 0 })),
    ).toBe("✓ assign auth-rework/token-schema: alice");
    expect(plain(renderTransitionResult(json, { command: "priority" }))).toBe(
      "✓ priority auth-rework/token-schema: normal",
    );
    expect(plain(renderTransitionResult(json, { command: "unassign" }))).toBe(
      "✓ unassign auth-rework/token-schema",
    );
  });
});
