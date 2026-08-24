import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./fs-utils.js";
import { TaskError } from "../errors.js";

/** Skill directory name, and therefore the `/tasks` command it installs as. */
export const SKILL_NAME = "tasks";

/** Where agent skills live in a project, per the Agent Skills convention. */
export const SKILLS_RELATIVE_DIR = path.join(".claude", "skills");

const SOURCE_DIRNAME = "skill";
const ENTRY_FILENAME = "SKILL.md";

/**
 * The bundled skill sits at `<package>/skill/`, but this module runs from
 * `dist/` when published and from `src/core/` under vitest. Walk up until the
 * package root is found rather than hardcoding a depth that only holds in one
 * of those layouts.
 */
async function findSkillSource(): Promise<string> {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, SOURCE_DIRNAME);
    try {
      await fs.access(path.join(candidate, ENTRY_FILENAME));
      return candidate;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw TaskError.internal(
    `Bundled skill not found. The ${SOURCE_DIRNAME}/ directory is missing from the installed package.`,
  );
}

async function collectFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }

  return files;
}

export interface SkillInstallResult {
  /** False when an existing install was left alone; `force` overwrites it. */
  installed: boolean;
  dir: string;
  files: string[];
  skippedReason?: "exists";
}

/**
 * Copy the bundled skill into `<projectRoot>/.claude/skills/tasks/`, so an
 * agent arriving in the repo learns the CLI exists without being told.
 *
 * An existing install is left alone unless `force`, because the user may have
 * edited it — refreshing is an explicit `tasks skill install --force`.
 */
export async function installSkill(
  projectRoot: string,
  options: { force?: boolean } = {},
): Promise<SkillInstallResult> {
  const source = await findSkillSource();
  const dir = path.join(projectRoot, SKILLS_RELATIVE_DIR, SKILL_NAME);

  if (!options.force) {
    try {
      await fs.access(path.join(dir, ENTRY_FILENAME));
      return { installed: false, dir, files: [], skippedReason: "exists" };
    } catch {
      // Not installed yet — fall through and write it.
    }
  }

  const relatives = await collectFiles(source);
  const written: string[] = [];

  for (const relative of relatives) {
    const destination = path.join(dir, relative);
    await writeFileAtomic(destination, await fs.readFile(path.join(source, relative), "utf8"));
    written.push(destination);
  }

  return { installed: true, dir, files: written };
}
