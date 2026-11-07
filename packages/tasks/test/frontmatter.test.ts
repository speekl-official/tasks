import { describe, expect, it } from "vitest";

import type { TaskFileParse } from "../src/core/frontmatter.js";
import {
  MalformedManifestError,
  normalizeBody,
  parseTaskFile,
  renderTaskFile,
  safeParseTaskFile,
  serializeFrontmatter,
  yamlScalar,
} from "../src/core/frontmatter.js";
import type { Frontmatter } from "../src/core/types.js";
import { isTaskError } from "../src/errors.js";

const base: Frontmatter = {
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
};

const SPEC_EXAMPLE = `---
status: PAUSED
priority: normal
depends_on: [auth-rework/audit-claims]
finishes_after: []
assignee: alice
claimed_by: null
claimed_at: null
claimed_session: null
created: "2026-09-21T09:14:00Z"
updated: "2026-09-21T16:40:12Z"
---

# Design the token schema

## Description

## Acceptance criteria

- [ ]

## Notes
`;

const TIMES =
  'created: "2026-09-21T09:14:00Z"\nupdated: "2026-09-21T09:14:00Z"';

function file(frontmatter: string, body = "# Title\n"): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function expectOk(result: TaskFileParse) {
  if (!result.ok)
    throw new Error(`expected a manifest, got: ${result.message}`);
  return result;
}

function expectMalformed(source: string) {
  const result = safeParseTaskFile(source);
  if (result.ok) throw new Error("expected a malformed manifest");
  return result;
}

/** parse → render → parse → render, which must reach a fixed point at once. */
function roundTrip(source: string): { first: string; second: string } {
  const one = parseTaskFile(source);
  const first = renderTaskFile(one.frontmatter, one.extra, one.body);
  const two = parseTaskFile(first);
  const second = renderTaskFile(two.frontmatter, two.extra, two.body);
  return { first, second };
}

describe("canonical serialization", () => {
  it("renders the specification's example byte for byte", () => {
    const body =
      "# Design the token schema\n\n## Description\n\n## Acceptance criteria\n\n- [ ]\n\n## Notes\n";
    expect(renderTaskFile(base, [], body)).toBe(SPEC_EXAMPLE);
  });

  it("emits the ten fields in order, then unknown keys in read order", () => {
    const block = serializeFrontmatter(base, [
      ["zeta", 1],
      ["alpha", "x"],
    ]);
    expect(block.split("\n").map((line) => line.split(":")[0])).toEqual([
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
      "zeta",
      "alpha",
    ]);
  });

  it("double-quotes timestamps and writes null for absent values", () => {
    const block = serializeFrontmatter({
      ...base,
      status: "IN_PROGRESS",
      claimed_by: "agent-1",
      claimed_at: "2026-09-22T08:00:00Z",
      claimed_session: "7f3a",
    });
    expect(block).toContain('claimed_at: "2026-09-22T08:00:00Z"');
    expect(block).toContain('created: "2026-09-21T09:14:00Z"');
    expect(serializeFrontmatter(base)).toContain("claimed_at: null");
    expect(serializeFrontmatter(base)).toContain("claimed_session: null");
  });

  it("writes lists as flow sequences, [] when empty", () => {
    const block = serializeFrontmatter({
      ...base,
      depends_on: ["a/b", "c"],
      finishes_after: [],
    });
    expect(block).toContain("depends_on: [a/b, c]");
    expect(block).toContain("finishes_after: []");
  });

  it("quotes every scalar a YAML reader could take for something else", () => {
    const tricky = [
      "../backend:kernel-tests",
      "true",
      "null",
      "123",
      "2026-10-25",
      "1e5",
      "yes",
      "off",
    ];
    const block = serializeFrontmatter({ ...base, depends_on: tricky });
    expect(block).toContain(
      'depends_on: ["../backend:kernel-tests", "true", "null", "123", "2026-10-25", "1e5", "yes", "off"]',
    );
    const back = parseTaskFile(`---\n${block}\n---\n`);
    expect(back.frontmatter.depends_on).toEqual(tricky);
  });

  it("leaves unambiguous plain scalars unquoted", () => {
    for (const plain of ["alice", "alice@example.com", "ci+bot", "a/b-c"]) {
      expect(yamlScalar(plain)).toBe(plain);
    }
    for (const quoted of ["2026", "No", "a b", "a: b", "#x", "", "~", ".inf"]) {
      expect(yamlScalar(quoted)).toBe(JSON.stringify(quoted));
    }
  });

  it("escapes characters YAML refuses raw", () => {
    expect(yamlScalar("a\u007fb")).toBe('"a\\u007fb"');
    expect(yamlScalar("line\nbreak")).toBe('"line\\nbreak"');
  });

  it("never lets an unknown key shadow a defined field", () => {
    const block = serializeFrontmatter(base, [["status", "DONE"]]);
    expect(block.match(/^status:/gm)).toHaveLength(1);
    expect(block).toContain("status: PAUSED");
  });

  it("refuses, as an internal error, to write an invalid manifest", () => {
    try {
      renderTaskFile({ ...base, status: "PENDING" as never }, [], "# T");
      expect.unreachable("should have refused");
    } catch (err) {
      expect(isTaskError(err)).toBe(true);
      if (isTaskError(err)) expect(err.exitCode).toBe(1);
    }
  });
});

describe("round trips", () => {
  it("is byte-identical when unchanged state is written again", () => {
    const { first, second } = roundTrip(SPEC_EXAMPLE);
    expect(first).toBe(SPEC_EXAMPLE);
    expect(second).toBe(first);
  });

  it("canonicalizes a hand-edited manifest once, then stays put", () => {
    const source = `---
updated: 2026-09-21T16:40:12Z
status: TODO
owner_team: platform
created: 2026-09-21T09:14:00Z
meta:
  a: [1, 2]
  b:
    c: d
labels:
  - x
  - "y z"
due: "2026-10-01"
note: |
  line one
  line two
depends_on:
  - a/b
---
# Title
`;
    const { first, second } = roundTrip(source);
    expect(first).toBe(`---
status: TODO
priority: normal
depends_on: [a/b]
finishes_after: []
assignee: null
claimed_by: null
claimed_at: null
claimed_session: null
created: "2026-09-21T09:14:00Z"
updated: "2026-09-21T16:40:12Z"
owner_team: platform
meta: {a: [1, 2], b: {c: d}}
labels: [x, y z]
due: "2026-10-01"
note: "line one\\nline two\\n"
---

# Title
`);
    expect(second).toBe(first);
  });

  it("preserves unknown keys and their values exactly", () => {
    const parsed = parseTaskFile(
      file(
        `status: TODO\n${TIMES}\nrisk: {score: 3, tags: [a, "b c"], nested: {deep: [true, null, 1.5]}}`,
      ),
    );
    expect(parsed.extra).toEqual([
      [
        "risk",
        { score: 3, tags: ["a", "b c"], nested: { deep: [true, null, 1.5] } },
      ],
    ]);
    const again = parseTaskFile(
      renderTaskFile(parsed.frontmatter, parsed.extra, parsed.body),
    );
    expect(again.extra).toEqual(parsed.extra);
  });

  it("keeps the body verbatim apart from its outer whitespace", () => {
    const body =
      "# Title\n\n  indented\n\n\n## Notes\n\nSome *markdown*  \n`code`";
    const parsed = parseTaskFile(renderTaskFile(base, [], body));
    expect(parsed.body).toBe(body);
  });
});

describe("parsing", () => {
  it("applies the defaults of the optional fields", () => {
    const { frontmatter, extra } = expectOk(
      safeParseTaskFile(file(`status: BACKLOG\n${TIMES}`)),
    );
    expect(frontmatter).toEqual({
      status: "BACKLOG",
      priority: "normal",
      depends_on: [],
      finishes_after: [],
      assignee: null,
      claimed_by: null,
      claimed_at: null,
      claimed_session: null,
      created: "2026-09-21T09:14:00Z",
      updated: "2026-09-21T09:14:00Z",
    });
    expect(extra).toEqual([]);
  });

  it("keeps timestamp-shaped scalars as strings", () => {
    const { frontmatter, extra } = expectOk(
      safeParseTaskFile(
        file(
          "status: TODO\ncreated: 2026-09-21T09:14:00Z\nupdated: 2026-09-21T09:14:00Z\ndue: 2026-10-01",
        ),
      ),
    );
    expect(frontmatter.created).toBe("2026-09-21T09:14:00Z");
    expect(extra).toEqual([["due", "2026-10-01"]]);
  });

  it("does not check claim fields against the status", () => {
    const result = safeParseTaskFile(
      file(`status: IN_PROGRESS\nclaimed_by: null\n${TIMES}`),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts CRLF line endings and a byte-order mark", () => {
    const crlf = `\uFEFF---\r\nstatus: TODO\r\n${TIMES.replace("\n", "\r\n")}\r\n---\r\n\r\n# T\r\n`;
    const parsed = expectOk(safeParseTaskFile(crlf));
    expect(parsed.frontmatter.status).toBe("TODO");
    expect(parsed.body).toBe("# T");
  });

  it("accepts a closing delimiter at the end of the file", () => {
    const parsed = expectOk(
      safeParseTaskFile(`---\nstatus: TODO\n${TIMES}\n---`),
    );
    expect(parsed.body).toBe("");
  });

  it("throws a MalformedManifestError from the throwing form", () => {
    expect(() => parseTaskFile("# no frontmatter\n")).toThrow(
      MalformedManifestError,
    );
  });
});

describe("malformed manifests", () => {
  it.each([
    ["no frontmatter", "# Title\n", "does not begin with a `---` line"],
    [
      "a leading blank line",
      `\n---\nstatus: TODO\n${TIMES}\n---\n`,
      "does not begin",
    ],
    [
      "a padded opener",
      `--- \nstatus: TODO\n${TIMES}\n---\n`,
      "does not begin",
    ],
    [
      "a longer opener",
      `----\nstatus: TODO\n${TIMES}\n---\n`,
      "does not begin",
    ],
    [
      "no closing line",
      `---\nstatus: TODO\n${TIMES}\n`,
      "no closing `---` line",
    ],
    ["a padded closer", `---\nstatus: TODO\n${TIMES}\n--- \n`, "no closing"],
    ["a YAML end marker", `---\nstatus: TODO\n${TIMES}\n...\n`, "no closing"],
    ["a list", "---\n- a\n- b\n---\n", "not a YAML mapping"],
    ["a scalar", "---\njust text\n---\n", "not a YAML mapping"],
    ["an empty block", "---\n---\n", "not a YAML mapping"],
    ["broken YAML", "---\nstatus: [TODO\n---\n", "not valid YAML at line"],
    [
      "a duplicate key",
      `---\nstatus: TODO\nstatus: DONE\n${TIMES}\n---\n`,
      "duplicated mapping key",
    ],
  ])("reports %s", (_label, source, message) => {
    const result = expectMalformed(source);
    expect(result.message).toContain(message);
    expect(result.issues[0]?.field).toBeNull();
  });

  it("names the field and the value of an unknown status", () => {
    const result = expectMalformed(file(`status: PENDING\n${TIMES}`));
    expect(result.issues).toEqual([
      {
        field: "status",
        message:
          'status must be one of BACKLOG, TODO, IN_PROGRESS, PAUSED, DONE, CANCELLED, got "PENDING"',
      },
    ]);
  });

  it("reports a missing required field", () => {
    const result = expectMalformed(
      file('status: TODO\nupdated: "2026-09-21T09:14:00Z"'),
    );
    expect(result.issues).toEqual([
      { field: "created", message: "created is required" },
    ]);
  });

  it("reports an unknown priority under its field", () => {
    const result = expectMalformed(
      file(`status: TODO\npriority: critical\n${TIMES}`),
    );
    expect(result.issues.map((issue) => issue.field)).toEqual(["priority"]);
  });

  it.each([
    ["depends_on: a/b", "depends_on must be a list of references"],
    ["depends_on: null", "depends_on must be a list of references"],
    ['depends_on: [""]', "depends_on[0] must be a non-empty string"],
    [
      "finishes_after: [a, 12]",
      "finishes_after[1] must be a non-empty string, got 12",
    ],
    ['assignee: "two words"', "assignee must be null or an identity"],
    ["claimed_by: 42", "claimed_by must be null or an identity"],
    ["claimed_session: a/b", "claimed_session must be null or an identity"],
    [
      'claimed_at: "2026-09-21"',
      "claimed_at must be an ISO 8601 UTC timestamp",
    ],
  ])("refuses %s", (line, message) => {
    const result = expectMalformed(file(`status: TODO\n${TIMES}\n${line}`));
    expect(result.message).toContain(message);
  });

  it.each([
    "2026-09-21",
    "2026-09-21T09:14:00.000Z",
    "2026-09-21T09:14:00+00:00",
    "2026-09-21T09:14Z",
    "2026-02-30T00:00:00Z",
  ])("refuses the non-canonical timestamp %s", (value) => {
    const result = expectMalformed(
      file(
        `status: TODO\ncreated: "${value}"\nupdated: "2026-09-21T09:14:00Z"`,
      ),
    );
    expect(result.issues.map((issue) => issue.field)).toEqual(["created"]);
  });

  it("reports every failing field at once", () => {
    const result = expectMalformed(file("status: NOPE\npriority: 3"));
    expect(result.issues.map((issue) => issue.field)).toEqual([
      "status",
      "priority",
      "created",
      "updated",
    ]);
  });
});

describe("body normalization", () => {
  it("drops leading blank lines and trailing whitespace only", () => {
    expect(normalizeBody("\n \n\t\n# T\n\n  x  \n\n\n")).toBe("# T\n\n  x");
    expect(normalizeBody("    code\n")).toBe("    code");
  });

  it("writes an empty body as the frontmatter alone", () => {
    const text = renderTaskFile(base, [], "\n\n  \n");
    expect(text.endsWith('updated: "2026-09-21T16:40:12Z"\n---\n')).toBe(true);
    expect(parseTaskFile(text).body).toBe("");
  });
});
