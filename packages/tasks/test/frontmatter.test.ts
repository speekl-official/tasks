import { describe, expect, it } from "vitest";

import type { Frontmatter } from "../src/core/frontmatter.js";
import { renderTaskFile, serializeFrontmatter, splitTaskFile } from "../src/core/frontmatter.js";

const base: Frontmatter = {
  id: "some-task",
  phase: "auth-rework",
  status: "PENDING",
  depends_on: [],
  created: "2026-08-21T09:14:00Z",
  updated: "2026-08-21T09:14:00Z",
  claimed_by: null,
  claimed_at: null,
};

describe("frontmatter", () => {
  it("serializes in canonical key order", () => {
    expect(serializeFrontmatter(base).split("\n").map((l) => l.split(":")[0])).toEqual([
      "id",
      "phase",
      "status",
      "depends_on",
      "created",
      "updated",
      "claimed_by",
      "claimed_at",
    ]);
  });

  it("quotes dates so they never re-parse as YAML timestamps", () => {
    const yaml = serializeFrontmatter(base);
    expect(yaml).toContain('created: "2026-08-21T09:14:00Z"');
    expect(yaml).toContain('updated: "2026-08-21T09:14:00Z"');
  });

  it("round-trips dates as strings without drift", () => {
    const rendered = renderTaskFile(base, "# Title");
    const parsed = splitTaskFile(rendered);

    expect(parsed.data.created).toBe("2026-08-21T09:14:00Z");
    expect(typeof parsed.data.created).toBe("string");

    // The critical regression: a second write must be byte-identical, otherwise
    // every command churns the file.
    const reRendered = renderTaskFile(
      { ...base, ...(parsed.data as unknown as Frontmatter) },
      parsed.body,
    );
    expect(reRendered).toBe(rendered);
  });

  it("does not coerce a bare YAML date to a Date object", () => {
    const parsed = splitTaskFile("---\ncreated: 2026-08-21\n---\nbody\n");
    expect(parsed.data.created).toBe("2026-08-21");
    expect(parsed.data.created).not.toBeInstanceOf(Date);
  });

  it("emits an empty dependency list inline", () => {
    expect(serializeFrontmatter(base)).toContain("depends_on: []");
  });

  it("emits dependency lists in flow style", () => {
    const yaml = serializeFrontmatter({ ...base, depends_on: ["a-task", "../other:b-task"] });
    expect(yaml).toContain('depends_on: [a-task, "../other:b-task"]');
  });

  it("quotes values that are not plain scalars", () => {
    const yaml = serializeFrontmatter({ ...base, claimed_by: "agent: session #3" });
    expect(yaml).toContain('claimed_by: "agent: session #3"');
    expect(splitTaskFile(`---\n${yaml}\n---\n`).data.claimed_by).toBe("agent: session #3");
  });

  it("preserves the body verbatim", () => {
    const body = "# Title\n\n## Notes\n\nSome *markdown* with `code`.";
    const parsed = splitTaskFile(renderTaskFile(base, body));
    expect(parsed.body.trim()).toBe(body);
  });
});
