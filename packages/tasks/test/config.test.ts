import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/core/config.js";
import {
  defaultConfig,
  detectTreeVersion,
  loadConfig,
  parseConfigText,
  projectPathOf,
  renderConfig,
} from "../src/core/config.js";
import type { TaskError } from "../src/errors.js";
import { isTaskError } from "../src/errors.js";
import type { Sandbox } from "./helpers.js";
import { makeSandbox } from "./helpers.js";

const FILE = "/repo/.tasks/config.yml";

function v2(source: string): Config {
  const detected = parseConfigText(source, FILE);
  if (detected.kind !== "v2")
    throw new Error(`expected v2, got ${detected.kind}`);
  return detected.config;
}

function usage(fn: () => unknown): TaskError {
  try {
    fn();
  } catch (err) {
    if (isTaskError(err)) {
      expect(err.exitCode).toBe(2);
      return err;
    }
    throw err;
  }
  throw new Error("expected a usage error");
}

async function usageAsync(promise: Promise<unknown>): Promise<TaskError> {
  try {
    await promise;
  } catch (err) {
    if (isTaskError(err)) {
      expect(err.exitCode).toBe(2);
      return err;
    }
    throw err;
  }
  throw new Error("expected a usage error");
}

describe("parsing a v2 config.yml", () => {
  it("fills every default from `version: 2` alone", () => {
    expect(v2("version: 2\n")).toEqual({
      version: 2,
      scope: null,
      sessionTimeoutMinutes: 30,
      archiveResolvedAfterDays: null,
      actors: {},
      projects: {},
    });
  });

  it("reads the actors with their descriptions, a bare name as none", () => {
    const config = v2(`version: 2
actors:
  alice: maintainer; approves plans and does releases
  bob:
  agent: ""
  carol.d@example.com: "  reviews: everything  "
`);
    expect(Object.entries(config.actors)).toEqual([
      ["alice", "maintainer; approves plans and does releases"],
      ["bob", null],
      ["agent", null],
      ["carol.d@example.com", "reviews: everything"],
    ]);
    expect(Object.hasOwn(config.actors, "constructor")).toBe(false);
  });

  it("refuses a name YAML would read as something else, and takes it quoted", () => {
    for (const raw of ["007", "True", "1.50", "1e3"]) {
      expect(
        usage(() => v2(`version: 2\nactors:\n  ${raw}: someone\n`)).message,
      ).toContain(`actor "${raw}" is read by YAML as`);
    }
    const config = v2('version: 2\nactors:\n  "007": someone\n  "true":\n');
    expect(Object.entries(config.actors)).toEqual([
      ["007", "someone"],
      ["true", null],
    ]);
    expect(renderConfig(config)).toBe(
      'version: 2\nactors:\n  "007": someone\n  "true":\n',
    );
  });

  it("refuses actors that are not a mapping of actor to a line", () => {
    expect(
      usage(() => v2("version: 2\nactors:\n  - alice\n  - bob\n")).message,
    ).toContain("actors must be a mapping of actor to a one-line description");
    expect(
      usage(() => v2("version: 2\nactors:\n  two words: here\n")).message,
    ).toContain('actor "two words" must match');
    expect(
      usage(() => v2("version: 2\nactors:\n  alice: 42\n")).message,
    ).toContain('actor "alice" must carry a one-line description or nothing');
    expect(
      usage(() => v2("version: 2\nactors:\n  alice: |\n    one\n    two\n"))
        .message,
    ).toContain("got several lines");
    expect(usage(() => v2("version: 2\nactors: alice\n")).details).toEqual({
      file: FILE,
      key: "actors",
    });
  });

  it("reads every key", () => {
    const config = v2(`version: 2
scope: auth-rework/tokens
session_timeout_minutes: 45
projects:
  backend: ../backend
  cli: ../arkveil-cli
`);
    expect(config.scope).toBe("auth-rework/tokens");
    expect(config.sessionTimeoutMinutes).toBe(45);
    expect(Object.entries(config.projects)).toEqual([
      ["backend", "../backend"],
      ["cli", "../arkveil-cli"],
    ]);
  });

  it("reads archive_resolved_after_days, absent by default, and writes it back", () => {
    expect(
      v2("version: 2\narchive_resolved_after_days: 45\n")
        .archiveResolvedAfterDays,
    ).toBe(45);
    expect(v2("version: 2\n").archiveResolvedAfterDays).toBeNull();
    expect(
      renderConfig({ ...defaultConfig(), archiveResolvedAfterDays: 45 }),
    ).toBe("version: 2\narchive_resolved_after_days: 45\n");
  });

  it("reads an optional key set to null as absent", () => {
    const config = v2(
      "version: 2\nscope:\nsession_timeout_minutes:\nprojects:\n  # backend: ../backend\n",
    );
    expect(config).toEqual(defaultConfig());
  });

  it("keeps the alias map free of inherited names", () => {
    const config = v2("version: 2\nprojects:\n  backend: ../backend\n");
    expect(projectPathOf(config, "backend")).toBe("../backend");
    expect(projectPathOf(config, "constructor")).toBeUndefined();
    expect(projectPathOf(config, "toString")).toBeUndefined();
  });

  it("does not coerce a date-shaped scope", () => {
    expect(v2("version: 2\nscope: 2026-10-01\n").scope).toBe("2026-10-01");
  });

  it("refuses an unknown key, naming the key and the file", () => {
    const err = usage(() =>
      parseConfigText("version: 2\nstatuses: [A, B]\n", FILE),
    );
    expect(err.message).toContain('unknown key "statuses"');
    expect(err.message).toContain(FILE);
    expect(err.details).toEqual({ file: FILE, key: "statuses" });
  });

  it("points a v1 key at its v2 replacement", () => {
    const err = usage(() =>
      parseConfigText("version: 2\nactive_phase: x\n", FILE),
    );
    expect(err.message).toContain("scope");
  });

  it.each([
    ["scope: Auth", "scope"],
    ["scope: a/", "scope"],
    ["scope: [a]", "scope"],
    ["session_timeout_minutes: 0", "session_timeout_minutes"],
    ["session_timeout_minutes: -5", "session_timeout_minutes"],
    ["session_timeout_minutes: 1.5", "session_timeout_minutes"],
    ['session_timeout_minutes: "30"', "session_timeout_minutes"],
    ["archive_resolved_after_days: 0", "archive_resolved_after_days"],
    ["archive_resolved_after_days: 2.5", "archive_resolved_after_days"],
    ['archive_resolved_after_days: "30"', "archive_resolved_after_days"],
    ["projects: [a, b]", "projects"],
    ["projects:\n  Backend: ../backend", "projects"],
    ["projects:\n  my_repo: ../x", "projects"],
    ["projects:\n  backend: ''", "projects"],
    ["projects:\n  backend: 3", "projects"],
    ["projects:\n  backend: /abs/backend", "projects"],
    ["projects:\n  backend: C:\\\\repos\\\\backend", "projects"],
    ["projects:\n  backend: 'C:/repos/backend'", "projects"],
    ["projects:\n  backend: '\\\\server\\share'", "projects"],
  ])("refuses %j", (line, key) => {
    const err = usage(() => parseConfigText(`version: 2\n${line}\n`, FILE));
    expect(err.details).toMatchObject({ file: FILE, key });
    expect(err.message.startsWith(FILE)).toBe(true);
  });

  it("refuses invalid YAML, naming the file", () => {
    const err = usage(() => parseConfigText("version: [2\n", FILE));
    expect(err.message).toContain(FILE);
    expect(err.message).toContain("invalid YAML");
  });

  it.each(["- version: 2\n", "just a string\n", "42\n"])(
    "refuses a document that is not a mapping: %j",
    (source) => {
      const err = usage(() => parseConfigText(source, FILE));
      expect(err.message).toContain(FILE);
      expect(err.message).toContain("mapping");
    },
  );
});

describe("tree version", () => {
  it.each([
    ["no version key", "active_phase: x\nstatuses: [A, B]\n"],
    ["version 1", "version: 1\n"],
    ["an empty file", ""],
    ["comments only", "# nothing here\n"],
  ])("reads a v1 tree from %s", (_label, source) => {
    expect(parseConfigText(source, FILE)).toEqual({ kind: "v1" });
  });

  it("reports a version it does not support", () => {
    expect(parseConfigText("version: 3\n", FILE)).toEqual({
      kind: "unsupported",
      version: 3,
    });
  });

  it("refuses a version that is not an integer", () => {
    for (const source of [
      'version: "2"\n',
      "version: null\n",
      "version: 2.5\n",
    ]) {
      const err = usage(() => parseConfigText(source, FILE));
      expect(err.details).toMatchObject({ key: "version" });
    }
  });

  it("does not let a v1 tree's unknown keys get in the way of detection", () => {
    expect(parseConfigText("roles:\n  ready: TODO\n", FILE).kind).toBe("v1");
  });
});

describe("loading from disk", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("treats a tree without config.yml as v1", async () => {
    await fs.mkdir(sandbox.tasksDir);
    expect(await detectTreeVersion(sandbox.tasksDir)).toEqual({ kind: "v1" });
  });

  it("loads a v2 tree", async () => {
    await sandbox.write(".tasks/config.yml", "version: 2\nscope: a\n");
    const config = await loadConfig(sandbox.tasksDir);
    expect(config.scope).toBe("a");
  });

  it.each([
    ["no config.yml", null],
    ["no version", "active_phase: x\n"],
    ["version: 1", "version: 1\n"],
  ])("refuses a v1 tree (%s) and names the upgrade", async (_label, source) => {
    await fs.mkdir(sandbox.tasksDir);
    if (source !== null) await sandbox.write(".tasks/config.yml", source);
    const err = await usageAsync(loadConfig(sandbox.tasksDir));
    expect(err.message).toContain("tasks migrate");
    expect(err.details).toMatchObject({ version: 1 });
  });

  it("returns the v1 marker when the caller allows a v1 tree", async () => {
    await sandbox.write(".tasks/config.yml", "version: 1\n");
    expect(await loadConfig(sandbox.tasksDir, { allowV1: true })).toEqual({
      version: 1,
    });
  });

  it("refuses an unsupported version even when v1 is allowed", async () => {
    await sandbox.write(".tasks/config.yml", "version: 3\n");
    for (const options of [{}, { allowV1: true }]) {
      const err = await usageAsync(loadConfig(sandbox.tasksDir, options));
      expect(err.message).toContain("version 3 is not supported");
      expect(err.details).toMatchObject({ version: 3, supported: 2 });
    }
  });

  it("refuses a config.yml that is not a file, naming it", async () => {
    await fs.mkdir(path.join(sandbox.tasksDir, "config.yml"), {
      recursive: true,
    });
    const err = await usageAsync(loadConfig(sandbox.tasksDir));
    expect(err.message).toContain("config.yml");
  });

  describe("self aliases", () => {
    it("refuses an alias to the project root", async () => {
      await sandbox.write(
        ".tasks/config.yml",
        "version: 2\nprojects:\n  me: .\n",
      );
      const err = await usageAsync(loadConfig(sandbox.tasksDir));
      expect(err.message).toContain('project "me"');
      expect(err.details).toMatchObject({ alias: "me", path: "." });
    });

    it("refuses an alias that discovery leads back to this tree", async () => {
      await fs.mkdir(path.join(sandbox.dir, "packages", "web"), {
        recursive: true,
      });
      await sandbox.write(
        ".tasks/config.yml",
        "version: 2\nprojects:\n  web: packages/web\n",
      );
      await usageAsync(loadConfig(sandbox.tasksDir));
    });

    it("refuses an alias that reaches this tree through a symlink", async () => {
      await fs.symlink(sandbox.dir, path.join(sandbox.root, "mirror"));
      await sandbox.write(
        ".tasks/config.yml",
        "version: 2\nprojects:\n  mirror: ../mirror\n",
      );
      await usageAsync(loadConfig(sandbox.tasksDir));
    });

    it("accepts a nested project that owns its own tree", async () => {
      await sandbox.write("packages/web/.tasks/config.yml", "version: 2\n");
      await sandbox.write(
        ".tasks/config.yml",
        "version: 2\nprojects:\n  web: packages/web\n",
      );
      const config = await loadConfig(sandbox.tasksDir);
      expect(projectPathOf(config, "web")).toBe("packages/web");
    });

    it("accepts a sibling project and one that is not checked out", async () => {
      await sandbox.project("backend", "../backend");
      await sandbox.write(
        ".tasks/config.yml",
        "version: 2\nprojects:\n  backend: ../backend\n  cli: ../not-here\n",
      );
      const config = await loadConfig(sandbox.tasksDir);
      expect(Object.keys(config.projects)).toEqual(["backend", "cli"]);
    });
  });
});

describe("rendering", () => {
  it("writes `version: 2` alone for the defaults", () => {
    expect(renderConfig(defaultConfig())).toBe("version: 2\n");
  });

  it("writes only the keys that differ from their defaults", () => {
    const config = defaultConfig();
    config.scope = "auth-rework";
    config.sessionTimeoutMinutes = 45;
    config.projects.backend = "../backend";
    config.projects.web = "packages/web site";
    expect(renderConfig(config)).toBe(`version: 2
scope: auth-rework
session_timeout_minutes: 45
projects:
  backend: ../backend
  web: "packages/web site"
`);
  });

  it("writes the actors before the projects, a bare name without a value", () => {
    const config = defaultConfig();
    config.actors.alice = "maintainer; approves plans and does releases";
    config.actors.bob = null;
    config.actors.agent = "the coding agent: Claude";
    config.projects.backend = "../backend";
    expect(renderConfig(config)).toBe(`version: 2
actors:
  alice: "maintainer; approves plans and does releases"
  bob:
  agent: "the coding agent: Claude"
projects:
  backend: ../backend
`);
    expect(v2(renderConfig(config))).toEqual(config);
  });

  it("round-trips through the parser", () => {
    const config = defaultConfig();
    config.scope = "2026-q1";
    config.projects.null = "../null";
    config.projects.backend = "../backend";
    expect(v2(renderConfig(config))).toEqual(config);
  });
});
