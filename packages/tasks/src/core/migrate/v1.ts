import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { TaskError } from "../../errors.js";
import { errnoCode } from "../fs-utils.js";
import type { ExtraKeys } from "../types.js";
import { ARCHIVE_DIRNAME, CONFIG_FILENAME } from "../types.js";

/**
 * A frozen reader for `.tasks` convention v1, lifted from the v1
 * implementation so that `migrate` reads a v1 tree the way the v1 CLI that
 * wrote it did. Nothing else reads v1: every other command refuses such a
 * tree. Keep it frozen; its job is to agree with v1, not with v2.
 *
 * Two departures from v1, both fail safe. Frontmatter is split by a strict
 * `---` splitter instead of gray-matter, so a file v1 would have read only
 * through a quirk of that library is reported as malformed rather than
 * guessed at. The layout is walked with `readdir` instead of a glob, with
 * the glob's rules: `<phase>/*.md` outside dot-directories, `.archive/*.md`
 * dot-files included.
 */

/** The statuses of a v1 tree whose `config.yml` names none. */
export const V1_DEFAULT_STATUSES: readonly string[] = [
  "PENDING",
  "IN_PROGRESS",
  "DONE",
];

/** What v1's `new --phase` accepted; v2 segments drop `.` and `_`. */
export const V1_PHASE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** A v1 task id, as a v1 reference names it. */
export const V1_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** v1's generated overview at the root of `.tasks/`. */
export const V1_INDEX_FILENAME = "_index.md";

export type V1RoleName = "ready" | "claimed" | "done";

export const V1_ROLE_NAMES: readonly V1RoleName[] = [
  "ready",
  "claimed",
  "done",
];

/* ------------------------------------------------------------------------ */
/* Configuration                                                            */
/* ------------------------------------------------------------------------ */

export interface V1Config {
  /** `active_phase`, the default phase of `list` and `ready`. */
  activePhase: string | null;
  /** The ordered status list. */
  statuses: string[];
  /** The status each role binds to. */
  roles: Record<V1RoleName, string>;
}

const rawConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    active_phase: z.string().min(1).optional(),
    statuses: z.array(z.string().min(1)).min(2).optional(),
    roles: z
      .object({
        ready: z.string().min(1).optional(),
        claimed: z.string().min(1).optional(),
        done: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    transitions: z
      .array(z.tuple([z.string().min(1), z.string().min(1)]))
      .optional(),
  })
  .strict();

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `${at}${issue.message}`;
    })
    .join("; ");
}

function invalidConfig(file: string, message: string): TaskError {
  return TaskError.usage(`${file}: ${message}`, { file, version: 1 });
}

/**
 * Parse a v1 `config.yml` as v1 did: defaults for absent keys, roles on the
 * first, second and last status, and the same coherence checks, so a
 * configuration v1 refused to load is refused here too.
 */
export function parseV1Config(source: string, file: string): V1Config {
  let doc: unknown;
  try {
    // JSON_SCHEMA keeps timestamp-shaped scalars as strings, as v1 did.
    doc = yaml.load(source, { schema: yaml.JSON_SCHEMA }) ?? {};
  } catch (err) {
    const reason = err instanceof yaml.YAMLException ? err.reason : String(err);
    throw invalidConfig(file, `invalid YAML: ${reason}.`);
  }

  const parsed = rawConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw invalidConfig(file, `${formatZodIssues(parsed.error)}.`);
  }
  const raw = parsed.data;

  const statuses = raw.statuses ?? [...V1_DEFAULT_STATUSES];
  const roles: Record<V1RoleName, string> = {
    ready: raw.roles?.ready ?? statuses[0]!,
    claimed: raw.roles?.claimed ?? statuses[1]!,
    done: raw.roles?.done ?? statuses[statuses.length - 1]!,
  };

  const listed = `[${statuses.join(", ")}]`;
  for (const role of V1_ROLE_NAMES) {
    if (!statuses.includes(roles[role])) {
      throw invalidConfig(
        file,
        `roles.${role} is "${roles[role]}", which is not in \`statuses\` ${listed}.`,
      );
    }
  }

  const explicit = raw.transitions
    ? new Set(raw.transitions.map(([from, to]) => `${from} ${to}`))
    : null;
  for (const pair of raw.transitions ?? []) {
    for (const status of pair) {
      if (!statuses.includes(status)) {
        throw invalidConfig(
          file,
          `transitions references "${status}", which is not in \`statuses\` ${listed}.`,
        );
      }
    }
  }
  // v1 refused a roles mapping under which `claim` could never succeed: no
  // status moves to itself, and without explicit pairs a move is one step.
  const claimable =
    roles.ready !== roles.claimed &&
    (explicit
      ? explicit.has(`${roles.ready} ${roles.claimed}`)
      : Math.abs(
          statuses.indexOf(roles.claimed) - statuses.indexOf(roles.ready),
        ) === 1);
  if (!claimable) {
    throw invalidConfig(
      file,
      `the transition ${roles.ready} -> ${roles.claimed} (roles.ready -> roles.claimed) is not legal, so v1 could never claim a task.`,
    );
  }

  return { activePhase: raw.active_phase ?? null, statuses, roles };
}

/** The tree's v1 configuration; the defaults when `config.yml` is absent. */
export async function readV1Config(tasksDir: string): Promise<V1Config> {
  const file = path.join(tasksDir, CONFIG_FILENAME);
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return parseV1Config("", file);
    throw invalidConfig(
      file,
      `cannot be read (${errnoCode(err) ?? String(err)}).`,
    );
  }
  return parseV1Config(source, file);
}

/* ------------------------------------------------------------------------ */
/* Task files                                                               */
/* ------------------------------------------------------------------------ */

/** The frontmatter keys v1 defined; every other key passed through. */
export const V1_TASK_KEYS: readonly string[] = [
  "id",
  "phase",
  "status",
  "depends_on",
  "created",
  "updated",
  "claimed_by",
  "claimed_at",
];

const frontmatterSchema = z
  .object({
    id: z.string().min(1),
    phase: z.string().min(1),
    status: z.string().min(1),
    depends_on: z.array(z.string().min(1)).default([]),
    created: z.string().min(1),
    updated: z.string().min(1),
    claimed_by: z.string().min(1).nullable().default(null),
    claimed_at: z.string().min(1).nullable().default(null),
  })
  .passthrough();

export interface V1Task {
  /** The frontmatter `id`: v1's identity, which the filename mirrors. */
  id: string;
  /** The directory for a live task (v1's rule), the frontmatter if archived. */
  phase: string;
  status: string;
  depends_on: string[];
  created: string;
  updated: string;
  claimed_by: string | null;
  claimed_at: string | null;
  /** Keys v1 did not define, in the order read. */
  extra: ExtraKeys;
  /** Everything after the closing `---` line, as written. */
  body: string;
  /** Absolute path of the `.md` file. */
  file: string;
  archived: boolean;
}

/** A task file v1 would have reported as malformed. */
export interface V1Malformed {
  file: string;
  archived: boolean;
  message: string;
}

export type V1TaskFileParse =
  | {
      ok: true;
      fields: Omit<V1Task, "extra" | "body" | "file" | "archived">;
      extra: ExtraKeys;
      body: string;
    }
  | { ok: false; message: string };

function lineAt(text: string, start: number): { line: string; next: number } {
  const end = text.indexOf("\n", start);
  return {
    line: text.slice(start, end === -1 ? text.length : end),
    next: end === -1 ? -1 : end + 1,
  };
}

/**
 * A first line of `---`, the YAML, and the next line of `---`; trailing
 * whitespace on a delimiter line (a CRLF checkout, a stray space) is
 * tolerated as v1 tolerated it.
 */
function splitFrontmatter(
  source: string,
): { yaml: string; body: string } | { error: string } {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const first = lineAt(text, 0);
  if (first.line.trimEnd() !== "---") {
    return { error: "no frontmatter: the file does not begin with a --- line" };
  }
  for (let pos = first.next; pos !== -1; ) {
    const current = lineAt(text, pos);
    if (current.line.trimEnd() === "---") {
      return {
        yaml: text.slice(first.next, pos),
        body: current.next === -1 ? "" : text.slice(current.next),
      };
    }
    pos = current.next;
  }
  return { error: "the frontmatter has no closing --- line" };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one v1 task file; the phase is the caller's to supply. */
export function parseV1TaskFile(source: string): V1TaskFileParse {
  const split = splitFrontmatter(source);
  if ("error" in split) return { ok: false, message: split.error };

  let data: unknown;
  try {
    data = yaml.load(split.yaml, { schema: yaml.JSON_SCHEMA }) ?? {};
  } catch (err) {
    const reason = err instanceof yaml.YAMLException ? err.reason : String(err);
    return { ok: false, message: `invalid frontmatter YAML: ${reason}` };
  }

  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `invalid frontmatter: ${issues}` };
  }

  const fm = parsed.data;
  const extra: ExtraKeys = isMapping(data)
    ? Object.entries(data).filter(([key]) => !V1_TASK_KEYS.includes(key))
    : [];
  return {
    ok: true,
    fields: {
      id: fm.id,
      phase: fm.phase,
      status: fm.status,
      depends_on: fm.depends_on,
      created: fm.created,
      updated: fm.updated,
      claimed_by: fm.claimed_by,
      claimed_at: fm.claimed_at,
    },
    extra,
    body: split.body,
  };
}

/* ------------------------------------------------------------------------ */
/* The layout                                                               */
/* ------------------------------------------------------------------------ */

export interface V1Tasks {
  /** Live tasks, by file path. */
  tasks: V1Task[];
  /** Archived tasks, by file path. */
  archived: V1Task[];
  malformed: V1Malformed[];
  /** Top-level directories holding a task file, parsed or not: the phases. */
  phases: string[];
  /**
   * Top-level symbolic links to directories that hold task files. v1's glob
   * followed them; v2 never follows a linked directory.
   */
  linkedPhases: string[];
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

async function statKind(target: string): Promise<"file" | "dir" | null> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

/** The `*.md` files of one directory, as v1's glob matched them, sorted. */
async function taskFilesIn(dir: string, dot: boolean): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readEntries(dir)) {
    if (!entry.name.endsWith(".md")) continue;
    if (!dot && entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    // The glob followed links to files.
    if (
      entry.isFile() ||
      (entry.isSymbolicLink() && (await statKind(file)) === "file")
    ) {
      files.push(file);
    }
  }
  return files.sort();
}

async function readTaskFile(
  file: string,
  archived: boolean,
  phase: string | null,
): Promise<V1Task | V1Malformed> {
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (err) {
    return {
      file,
      archived,
      message: `cannot be read (${errnoCode(err) ?? String(err)})`,
    };
  }
  const parsed = parseV1TaskFile(source);
  if (!parsed.ok) return { file, archived, message: parsed.message };
  return {
    ...parsed.fields,
    // The directory owns a live task's phase; the flat archive keeps it in
    // the frontmatter.
    phase: phase ?? parsed.fields.phase,
    extra: parsed.extra,
    body: parsed.body,
    file,
    archived,
  };
}

function isTask(read: V1Task | V1Malformed): read is V1Task {
  return "id" in read;
}

/** Every task file of the v1 tree at `tasksDir`, live and archived. */
export async function readV1Tasks(tasksDir: string): Promise<V1Tasks> {
  const out: V1Tasks = {
    tasks: [],
    archived: [],
    malformed: [],
    phases: [],
    linkedPhases: [],
  };

  const top = (await readEntries(tasksDir)).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of top) {
    // `.archive/`, `.locks/` and every other dot-entry are not phases.
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(tasksDir, entry.name);
    if (entry.isSymbolicLink()) {
      if (
        (await statKind(dir)) === "dir" &&
        (await taskFilesIn(dir, false)).length > 0
      ) {
        out.linkedPhases.push(entry.name);
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    const files = await taskFilesIn(dir, false);
    if (files.length === 0) continue;
    out.phases.push(entry.name);
    for (const file of files) {
      const read = await readTaskFile(file, false, entry.name);
      if (isTask(read)) out.tasks.push(read);
      else out.malformed.push(read);
    }
  }

  for (const file of await taskFilesIn(
    path.join(tasksDir, ARCHIVE_DIRNAME),
    true,
  )) {
    const read = await readTaskFile(file, true, null);
    if (isTask(read)) out.archived.push(read);
    else out.malformed.push(read);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* References                                                               */
/* ------------------------------------------------------------------------ */

export type V1Reference =
  | { kind: "local"; id: string }
  | { kind: "external"; projectPath: string; id: string };

/**
 * A `depends_on` entry as v1 read it: a bare id, or `<project-path>:<id>`
 * split on the last colon, never an absolute path. `null` for an entry v1
 * would have rejected.
 */
export function parseV1Reference(raw: string): V1Reference | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const sep = trimmed.lastIndexOf(":");
  if (sep === -1) {
    return V1_ID_PATTERN.test(trimmed) ? { kind: "local", id: trimmed } : null;
  }
  const projectPath = trimmed.slice(0, sep);
  const id = trimmed.slice(sep + 1);
  if (projectPath.length === 0 || !V1_ID_PATTERN.test(id)) return null;
  if (path.isAbsolute(projectPath) || /^[A-Za-z]:[\\/]/.test(projectPath)) {
    return null;
  }
  return { kind: "external", projectPath, id };
}

/* ------------------------------------------------------------------------ */
/* Scaffold                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The `README.md` that v1's `tasks init` wrote, byte for byte. `migrate`
 * replaces a README only while it is still exactly this text.
 */
export function v1ReadmeTemplate(): string {
  return `# Tasks

This directory is a local, git-versioned task tracker. It is managed by the
\`tasks\` CLI. Task files are plain markdown and safe to read directly; prefer
the CLI for any change, because it enforces the rules below.

## Layout

\`\`\`
.tasks/
  config.yml      project config (statuses, roles, active_phase)
  README.md       this file
  _index.md       generated overview — regenerate with \`tasks reindex\`
  <phase>/        a phase directory, e.g. auth-rework/ or 2026-q1/
    <id>.md       one task
  .archive/       soft-deleted tasks, excluded from all default queries
\`\`\`

## For an agent starting work

\`\`\`sh
tasks ready --json       # what is unblocked right now
tasks claim <id>         # take it (fails if someone already has it)
# ...do the work...
tasks status <id> DONE   # complete it
\`\`\`

Every read command accepts \`--json\`. Errors are JSON on stderr under
\`--json\`, and exit codes are meaningful: 0 success, 2 usage, 3 not found,
4 state conflict. Branch on the exit code, not on message text.

## Rules the CLI enforces

- **Status transitions.** By default a task moves forward or back exactly one
  status at a time, so nothing jumps straight to done without being worked.
- **Dependencies.** \`depends_on\` lists task ids. A task is only "ready" when
  every dependency is done. Missing, archived, and cyclic dependencies all
  count as blocking, never as satisfied.
- **Ids are globally unique** across this directory, including \`.archive/\`.
- **The directory owns a task's phase**; use \`tasks move\` rather than \`mv\`.

## Frontmatter

The YAML block at the top of each task is machine-owned — the CLI rewrites it
in canonical form and does not preserve comments there. The markdown body below
it is yours: edit it freely. If frontmatter is hand-edited into an inconsistent
state, \`tasks validate\` reports it and \`tasks validate --fix\` repairs the
mechanically safe parts.
`;
}
