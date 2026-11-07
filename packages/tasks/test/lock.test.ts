import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { treeLockPath, withTreeLock } from "../src/core/lock.js";
import { LOCK_STALE_MS } from "../src/core/types.js";
import { isTaskError } from "../src/errors.js";

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tasks-lock-"));
});

afterEach(async () => {
  await fs.rm(tasksDir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function backdate(file: string, ms: number): Promise<void> {
  const past = new Date(Date.now() - ms);
  await fs.utimes(file, past, past);
}

describe("tree locking", () => {
  it("serializes work and releases the lock afterwards", async () => {
    expect(await withTreeLock(tasksDir, async () => "done")).toBe("done");
    // A second acquisition proves the first released.
    expect(await withTreeLock(tasksDir, async () => "again")).toBe("again");
    await expect(fs.stat(treeLockPath(tasksDir))).rejects.toThrow();
  });

  it("holds one lock for the whole tree at .locks/tree.lock", async () => {
    const file = path.join(tasksDir, ".locks", "tree.lock");
    expect(treeLockPath(tasksDir)).toBe(file);
    await withTreeLock(tasksDir, async () => {
      const payload = JSON.parse(await fs.readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
      expect(payload).toMatchObject({
        pid: process.pid,
        hostname: os.hostname(),
      });
      expect(typeof payload.timestamp).toBe("string");
    });
  });

  it("refuses a concurrent holder with a conflict error", async () => {
    const held = deferred();
    const first = withTreeLock(tasksDir, async () => {
      await held.promise;
      return "first";
    });
    // Give the first acquisition a turn to create the lock file.
    await tick();

    try {
      await withTreeLock(tasksDir, async () => "second", { waitMs: 0 });
      expect.unreachable("second acquisition should have been refused");
    } catch (err) {
      expect(isTaskError(err)).toBe(true);
      if (isTaskError(err)) {
        expect(err.exitCode).toBe(4);
        expect(err.details).toMatchObject({
          lock: treeLockPath(tasksDir),
          holder: { pid: process.pid },
        });
      }
    }

    held.resolve();
    expect(await first).toBe("first");
  });

  it("gives up after the wait budget while the holder keeps working", async () => {
    const held = deferred();
    const first = withTreeLock(tasksDir, () => held.promise);
    await tick();

    const started = Date.now();
    await expect(
      withTreeLock(tasksDir, async () => "late", { waitMs: 150 }),
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);

    held.resolve();
    await first;
  });

  it("waits for a holder that finishes within the budget", async () => {
    const held = deferred();
    const first = withTreeLock(tasksDir, () => held.promise);
    await tick();

    const second = withTreeLock(tasksDir, async () => "second");
    await tick(50);
    held.resolve();

    expect(await second).toBe("second");
    await first;
  });

  it("never lets two holders overlap", async () => {
    let inside = 0;
    let most = 0;
    const work = async () => {
      inside += 1;
      most = Math.max(most, inside);
      await tick(5);
      inside -= 1;
    };

    await Promise.all(
      Array.from({ length: 8 }, () => withTreeLock(tasksDir, work)),
    );
    expect(most).toBe(1);
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    const lockFile = treeLockPath(tasksDir);
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify({ pid: 999999 }), "utf8");
    await backdate(lockFile, LOCK_STALE_MS + 1_000);

    expect(
      await withTreeLock(tasksDir, async () => "recovered", { waitMs: 0 }),
    ).toBe("recovered");
  });

  it("does not reclaim a lock younger than the threshold", async () => {
    const lockFile = treeLockPath(tasksDir);
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify({ pid: 999999 }), "utf8");
    await backdate(lockFile, LOCK_STALE_MS - 2_000);

    await expect(
      withTreeLock(tasksDir, async () => "nope", { waitMs: 0 }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it("keeps a long-held lock fresh so it is not reclaimed", async () => {
    const lockFile = treeLockPath(tasksDir);
    await withTreeLock(
      tasksDir,
      async () => {
        // As if the holder had been working for longer than the threshold.
        await backdate(lockFile, LOCK_STALE_MS + 1_000);
        await tick(60);
        const age = Date.now() - (await fs.stat(lockFile)).mtimeMs;
        expect(age).toBeLessThan(LOCK_STALE_MS);
        await expect(
          withTreeLock(tasksDir, async () => "stolen", { waitMs: 0 }),
        ).rejects.toMatchObject({ exitCode: 4 });
      },
      { refreshMs: 20 },
    );
  });

  it("stops touching the lock once it is released", async () => {
    const lockFile = treeLockPath(tasksDir);
    let payload = "";
    await withTreeLock(
      tasksDir,
      async () => {
        payload = await fs.readFile(lockFile, "utf8");
      },
      { refreshMs: 10 },
    );
    // The same payload again, as if this process took the lock once more.
    await fs.writeFile(lockFile, payload, "utf8");
    await backdate(lockFile, 5_000);
    await tick(40);
    const age = Date.now() - (await fs.stat(lockFile)).mtimeMs;
    expect(age).toBeGreaterThanOrEqual(4_000);
  });

  it("clears a reclaim guard abandoned by a crashed reclaimer", async () => {
    const lockFile = treeLockPath(tasksDir);
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    for (const file of [lockFile, `${lockFile}.reclaim`]) {
      await fs.writeFile(file, "{}", "utf8");
      await backdate(file, LOCK_STALE_MS + 1_000);
    }

    expect(await withTreeLock(tasksDir, async () => "recovered")).toBe(
      "recovered",
    );
  });

  it("releases the lock even when the body throws", async () => {
    await expect(
      withTreeLock(tasksDir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await withTreeLock(tasksDir, async () => "free")).toBe("free");
  });

  it("leaves alone a lock that another process took over", async () => {
    const lockFile = treeLockPath(tasksDir);
    await withTreeLock(tasksDir, async () => {
      // As if this holder had gone stale and been reclaimed meanwhile.
      await fs.writeFile(lockFile, JSON.stringify({ pid: 1 }), "utf8");
    });
    expect(JSON.parse(await fs.readFile(lockFile, "utf8"))).toEqual({ pid: 1 });
  });
});
