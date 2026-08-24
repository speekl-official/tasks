import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write via temp-file + rename so a reader never observes a half-written task
 * file, and a crash mid-write leaves the original intact.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
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
