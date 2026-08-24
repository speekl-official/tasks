import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCK_STALE_MS, withTaskLock } from "../src/core/lock.js";
import { isTaskError } from "../src/errors.js";

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tasks-lock-"));
});

afterEach(async () => {
  await fs.rm(tasksDir, { recursive: true, force: true });
});

describe("task locking", () => {
  it("serializes work and releases the lock afterwards", async () => {
    const result = await withTaskLock(tasksDir, "a", async () => "done");
    expect(result).toBe("done");

    // A second acquisition proves the first released.
    expect(await withTaskLock(tasksDir, "a", async () => "again")).toBe("again");
  });

  it("refuses a concurrent holder with a conflict error", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withTaskLock(tasksDir, "a", async () => {
      await held;
      return "first";
    });

    // Give the first acquisition a turn to create the lock file.
    await new Promise((resolve) => setTimeout(resolve, 10));

    try {
      await withTaskLock(tasksDir, "a", async () => "second");
      expect.unreachable("second acquisition should have been refused");
    } catch (err) {
      expect(isTaskError(err)).toBe(true);
      if (isTaskError(err)) expect(err.exitCode).toBe(4);
    }

    release();
    expect(await first).toBe("first");
  });

  it("does not block a different task", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withTaskLock(tasksDir, "a", async () => {
      await held;
      return "first";
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await withTaskLock(tasksDir, "b", async () => "other")).toBe("other");

    release();
    await first;
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    const lockFile = path.join(tasksDir, ".locks", "a.lock");
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify({ pid: 999999 }), "utf8");

    const past = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    await fs.utimes(lockFile, past, past);

    expect(await withTaskLock(tasksDir, "a", async () => "recovered")).toBe("recovered");
  });

  it("releases the lock even when the body throws", async () => {
    await expect(
      withTaskLock(tasksDir, "a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await withTaskLock(tasksDir, "a", async () => "free")).toBe("free");
  });
});
