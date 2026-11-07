import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  hasState,
  isAssigned,
  isClaimed,
  isOpenTask,
  isResolvedTask,
  makeTask,
  titleOf,
  toTaskJson,
} from "../src/core/task.js";
import { specFrontmatter } from "./fixtures.js";

const DIR = path.join(
  path.sep,
  "repo",
  ".tasks",
  "auth-rework",
  "token-schema",
);

function task(overrides: Parameters<typeof specFrontmatter>[0] = {}) {
  return makeTask({
    id: "auth-rework/token-schema",
    dir: DIR,
    archived: false,
    parent: "auth-rework",
    frontmatter: specFrontmatter({
      status: "PAUSED",
      depends_on: ["auth-rework/audit-claims"],
      assignee: "alice",
      created: "2026-09-21T09:14:00Z",
      updated: "2026-09-21T16:40:12Z",
      ...overrides,
    }),
    body: "# Design the token schema\n\n## Notes",
    workspace: { state: true },
  });
}

describe("titles", () => {
  it("takes the first level-one ATX heading", () => {
    expect(titleOf("intro\n\n# The title\n\n# Later", "name")).toBe(
      "The title",
    );
  });

  it("falls back to the name without a heading", () => {
    expect(titleOf("## Only a subheading\n\ntext", "token-schema")).toBe(
      "token-schema",
    );
    expect(titleOf("", "token-schema")).toBe("token-schema");
  });

  it("follows the ATX rules", () => {
    expect(titleOf("   # Indented up to three", "n")).toBe(
      "Indented up to three",
    );
    expect(titleOf("    # Four spaces is code", "n")).toBe("n");
    expect(titleOf("#Not a heading", "n")).toBe("n");
    expect(titleOf("# Closed #####", "n")).toBe("Closed");
    expect(titleOf("# C# in the title", "n")).toBe("C# in the title");
    expect(titleOf("#\n# Real", "n")).toBe("n");
  });

  it("skips headings inside fenced code", () => {
    const body = [
      "```sh",
      "# a shell comment",
      "```",
      "~~~",
      "# also code",
      "~~~",
      "# The real title",
    ].join("\n");
    expect(titleOf(body, "n")).toBe("The real title");
  });

  it("closes a fence only on a matching run", () => {
    const body = ["````", "```", "# still code", "````", "# Title"].join("\n");
    expect(titleOf(body, "n")).toBe("Title");
    expect(titleOf("```\n# never closed", "n")).toBe("n");
  });

  it("reads CRLF bodies", () => {
    expect(titleOf("# Windows\r\n\r\ntext\r\n", "n")).toBe("Windows");
  });
});

describe("the task model", () => {
  it("derives name, file and title", () => {
    const t = task();
    expect(t.name).toBe("token-schema");
    expect(t.file).toBe(path.join(DIR, "task.md"));
    expect(t.title).toBe("Design the token schema");
    expect(t.workspace).toEqual({
      state: true,
      design: false,
      plan: false,
      log: false,
    });
  });

  it("answers the common predicates", () => {
    const paused = task();
    expect(isOpenTask(paused)).toBe(true);
    expect(isResolvedTask(paused)).toBe(false);
    expect(isAssigned(paused)).toBe(true);
    expect(isClaimed(paused)).toBe(false);
    expect(hasState(paused)).toBe(true);
    expect(isClaimed(task({ status: "IN_PROGRESS" }))).toBe(true);
    expect(isResolvedTask(task({ status: "CANCELLED" }))).toBe(true);
  });
});

describe("the task object", () => {
  it("matches the CLI contract's shape and order for the local tree", () => {
    const json = toTaskJson(task());
    expect(json).toEqual({
      id: "auth-rework/token-schema",
      name: "token-schema",
      parent: "auth-rework",
      project: null,
      title: "Design the token schema",
      status: "PAUSED",
      priority: "normal",
      depends_on: ["auth-rework/audit-claims"],
      finishes_after: [],
      assignee: "alice",
      claimed_by: null,
      claimed_at: null,
      claimed_session: null,
      created: "2026-09-21T09:14:00Z",
      updated: "2026-09-21T16:40:12Z",
      path: DIR,
    });
    expect(Object.keys(json)).toEqual([
      "id",
      "name",
      "parent",
      "project",
      "title",
      "status",
      "priority",
      "depends_on",
      "finishes_after",
      "assignee",
      "claimed_by",
      "claimed_at",
      "claimed_session",
      "created",
      "updated",
      "path",
    ]);
  });

  it("qualifies the id and parent of a foreign task, not its references", () => {
    const json = toTaskJson(task(), "backend");
    expect(json.id).toBe("backend:auth-rework/token-schema");
    expect(json.parent).toBe("backend:auth-rework");
    expect(json.project).toBe("backend");
    expect(json.depends_on).toEqual(["auth-rework/audit-claims"]);
  });

  it("copies the lists so the JSON cannot alias the task", () => {
    const t = task();
    const json = toTaskJson(t);
    json.depends_on.push("x");
    expect(t.frontmatter.depends_on).toEqual(["auth-rework/audit-claims"]);
  });
});
