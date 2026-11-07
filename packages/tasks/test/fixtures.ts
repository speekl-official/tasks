import fs from "node:fs/promises";
import path from "node:path";

import type { Config } from "../src/core/config.js";
import {
  defaultConfig,
  parseConfigText,
  renderConfig,
} from "../src/core/config.js";
import { renderTaskFile } from "../src/core/frontmatter.js";
import { idToNative, nameOf } from "../src/core/ids.js";
import type {
  ExtraKeys,
  Frontmatter,
  Priority,
  Status,
} from "../src/core/types.js";
import {
  ARCHIVE_DIRNAME,
  CONFIG_FILENAME,
  DESIGN_FILENAME,
  GITIGNORE_FILENAME,
  LOG_FILENAME,
  PLAN_FILENAME,
  STATE_FILENAME,
  TASK_FILENAME,
} from "../src/core/types.js";

/** Default `created` (and `updated`, `claimed_at`) of a fixture task. */
export const FIXTURE_TIME = "2026-01-01T00:00:00Z";

/** The actor `run` exports, and the default claimant of a fixture task. */
export const FIXTURE_ACTOR = "tester";

export const DEFAULT_STATE = "## Done\n\n## Verified\n\n## Open\n\n## Next\n";

/**
 * A compact description of one task. Everything is optional: a bare `{}` is
 * a `TODO` task created at `FIXTURE_TIME`. `IN_PROGRESS` without claim fields
 * is claimed by `FIXTURE_ACTOR` at `created`; pass `null` explicitly to write
 * an inconsistent claim on purpose.
 */
export interface TaskSpec {
  status?: Status;
  priority?: Priority;
  depends_on?: string[];
  finishes_after?: string[];
  assignee?: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  claimed_session?: string | null;
  created?: string;
  updated?: string;
  /** `true` writes a default resume point; a string is the file's content. */
  state?: boolean | string;
  design?: boolean | string;
  plan?: boolean | string;
  /** The raw content of `log.md`. */
  log?: string;
  /** Unknown frontmatter keys, written in this order after the ten fields. */
  extra?: Record<string, unknown>;
  /** The whole body; `title` is ignored when it is given. */
  body?: string;
  /** The level-one heading of the default body; the task's name otherwise. */
  title?: string;
}

/** A compact description of a v2 tree; ids are posix paths. */
export interface TreeSpec {
  scope?: string | null;
  session_timeout_minutes?: number;
  /** The roster: actor → description or `null`. */
  actors?: Record<string, string | null>;
  projects?: Record<string, string>;
  tasks?: Record<string, TaskSpec>;
  /** Archived tasks, ids relative to `.archive/`. */
  archived?: Record<string, TaskSpec>;
  /** Directories to create without a `task.md`. */
  groups?: string[];
}

export function specFrontmatter(spec: TaskSpec): Frontmatter {
  const status = spec.status ?? "TODO";
  const created = spec.created ?? FIXTURE_TIME;
  const claimed = status === "IN_PROGRESS";
  return {
    status,
    priority: spec.priority ?? "normal",
    depends_on: spec.depends_on ?? [],
    finishes_after: spec.finishes_after ?? [],
    assignee: spec.assignee ?? null,
    claimed_by:
      spec.claimed_by !== undefined
        ? spec.claimed_by
        : claimed
          ? FIXTURE_ACTOR
          : null,
    claimed_at:
      spec.claimed_at !== undefined
        ? spec.claimed_at
        : claimed
          ? created
          : null,
    claimed_session: spec.claimed_session ?? null,
    created,
    updated: spec.updated ?? created,
  };
}

export function specBody(id: string, spec: TaskSpec): string {
  return spec.body ?? `# ${spec.title ?? nameOf(id)}\n`;
}

/** The manifest a spec produces, through the canonical serializer. */
export function renderSpec(id: string, spec: TaskSpec): string {
  const extra: ExtraKeys = Object.entries(spec.extra ?? {});
  return renderTaskFile(specFrontmatter(spec), extra, specBody(id, spec));
}

async function writeOptional(
  dir: string,
  filename: string,
  value: boolean | string | undefined,
  fallback: string,
): Promise<void> {
  if (value === undefined || value === false) return;
  await fs.writeFile(
    path.join(dir, filename),
    value === true ? fallback : value,
    "utf8",
  );
}

/** Write one task directory under `baseDir` (`.tasks/` or `.archive/`). */
export async function writeTaskSpec(
  baseDir: string,
  id: string,
  spec: TaskSpec = {},
): Promise<string> {
  const dir = idToNative(baseDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, TASK_FILENAME),
    renderSpec(id, spec),
    "utf8",
  );
  await writeOptional(dir, STATE_FILENAME, spec.state, DEFAULT_STATE);
  await writeOptional(dir, DESIGN_FILENAME, spec.design, "# Design\n");
  await writeOptional(dir, PLAN_FILENAME, spec.plan, "# Plan\n");
  await writeOptional(dir, LOG_FILENAME, spec.log, "");
  return dir;
}

export function specConfig(spec: TreeSpec): Config {
  const config = defaultConfig();
  config.scope = spec.scope ?? null;
  if (spec.session_timeout_minutes !== undefined) {
    config.sessionTimeoutMinutes = spec.session_timeout_minutes;
  }
  Object.assign(config.actors, spec.actors ?? {});
  Object.assign(config.projects, spec.projects ?? {});
  return config;
}

/**
 * Lay out a v2 tree at `tasksDir`: `config.yml`, `.gitignore`, groups and
 * task files. Additive: existing tasks stay, `config.yml` is rewritten.
 */
export async function writeTree(
  tasksDir: string,
  spec: TreeSpec = {},
): Promise<void> {
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(
    path.join(tasksDir, CONFIG_FILENAME),
    renderConfig(specConfig(spec)),
    "utf8",
  );
  await fs.writeFile(path.join(tasksDir, GITIGNORE_FILENAME), ".locks/\n");
  for (const group of spec.groups ?? []) {
    await fs.mkdir(idToNative(tasksDir, group), { recursive: true });
  }
  for (const [id, task] of Object.entries(spec.tasks ?? {})) {
    await writeTaskSpec(tasksDir, id, task);
  }
  const archive = path.join(tasksDir, ARCHIVE_DIRNAME);
  for (const [id, task] of Object.entries(spec.archived ?? {})) {
    await writeTaskSpec(archive, id, task);
  }
}

/** Append `alias: relPath` to the `projects:` of the tree at `tasksDir`. */
export async function addProjectAlias(
  tasksDir: string,
  alias: string,
  relPath: string,
): Promise<void> {
  const file = path.join(tasksDir, CONFIG_FILENAME);
  let config = defaultConfig();
  try {
    const detected = parseConfigText(await fs.readFile(file, "utf8"), file);
    if (detected.kind === "v2") config = detected.config;
  } catch {
    // No config yet: start from the defaults.
  }
  config.projects[alias] = relPath;
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(file, renderConfig(config), "utf8");
}
