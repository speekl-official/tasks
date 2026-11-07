import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isTaskError, TaskError } from "../errors.js";
import { errnoCode } from "./fs-utils.js";
import { LOCKS_DIRNAME, LOCK_STALE_MS, TREE_LOCK_FILENAME } from "./types.js";

/**
 * How long a command waits for a busy tree lock before reporting a conflict.
 * Mutations hold the lock for milliseconds, so a short wait turns ordinary
 * contention (two agents claiming at once) into serialization instead of an
 * error, while a wedged holder still surfaces quickly.
 */
export const LOCK_WAIT_MS = 2_000;

/**
 * How often a held lock is touched. A holder that works longer than
 * `LOCK_STALE_MS` — a move across filesystems copies the subtree — would
 * otherwise be judged dead and have its lock reclaimed under it.
 */
export const LOCK_REFRESH_MS = LOCK_STALE_MS / 4;

export interface LockPayload {
  pid: number;
  hostname: string;
  timestamp: string;
}

export interface TreeLockOptions {
  /** How long to wait for a held lock; `0` refuses at once. */
  waitMs?: number;
  /** How often the held lock is touched; for tests. */
  refreshMs?: number;
}

export function treeLockPath(tasksDir: string): string {
  return path.join(tasksDir, LOCKS_DIRNAME, TREE_LOCK_FILENAME);
}

/** `wx` is O_CREAT | O_EXCL: the create fails atomically if the file exists. */
async function tryCreate(file: string, contents: string): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "wx");
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return false;
    throw err;
  }
  try {
    await handle.writeFile(contents, "utf8");
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(file, { force: true }).catch(() => undefined);
    throw err;
  }
  await handle.close();
  return true;
}

/** Milliseconds since the file was last modified, or `null` if it is gone. */
async function ageMs(file: string): Promise<number | null> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs;
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

/**
 * Remove a stale lock without racing other reclaimers. Waiters all notice a
 * dead holder at the same moment; if each removed "the stale lock" it judged
 * earlier, a late one would delete the fresh lock an earlier one just took.
 * A guard file serializes the check-and-remove. Returns whether it removed.
 */
async function reclaimIfStale(file: string, payload: string): Promise<boolean> {
  const guard = `${file}.reclaim`;
  if (!(await tryCreate(guard, payload))) {
    // The guard is held for microseconds; one this old outlived its owner.
    const guardAge = await ageMs(guard);
    if (guardAge !== null && guardAge > LOCK_STALE_MS) {
      await fs.rm(guard, { force: true });
    }
    return false;
  }
  try {
    const age = await ageMs(file);
    if (age === null || age <= LOCK_STALE_MS) return false;
    await fs.rm(file, { force: true });
    return true;
  } finally {
    await fs.rm(guard, { force: true });
  }
}

async function readHolder(file: string): Promise<LockPayload | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      "hostname" in parsed &&
      "timestamp" in parsed
    ) {
      return parsed as LockPayload;
    }
  } catch {
    // Gone, half-written or not ours: there is no holder to name.
  }
  return null;
}

/** ` by process 123 on host since 2026-…`, or nothing for an unknown holder. */
export function holderText(holder: LockPayload | null): string {
  return holder
    ? ` by process ${holder.pid} on ${holder.hostname} since ${holder.timestamp}`
    : "";
}

/** Whether `err` is the conflict a busy tree lock raises. */
export function isLockBusy(err: unknown): err is TaskError {
  return (
    isTaskError(err) &&
    err.code === "CONFLICT" &&
    typeof err.details?.lock === "string"
  );
}

/** Only our own lock is removed: after a reclaim, the file is someone else's. */
async function release(file: string, payload: string): Promise<void> {
  try {
    if ((await fs.readFile(file, "utf8")) === payload) {
      await fs.rm(file, { force: true });
    }
  } catch {
    // Already gone.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keep a held lock younger than the reclaim threshold by touching it
 * periodically. Only our own lock is touched: after a reclaim the file is
 * someone else's. The timer never keeps the process alive.
 */
function keepFresh(
  file: string,
  payload: string,
  everyMs: number,
): { stop: () => void } {
  let touching = false;
  const timer = setInterval(() => {
    if (touching) return;
    touching = true;
    void touchOwn(file, payload).finally(() => {
      touching = false;
    });
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

async function touchOwn(file: string, payload: string): Promise<void> {
  try {
    if ((await fs.readFile(file, "utf8")) !== payload) return;
    const now = new Date();
    await fs.utimes(file, now, now);
  } catch {
    // Gone or unreadable: nothing of ours to keep fresh.
  }
}

/**
 * Run `fn` while holding the tree-wide lock `.tasks/.locks/tree.lock`.
 *
 * Callers must re-read every task the mutation depends on *inside* `fn`: the
 * point of the lock is that anything read before acquiring it may be stale.
 * A lock older than `LOCK_STALE_MS` belongs to a dead process and is
 * reclaimed; a live one that outlasts `waitMs` is a conflict. The holder
 * touches its lock every `LOCK_REFRESH_MS`, so a long write is never
 * mistaken for a dead one.
 */
export async function withTreeLock<T>(
  tasksDir: string,
  fn: () => Promise<T>,
  options: TreeLockOptions = {},
): Promise<T> {
  const file = treeLockPath(tasksDir);
  await fs.mkdir(path.dirname(file), { recursive: true });

  const payload: LockPayload = {
    pid: process.pid,
    hostname: os.hostname(),
    timestamp: new Date().toISOString(),
  };
  const text = JSON.stringify(payload);
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  let delay = 5;

  for (;;) {
    if (await tryCreate(file, text)) break;
    const age = await ageMs(file);
    // Released between our attempt and the stat: try again at once.
    if (age === null) continue;
    if (age > LOCK_STALE_MS && (await reclaimIfStale(file, text))) continue;
    if (Date.now() >= deadline) {
      const holder = await readHolder(file);
      throw TaskError.conflict(
        `The task tree is locked${holderText(holder)}. Another command is writing it; try again.`,
        { lock: file, holder },
      );
    }
    // Jitter keeps several waiters from retrying in lockstep.
    await sleep(Math.min(delay * (0.5 + Math.random()), deadline - Date.now()));
    delay = Math.min(delay * 2, 50);
  }

  const refresh = keepFresh(file, text, options.refreshMs ?? LOCK_REFRESH_MS);
  try {
    return await fn();
  } finally {
    refresh.stop();
    await release(file, text);
  }
}
