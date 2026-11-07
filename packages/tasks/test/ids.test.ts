import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ancestorPaths,
  assertTaskPath,
  compareIds,
  depthOf,
  formatReference,
  idToNative,
  isBelow,
  isMachineBoundPath,
  isSegment,
  isTaskPath,
  isWithin,
  nameOf,
  nativeToId,
  parentOf,
  parseReference,
  qualifyId,
  resolveSuffix,
  safeParseReference,
  splitTaskArgument,
} from "../src/core/ids.js";
import type { TaskError } from "../src/errors.js";
import { isTaskError } from "../src/errors.js";

function caught(fn: () => unknown): TaskError {
  try {
    fn();
  } catch (err) {
    if (isTaskError(err)) return err;
    throw err;
  }
  throw new Error("expected a TaskError");
}

describe("segments and paths", () => {
  it("accepts lowercase kebab segments, digits first included", () => {
    for (const ok of ["a", "auth-rework", "2026-q1", "v2", "a-", "0"]) {
      expect(isSegment(ok)).toBe(true);
    }
  });

  it("rejects everything else as a segment", () => {
    for (const bad of [
      "",
      "Auth",
      "-a",
      "a_b",
      "a.b",
      ".archive",
      "a b",
      "a:b",
      "task.md",
    ]) {
      expect(isSegment(bad)).toBe(false);
    }
  });

  it("accepts paths of segments and nothing looser", () => {
    expect(isTaskPath("auth-rework/token-schema")).toBe(true);
    expect(isTaskPath("a")).toBe(true);
    for (const bad of [
      "",
      "/a",
      "a/",
      "a//b",
      "a/B",
      "a\\b",
      "./a",
      "a/../b",
    ]) {
      expect(isTaskPath(bad)).toBe(false);
    }
  });

  it("refuses an invalid path as a usage error naming it", () => {
    const err = caught(() => assertTaskPath("Bad/Path", "destination"));
    expect(err.exitCode).toBe(2);
    expect(err.details).toEqual({ destination: "Bad/Path" });
  });

  it("derives parent paths, names and depth", () => {
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(parentOf("a")).toBeNull();
    expect(nameOf("a/b/c")).toBe("c");
    expect(nameOf("a")).toBe("a");
    expect(depthOf("a/b/c")).toBe(3);
  });

  it("lists ancestor paths nearest first", () => {
    expect(ancestorPaths("a/b/c")).toEqual(["a/b", "a"]);
    expect(ancestorPaths("a")).toEqual([]);
  });

  it("tells containment by whole segments", () => {
    expect(isWithin("a/b", "a")).toBe(true);
    expect(isWithin("a", "a")).toBe(true);
    expect(isWithin("ab", "a")).toBe(false);
    expect(isWithin("a-b/c", "a")).toBe(false);
    expect(isBelow("a/b", "a")).toBe(true);
    expect(isBelow("a", "a")).toBe(false);
  });

  it("orders ids in tree order, a parent right before its subtree", () => {
    const ids = ["a-b", "b", "a/b/c", "a", "a/b", "a/a"];
    expect([...ids].sort(compareIds)).toEqual([
      "a",
      "a/a",
      "a/b",
      "a/b/c",
      "a-b",
      "b",
    ]);
  });

  it("qualifies foreign ids with their alias", () => {
    expect(qualifyId(null, "a/b")).toBe("a/b");
    expect(qualifyId("backend", "a/b")).toBe("backend:a/b");
  });
});

describe("id and native path conversion", () => {
  const base = path.join(path.sep, "repo", ".tasks");

  it("joins segments with the platform separator", () => {
    expect(idToNative(base, "a/b/c")).toBe(path.join(base, "a", "b", "c"));
  });

  it("turns a native path under the base back into a posix id", () => {
    expect(nativeToId(base, path.join(base, "a", "b"))).toBe("a/b");
  });

  it("returns null for the base itself, outside paths and bad names", () => {
    expect(nativeToId(base, base)).toBeNull();
    expect(nativeToId(base, path.join(base, ".."))).toBeNull();
    expect(nativeToId(base, path.join(path.sep, "elsewhere"))).toBeNull();
    expect(nativeToId(base, path.join(base, "Bad"))).toBeNull();
    expect(nativeToId(base, path.join(base, ".archive", "a"))).toBeNull();
  });
});

describe("reference grammar", () => {
  it("reads a string without a colon as a local path", () => {
    expect(parseReference("auth-rework/token-schema")).toEqual({
      kind: "local",
      path: "auth-rework/token-schema",
    });
  });

  it("reads project-path:path as an external reference", () => {
    expect(parseReference("../backend:kernel/tests")).toEqual({
      kind: "external",
      projectPath: "../backend",
      path: "kernel/tests",
    });
  });

  it("splits on the last colon, so a project path may hold one", () => {
    expect(parseReference("../odd:name/repo:a/b")).toEqual({
      kind: "external",
      projectPath: "../odd:name/repo",
      path: "a/b",
    });
  });

  it("round-trips through formatReference", () => {
    for (const raw of ["a/b", "../backend:kernel-tests", "sub dir:x"]) {
      expect(formatReference(parseReference(raw))).toBe(raw);
    }
  });

  it.each([
    ["", "empty"],
    [":a", "empty"],
    ["../backend:", "not a task path"],
    ["Auth/Token", "not a task path"],
    ["a/b/", "not a task path"],
    ["/abs/repo:a", "absolute"],
    ["C:\\repo:a", "absolute"],
    ["C:/repo:a", "absolute"],
    ["C:repo:a", "absolute"],
    ["\\\\server\\share:a", "absolute"],
    ["\\rooted:a", "absolute"],
  ])("refuses %j as a usage error (%s)", (raw, reason) => {
    const err = caught(() => parseReference(raw));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain(reason);
    expect(err.details).toEqual({ ref: raw });
  });

  it("reports a parse failure without throwing in the safe form", () => {
    expect(safeParseReference("a/b")).toEqual({
      ok: true,
      ref: { kind: "local", path: "a/b" },
    });
    const bad = safeParseReference("/abs:a");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/absolute/);
  });

  it("knows machine-bound paths from relative ones", () => {
    for (const bound of [
      "/a",
      "\\a",
      "C:\\a",
      "C:/a",
      "c:a",
      "a:b",
      "\\\\s\\x",
    ]) {
      expect(isMachineBoundPath(bound)).toBe(true);
    }
    for (const relative of ["../a", "a/b", "./a", "~/a", "ab:c"]) {
      expect(isMachineBoundPath(relative)).toBe(false);
    }
  });
});

describe("command-line arguments", () => {
  it("splits an alias-prefixed argument like a reference", () => {
    expect(splitTaskArgument("kernel-tests")).toEqual({
      prefix: null,
      path: "kernel-tests",
    });
    expect(splitTaskArgument("backend:kernel-tests")).toEqual({
      prefix: "backend",
      path: "kernel-tests",
    });
    expect(splitTaskArgument("../cli:a/b")).toEqual({
      prefix: "../cli",
      path: "a/b",
    });
  });

  it("refuses an absolute prefix and an empty one", () => {
    expect(caught(() => splitTaskArgument("/x:a")).exitCode).toBe(2);
    expect(caught(() => splitTaskArgument(":a")).exitCode).toBe(2);
  });
});

describe("unambiguous suffix resolution", () => {
  const ids = [
    "auth-rework/token-schema",
    "auth-rework/tests",
    "billing/tests",
    "tests",
    "deploy/execute",
    "a/b/c",
  ];

  it("prefers an exact id even when it is also another id's suffix", () => {
    expect(resolveSuffix("tests", ids)).toBe("tests");
  });

  it("resolves the single id ending with /<arg>", () => {
    expect(resolveSuffix("token-schema", ids)).toBe("auth-rework/token-schema");
    expect(resolveSuffix("execute", ids)).toBe("deploy/execute");
  });

  it("matches multi-segment suffixes on segment boundaries only", () => {
    expect(resolveSuffix("b/c", ids)).toBe("a/b/c");
    expect(caught(() => resolveSuffix("schema", ids)).exitCode).toBe(3);
    expect(caught(() => resolveSuffix("ework/tests", ids)).exitCode).toBe(3);
  });

  it("refuses several candidates as a usage error naming them", () => {
    const err = caught(() =>
      resolveSuffix(
        "tests",
        ids.filter((id) => id !== "tests"),
      ),
    );
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe("USAGE");
    expect(err.details).toEqual({
      argument: "tests",
      candidates: ["auth-rework/tests", "billing/tests"],
    });
    expect(err.message).toContain("auth-rework/tests");
    expect(err.message).toContain("billing/tests");
  });

  it("is not-found when nothing matches", () => {
    const err = caught(() => resolveSuffix("nothing", ids));
    expect(err.exitCode).toBe(3);
    expect(err.details).toEqual({ argument: "nothing" });
  });

  it("refuses an argument that is not a path as a usage error", () => {
    expect(caught(() => resolveSuffix("Tests", ids)).exitCode).toBe(2);
  });

  it("shows qualified candidates and the typed argument when asked", () => {
    const err = caught(() =>
      resolveSuffix("tests", ["a/tests", "b/tests"], {
        argument: "backend:tests",
        qualify: (id) => `backend:${id}`,
      }),
    );
    expect(err.details).toEqual({
      argument: "backend:tests",
      candidates: ["backend:a/tests", "backend:b/tests"],
    });
  });
});
