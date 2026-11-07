import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write via temp-file + rename so a reader never observes a half-written
 * file, and a crash mid-write leaves the original intact. The temp file sits
 * in the target directory so the rename never crosses a filesystem.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const { code } = err as { code?: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** The file's contents, or `null` when it does not exist. */
export async function readFileIfExists(
  filePath: string,
): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

/** The modification time, or `null` when the path does not exist. */
export async function fileMtime(target: string): Promise<Date | null> {
  try {
    return (await fs.stat(target)).mtime;
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

/**
 * Create an empty file, or bump the mtime of an existing one without touching
 * its contents. Parent directories are created on demand.
 */
export async function touchFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Append mode creates a missing file and never truncates an existing one.
  const handle = await fs.open(filePath, "a");
  await handle.close();
  const now = new Date();
  await fs.utimes(filePath, now, now);
}

async function copyTree(from: string, to: string): Promise<void> {
  const stat = await fs.lstat(from);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from)) {
      await copyTree(path.join(from, entry), path.join(to, entry));
    }
  } else if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(from), to);
    return;
  } else {
    await fs.copyFile(from, to);
  }
  // Ages of workspace files feed staleness warnings; a move must keep them.
  await fs.utimes(to, stat.atime, stat.mtime);
}

/**
 * Move a directory with one atomic rename. Across filesystems (`EXDEV`) the
 * subtree is copied and the source removed afterwards; interrupted, that
 * leaves the content present twice, which validation reports, rather than
 * lost. The destination must not exist; its parent is created on demand.
 */
export async function renameDir(from: string, to: string): Promise<void> {
  if (await pathExists(to)) {
    throw Object.assign(
      new Error(`EEXIST: destination already exists, rename '${to}'`),
      { code: "EEXIST", path: to },
    );
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
    return;
  } catch (err) {
    if (errnoCode(err) !== "EXDEV") throw err;
  }
  try {
    await copyTree(from, to);
  } catch (err) {
    await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await fs.rm(from, { recursive: true, force: true });
}

/**
 * Remove `dir` if it is empty, then each parent that becomes empty, up to but
 * excluding `stopAt`. A directory still holding anything, hidden files
 * included, ends the climb: only directories the caller emptied go away.
 */
export async function removeEmptyDirs(
  dir: string,
  stopAt: string,
): Promise<void> {
  const boundary = path.resolve(stopAt);
  let current = path.resolve(dir);

  while (isStrictlyInside(current, boundary)) {
    try {
      await fs.rmdir(current);
    } catch (err) {
      // Already gone counts as removed; not empty (or not removable) ends it.
      if (errnoCode(err) !== "ENOENT") return;
    }
    current = path.dirname(current);
  }
}

function isStrictlyInside(target: string, boundary: string): boolean {
  const relative = path.relative(boundary, target);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] !== ".."
  );
}
