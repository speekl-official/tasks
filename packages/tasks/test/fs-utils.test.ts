import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  errnoCode,
  fileMtime,
  isDirectory,
  pathExists,
  readFileIfExists,
  removeEmptyDirs,
  renameDir,
  touchFile,
  writeFileAtomic,
} from "../src/core/fs-utils.js";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-tasks-fs-")),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const at = (...parts: string[]) => path.join(root, ...parts);

async function put(relative: string, contents = "x"): Promise<void> {
  await fs.mkdir(path.dirname(at(relative)), { recursive: true });
  await fs.writeFile(at(relative), contents, "utf8");
}

describe("writeFileAtomic", () => {
  it("creates parents, replaces the file and leaves no temp file", async () => {
    await writeFileAtomic(at("a", "b", "file.md"), "one");
    await writeFileAtomic(at("a", "b", "file.md"), "two");
    expect(await fs.readFile(at("a", "b", "file.md"), "utf8")).toBe("two");
    expect(await fs.readdir(at("a", "b"))).toEqual(["file.md"]);
  });
});

describe("small readers", () => {
  it("reads a file or null when it is missing", async () => {
    await put("present.txt", "hello");
    expect(await readFileIfExists(at("present.txt"))).toBe("hello");
    expect(await readFileIfExists(at("missing.txt"))).toBeNull();
  });

  it("reports an mtime or null when the path is missing", async () => {
    await put("f");
    expect(await fileMtime(at("f"))).toBeInstanceOf(Date);
    expect(await fileMtime(at("missing"))).toBeNull();
  });

  it("tells files, directories and absence apart", async () => {
    await put("dir/file");
    expect(await pathExists(at("dir"))).toBe(true);
    expect(await isDirectory(at("dir"))).toBe(true);
    expect(await isDirectory(at("dir", "file"))).toBe(false);
    expect(await pathExists(at("nothing"))).toBe(false);
  });

  it("extracts errno codes", () => {
    expect(errnoCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(
      "ENOENT",
    );
    expect(errnoCode(new Error("x"))).toBeUndefined();
    expect(errnoCode("nope")).toBeUndefined();
  });
});

describe("touchFile", () => {
  it("creates an empty file, parents included", async () => {
    await touchFile(at("sessions", "s1"));
    expect(await fs.readFile(at("sessions", "s1"), "utf8")).toBe("");
  });

  it("bumps the mtime of an existing file and keeps its contents", async () => {
    await put("s1", "ended\n");
    const past = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(at("s1"), past, past);

    await touchFile(at("s1"));
    const mtime = (await fileMtime(at("s1")))!;
    expect(Date.now() - mtime.getTime()).toBeLessThan(5_000);
    expect(await fs.readFile(at("s1"), "utf8")).toBe("ended\n");
  });
});

describe("renameDir", () => {
  it("moves a subtree, creating the destination's parents", async () => {
    await put("src/task/task.md", "manifest");
    await put("src/task/child/task.md", "child");

    await renameDir(at("src", "task"), at("dst", "deep", "task"));
    expect(
      await fs.readFile(at("dst", "deep", "task", "child", "task.md"), "utf8"),
    ).toBe("child");
    expect(await pathExists(at("src", "task"))).toBe(false);
  });

  it("refuses an existing destination", async () => {
    await put("a/task.md");
    await put("b/task.md");
    await expect(renameDir(at("a"), at("b"))).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await pathExists(at("a", "task.md"))).toBe(true);
  });

  it("copies and removes across filesystems, keeping mtimes", async () => {
    await put("src/task/task.md", "manifest");
    await put("src/task/notes/state.md", "state");
    const past = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(at("src", "task", "notes", "state.md"), past, past);

    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(
        Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" }),
      );

    await renameDir(at("src", "task"), at("dst", "task"));
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(at("dst", "task", "task.md"), "utf8")).toBe(
      "manifest",
    );
    const stat = await fs.stat(at("dst", "task", "notes", "state.md"));
    expect(stat.mtime.getTime()).toBe(past.getTime());
    expect(await pathExists(at("src", "task"))).toBe(false);
  });

  it("passes through any other rename failure", async () => {
    await expect(renameDir(at("missing"), at("dst"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("removeEmptyDirs", () => {
  it("removes the directory and its emptied parents up to the boundary", async () => {
    await fs.mkdir(at("tasks", "group", "sub", "leaf"), { recursive: true });
    await removeEmptyDirs(at("tasks", "group", "sub", "leaf"), at("tasks"));
    expect(await pathExists(at("tasks", "group"))).toBe(false);
    expect(await isDirectory(at("tasks"))).toBe(true);
  });

  it("stops at the first directory that still holds something", async () => {
    await fs.mkdir(at("tasks", "group", "sub", "leaf"), { recursive: true });
    await put("tasks/group/README.md");
    await removeEmptyDirs(at("tasks", "group", "sub", "leaf"), at("tasks"));
    expect(await pathExists(at("tasks", "group", "sub"))).toBe(false);
    expect(await pathExists(at("tasks", "group", "README.md"))).toBe(true);
  });

  it("treats hidden files as content", async () => {
    await put("tasks/group/.DS_Store");
    await removeEmptyDirs(at("tasks", "group"), at("tasks"));
    expect(await pathExists(at("tasks", "group", ".DS_Store"))).toBe(true);
  });

  it("climbs past a directory that is already gone", async () => {
    await fs.mkdir(at("tasks", "group"), { recursive: true });
    await removeEmptyDirs(at("tasks", "group", "moved-away"), at("tasks"));
    expect(await pathExists(at("tasks", "group"))).toBe(false);
  });

  it("never removes the boundary or anything outside it", async () => {
    await fs.mkdir(at("tasks"), { recursive: true });
    await fs.mkdir(at("elsewhere"), { recursive: true });
    await removeEmptyDirs(at("tasks"), at("tasks"));
    await removeEmptyDirs(at("elsewhere"), at("tasks"));
    expect(await isDirectory(at("tasks"))).toBe(true);
    expect(await isDirectory(at("elsewhere"))).toBe(true);
  });
});
