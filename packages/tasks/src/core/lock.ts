import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskError } from "../errors.js";
import { errnoCode } from "./fs-utils.js";

export const LOCKS_DIRNAME = ".locks";

/**
 * Claim operations are near-instant, so a lock older than this belongs to a
 * process that crashed or was killed rather than one still working.
 */
export const LOCK_STALE_MS = 10_000;

interface LockPayload {
  pid: number;
  hostname: string;
  timestamp: string;
}

function lockPath(tasksDir: string, id: string): string {
  return path.join(tasksDir, LOCKS_DIRNAME, `${id}.lock`);
}

async function tryCreateLock(file: string): Promise<boolean> {
  const payload: LockPayload = {
    pid: process.pid,
    hostname: os.hostname(),
    timestamp: new Date().toISOString(),
  };
  try {
    // 'wx' maps to O_CREAT | O_EXCL: atomic create-fails-if-exists.
    const handle = await fs.open(file, "wx");
    try {
      await handle.writeFile(JSON.stringify(payload), "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return false;
    throw err;
  }
}

async function lockAgeMs(file: string): Promise<number | null> {
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs;
  } catch {
    // Vanished between our failed create and this stat — treat as free.
    return null;
  }
}

/**
 * Run `fn` while holding an exclusive per-task lock.
 *
 * Callers must re-read task state *inside* `fn`: the whole point of the lock is
 * that anything read before acquiring it may be stale.
 */
export async function withTaskLock<T>(
  tasksDir: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const file = lockPath(tasksDir, id);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let acquired = await tryCreateLock(file);

  if (!acquired) {
    const age = await lockAgeMs(file);
    if (age === null || age > LOCK_STALE_MS) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      acquired = await tryCreateLock(file);
    }
  }

  if (!acquired) {
    throw TaskError.conflict(
      `Task "${id}" is currently being modified by another process. Try again.`,
      { id },
    );
  }

  try {
    return await fn();
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}
