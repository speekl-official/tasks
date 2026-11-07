import { describe, expect, it } from "vitest";

import { defaultConfig, parseConfigText } from "../src/core/config.js";
import { renderTaskFile, safeParseTaskFile } from "../src/core/frontmatter.js";
import { titleOf } from "../src/core/task.js";
import {
  configTemplate,
  defaultRoster,
  gitignoreTemplate,
  indexTemplate,
  readmeTemplate,
  taskBodyTemplate,
} from "../src/core/templates.js";
import { specFrontmatter } from "./fixtures.js";

describe("configTemplate", () => {
  it("parses as a v2 configuration with every default", () => {
    const detected = parseConfigText(configTemplate(), "config.yml");
    expect(detected).toEqual({ kind: "v2", config: defaultConfig() });
  });

  it("carries examples that are valid once uncommented", () => {
    const uncommented = configTemplate()
      .split("\n")
      .map((line) => line.replace(/^# (?=\s*[a-z_]+:)/, ""))
      .join("\n");
    const detected = parseConfigText(uncommented, "config.yml");
    expect(detected.kind).toBe("v2");
    if (detected.kind !== "v2") return;
    expect(detected.config.scope).toBe("auth-rework");
    expect(detected.config.sessionTimeoutMinutes).toBe(30);
    expect({ ...detected.config.actors }).toEqual({
      alice: "maintainer; approves plans and does releases",
      agent: "the coding agent",
    });
    expect({ ...detected.config.projects }).toEqual({ backend: "../backend" });
  });

  it("names the proposed roster, commented, and writes it live on request", () => {
    const proposed = configTemplate({ actors: defaultRoster("ada") });
    expect(proposed).toContain(
      "# actors:\n#   ada:\n#   agent: the coding agent\n",
    );
    expect(parseConfigText(proposed, "config.yml")).toEqual({
      kind: "v2",
      config: defaultConfig(),
    });

    const live = configTemplate({ actors: defaultRoster("ada"), live: true });
    expect(live).toContain("\nactors:\n  ada:\n  agent: the coding agent\n");
    const detected = parseConfigText(live, "config.yml");
    expect(detected.kind).toBe("v2");
    if (detected.kind !== "v2") return;
    expect(Object.entries(detected.config.actors)).toEqual([
      ["ada", null],
      ["agent", "the coding agent"],
    ]);
  });

  it("quotes a name YAML would otherwise retype", () => {
    const live = configTemplate({ actors: defaultRoster("007"), live: true });
    expect(live).toContain('\nactors:\n  "007":\n  agent: the coding agent\n');
    const detected = parseConfigText(live, "config.yml");
    expect(detected.kind).toBe("v2");
    if (detected.kind !== "v2") return;
    expect(Object.keys(detected.config.actors)).toEqual(["007", "agent"]);
  });

  it("proposes agent once when the agent itself runs init", () => {
    expect(Object.entries(defaultRoster("agent"))).toEqual([
      ["agent", "the coding agent"],
    ]);
  });

  it("points at the help and the README", () => {
    expect(configTemplate()).toContain("tasks --help");
    expect(configTemplate()).toContain(".tasks/README.md");
  });
});

describe("readmeTemplate", () => {
  const readme = readmeTemplate();

  it("describes the v2 layout with the workspace files", () => {
    for (const name of [
      "config.yml",
      "index.md",
      "task.md",
      "state.md",
      "design.md",
      "plan.md",
      "log.md",
      ".archive/",
      ".locks/",
    ]) {
      expect(readme).toContain(name);
    }
    expect(readme).not.toContain("_index.md");
  });

  it("gives an agent the loop from entry to exit", () => {
    for (const command of [
      "tasks mine",
      "tasks resume <task>",
      "tasks ready --json",
      "tasks claim --next --session <token>",
      "tasks state <task> < state.md",
      'tasks pause <task> -m "',
      'tasks done <task> -m "',
    ]) {
      expect(readme).toContain(command);
    }
  });

  it("states five rules, the exit codes and the machine-owned frontmatter", () => {
    const rules = readme
      .split("## Rules the CLI enforces")[1]!
      .split("\n## ")[0]!
      .split("\n")
      .filter((line) => line.startsWith("- **"));
    expect(rules).toHaveLength(5);
    expect(readme).toContain(
      "0 success, 1 internal, 2 usage, 3 not found, 4 conflict",
    );
    expect(readme).toContain("machine-owned");
  });
});

describe("gitignoreTemplate", () => {
  it("ignores the lock directory", () => {
    expect(gitignoreTemplate().split("\n")).toContain(".locks/");
  });
});

describe("taskBodyTemplate", () => {
  it("scaffolds the three sections under the title", () => {
    const body = taskBodyTemplate("Design the token schema");
    const headings = body.split("\n").filter((line) => line.startsWith("#"));
    expect(headings).toEqual([
      "# Design the token schema",
      "## Description",
      "## Acceptance criteria",
      "## Notes",
    ]);
    expect(body).toContain("- [ ]");
    expect(titleOf(body, "fallback")).toBe("Design the token schema");
  });

  it("survives a write unchanged", () => {
    const body = taskBodyTemplate("Ship it");
    const file = renderTaskFile(specFrontmatter({}), [], body);
    const parsed = safeParseTaskFile(file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(`${parsed.body}\n`).toBe(body);
    expect(renderTaskFile(parsed.frontmatter, parsed.extra, parsed.body)).toBe(
      file,
    );
  });
});

describe("indexTemplate", () => {
  it("frames the sections under a header that names reindex", () => {
    const text = indexTemplate("- [a](a/) — a · ready\n\n\n");
    expect(text.split("\n")[0]).toMatch(/^<!--.*`tasks reindex`.*-->$/);
    expect(text).toContain("# Task index\n\n- [a](a/) — a · ready\n");
    expect(text.endsWith("ready\n")).toBe(true);
  });
});
