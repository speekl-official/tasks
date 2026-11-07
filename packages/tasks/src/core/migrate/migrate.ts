import fs from "node:fs/promises";
import path from "node:path";

import type { CommandContext } from "../../context.js";
import { TaskError, isTaskError } from "../../errors.js";
import { defaultConfig, detectTreeVersion, renderConfig } from "../config.js";
import type { Project } from "../discovery.js";
import { findProject } from "../discovery.js";
import { renderTaskFile } from "../frontmatter.js";
import { errnoCode, isDirectory, writeFileAtomic } from "../fs-utils.js";
import { GATE_FIELDS, GateResolver } from "../gates.js";
import {
  isSegment,
  isTaskPath,
  nameOf,
  qualifyId,
  safeParseReference,
} from "../ids.js";
import { writeIndex } from "../index-md.js";
import { withTreeLock } from "../lock.js";
import { withMutation } from "../mutate.js";
import type { LoadedTree } from "../projects.js";
import { Projects } from "../projects.js";
import { snapshotTree } from "../snapshot.js";
import type { Task } from "../task.js";
import { readmeTemplate } from "../templates.js";
import { isIsoTimestamp } from "../time.js";
import type { Tree } from "../tree.js";
import { loadTree, writeTask } from "../tree.js";
import type {
  Frontmatter,
  GateField,
  RewrittenRefJson,
  Status,
  UnrewrittenRefJson,
} from "../types.js";
import {
  ACTOR_PATTERN,
  ARCHIVE_DIRNAME,
  CONFIG_FILENAME,
  CONVENTION_VERSION,
  DEFAULT_PRIORITY,
  FRONTMATTER_KEYS,
  INDEX_FILENAME,
  README_FILENAME,
  SEGMENT_PATTERN,
  STATUSES,
  TASKS_DIRNAME,
  TASK_FILENAME,
  isStatus,
} from "../types.js";
import type { V1Config, V1RoleName, V1Task, V1Tasks } from "./v1.js";
import {
  V1_INDEX_FILENAME,
  V1_PHASE_PATTERN,
  V1_ROLE_NAMES,
  V1_TASK_KEYS,
  parseV1Reference,
  readV1Config,
  readV1Tasks,
  v1ReadmeTemplate,
} from "./v1.js";

/**
 * The one-time upgrade of a v1 tree, in two parts. `migrateTree` performs the
 * seven steps of the convention under the migrated tree's lock: it reads the
 * whole v1 tree, computes every file it will write, refuses with one usage
 * error listing every problem before anything is written, then converts the
 * tasks, rewrites `config.yml` last (the version flip is the commit point)
 * and generates `index.md`. `rewriteReferencesInto` then repairs the bare-id
 * references other trees hold into the migrated tree, one tree at a time
 * under each tree's own lock, and lists those it can read but not write.
 *
 * Nothing is appended to any log: a v1 task's history is the `## Notes` of
 * its body, which travels with it unchanged.
 */

/* ------------------------------------------------------------------------ */
/* Options                                                                  */
/* ------------------------------------------------------------------------ */

export interface MigrateOptions {
  /** `--map OLD=NEW`: the v2 status of a v1 status. */
  statusMap: ReadonlyMap<string, Status>;
  /** `--map-phase OLD=NEW`: the v2 directory name of a v1 phase. */
  phaseMap: ReadonlyMap<string, string>;
}

export interface MigrateTreeOptions extends MigrateOptions {
  /**
   * How output names the migrated tree: `null` when it is the tree the
   * command runs in, its alias when it is a listed project.
   */
  qualifier: string | null;
}

/** NEW contains no `=` in either option, so the last one separates. */
function splitMapping(option: string, value: string): [string, string] {
  const cut = value.lastIndexOf("=");
  if (cut <= 0 || cut === value.length - 1) {
    throw TaskError.usage(`${option} expects OLD=NEW, got "${value}".`, {
      option,
      value,
    });
  }
  return [value.slice(0, cut), value.slice(cut + 1)];
}

function addMapping<T extends string>(
  map: Map<string, T>,
  option: string,
  old: string,
  next: T,
): void {
  const previous = map.get(old);
  if (previous !== undefined && previous !== next) {
    throw TaskError.usage(
      `${option} maps "${old}" twice, to ${previous} and to ${next}.`,
      { option, old, values: [previous, next] },
    );
  }
  map.set(old, next);
}

/** `--map OLD=NEW`; NEW must be one of the six v2 statuses. */
export function parseStatusMappings(
  values: readonly string[],
): Map<string, Status> {
  const map = new Map<string, Status>();
  for (const value of values) {
    const [old, next] = splitMapping("--map", value);
    if (!isStatus(next)) {
      throw TaskError.usage(
        `--map ${value}: "${next}" is not a v2 status; the statuses are ${STATUSES.join(", ")}.`,
        { option: "--map", value, statuses: [...STATUSES] },
      );
    }
    addMapping(map, "--map", old, next);
  }
  return map;
}

/** `--map-phase OLD=NEW`; NEW must be a v2 segment. */
export function parsePhaseMappings(
  values: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const value of values) {
    const [old, next] = splitMapping("--map-phase", value);
    if (!isSegment(next)) {
      throw TaskError.usage(
        `--map-phase ${value}: "${next}" is not a v2 directory name; it must match ${SEGMENT_PATTERN.source}.`,
        { option: "--map-phase", value, pattern: SEGMENT_PATTERN.source },
      );
    }
    addMapping(map, "--map-phase", old, next);
  }
  return map;
}

/* ------------------------------------------------------------------------ */
/* Results                                                                  */
/* ------------------------------------------------------------------------ */

/** What became of `README.md`: replaced only while it is v1's scaffold. */
export type ReadmeOutcome = "replaced" | "kept" | "absent";

/** What `migrate --json` prints. */
export interface MigrateJson {
  /** The `.tasks/` directory of the migrated tree. */
  tree: string;
  /** Live tasks migrated. */
  tasks: number;
  /** Archived tasks migrated. */
  archived: number;
  /** Every v1 phase, live or archived, and its v2 directory name. */
  phases: Record<string, string>;
  /** Every v1 status the migration maps, and its v2 status. */
  statuses: Record<string, Status>;
  /** References rewritten, in the migrated tree and in other trees. */
  rewritten: RewrittenRefJson[];
  /** References kept as written: they block until someone edits them. */
  unrewritten: UnrewrittenRefJson[];
  readme: ReadmeOutcome;
  /** The `scope` written to `config.yml`, from v1's `active_phase`. */
  scope: string | null;
  /** What the migration leaves for a person to know or do, in words. */
  consequences: string[];
}

export type MigrationProblem =
  | { kind: "malformed"; path: string; message: string }
  | { kind: "unmapped-phase"; phase: string; message: string }
  | {
      kind: "unmapped-status";
      status: string;
      paths: string[];
      message: string;
    }
  | {
      kind: "unknown-mapping";
      option: "--map" | "--map-phase";
      old: string;
      message: string;
    }
  | {
      kind: "invalid-value";
      path: string;
      field: string;
      value: unknown;
      message: string;
    }
  | {
      kind: "claim-fields";
      path: string;
      status: Status;
      claimed_by: string | null;
      claimed_at: string | null;
      message: string;
    }
  | { kind: "duplicate-id"; id: string; paths: string[]; message: string }
  | { kind: "collision"; path: string; paths: string[]; message: string };

/** The outcome of `migrateTree`, before references from other trees. */
export interface Migration {
  /** The migrated tree, rooted at the realpath of its project root. */
  project: Project;
  qualifier: string | null;
  /**
   * v1 id → v2 id (relative to `.tasks/` or to `.archive/`); for a renamed
   * phase, `<old phase>/<id>` → v2 id as well.
   */
  ids: ReadonlyMap<string, string>;
  tasks: number;
  archived: number;
  phases: Record<string, string>;
  statuses: Record<string, Status>;
  /** The migrated tree's own references, live tasks only. */
  rewritten: RewrittenRefJson[];
  unrewritten: UnrewrittenRefJson[];
  readme: ReadmeOutcome;
  scope: string | null;
  /** v1's `active_phase` when it named no phase directory, else `null`. */
  droppedScope: string | null;
  /** v1's `_index.md` existed and was removed. */
  legacyIndex: boolean;
  /** Live tasks now `IN_PROGRESS`: their claims have no session. */
  inProgress: string[];
  /** Live tasks now `PAUSED`: none has a `state.md` yet. */
  paused: string[];
}

/** References into the migrated tree that other trees hold. */
export interface ReferencesInto {
  rewritten: RewrittenRefJson[];
  unrewritten: UnrewrittenRefJson[];
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

/** The keys v2 defines and v1 did not: the migration sets them itself. */
const V2_ONLY_KEYS: ReadonlySet<string> = new Set(
  FRONTMATTER_KEYS.filter((key) => !V1_TASK_KEYS.includes(key)),
);

const ROLE_STATUS: Record<V1RoleName, Status> = {
  ready: "TODO",
  claimed: "IN_PROGRESS",
  done: "DONE",
};

async function realpathOr(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function lstatOrNull(
  target: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/** Two spellings of one entry, as a case-insensitive filesystem has them. */
async function sameEntry(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([lstatOrNull(a), lstatOrNull(b)]);
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

/** A regular file's text, or `null` when there is no regular file. */
async function readRegularFile(file: string): Promise<string | null> {
  const stat = await lstatOrNull(file);
  if (stat === null || !stat.isFile()) return null;
  return fs.readFile(file, "utf8");
}

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const list = out.get(name);
    if (list === undefined) out.set(name, [item]);
    else list.push(item);
  }
  return out;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------------ */
/* The version gate                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Refuse a tree that is not v1, before anything touches it: a v2 tree has
 * nothing to migrate, and a tree of an unsupported version must not even be
 * locked.
 */
export async function assertV1Tree(project: Project): Promise<void> {
  const detected = await detectTreeVersion(project.tasksDir);
  if (detected.kind === "v1") return;
  if (detected.kind === "v2") {
    throw TaskError.usage(
      `${project.tasksDir} is already a .tasks v${CONVENTION_VERSION} tree; there is nothing to migrate.`,
      { tasksDir: project.tasksDir, version: CONVENTION_VERSION },
    );
  }
  throw TaskError.usage(
    `${path.join(project.tasksDir, CONFIG_FILENAME)}: version ${detected.version} is not supported; migrate upgrades a .tasks v1 tree to v${CONVENTION_VERSION}.`,
    { tasksDir: project.tasksDir, version: detected.version },
  );
}

/* ------------------------------------------------------------------------ */
/* References out of the migrated tree                                      */
/* ------------------------------------------------------------------------ */

/** The v2 id a bare v1 id takes in some tree, or `null` when unknown. */
type Lookup = (id: string) => string | null;

/** The one candidate, or `null` for none or several. */
function only(ids: readonly string[]): string | null {
  return ids.length === 1 ? ids[0]! : null;
}

/** A v1 target holds the id as `<phase>/<id>.md`, live first. */
function v1Lookup(v1: V1Tasks): Lookup {
  const live = groupBy(v1.tasks, (task) => task.id);
  const archived = groupBy(v1.archived, (task) => task.id);
  return (id) => {
    const hits = live.get(id) ?? archived.get(id) ?? [];
    if (hits.length !== 1) return null;
    // A phase that its own migration must rename has no v2 name yet.
    const phase = hits[0]!.phase;
    return isSegment(phase) ? `${phase}/${id}` : null;
  };
}

/** A v2 target holds the id as the name of exactly one task, live first. */
function v2Lookup(tree: Tree): Lookup {
  const named = (ids: readonly string[], id: string) =>
    ids.filter((candidate) => nameOf(candidate) === id);
  const live = [
    ...tree.tasks.map((task) => task.id),
    ...tree.malformed.map((entry) => entry.id).filter((id) => id !== ""),
  ];
  const archived = [
    ...tree.archived.map((task) => task.id),
    ...tree.archivedMalformed
      .map((entry) => entry.id)
      .filter((id) => id !== ""),
  ];
  return (id) => {
    const hits = named(live, id);
    return hits.length > 0 ? only(hits) : only(named(archived, id));
  };
}

/**
 * Where the migrated tree's references lead. Paths resolve from its project
 * root through discovery, as v2 will resolve them; each tree is read once.
 */
class ReferenceRewriter {
  private readonly lookups = new Map<string, Promise<Lookup | null>>();

  constructor(
    private readonly root: string,
    private readonly own: ReadonlyMap<string, string>,
  ) {}

  /** The reference in v2 form, or `null` when it is kept as written. */
  async rewrite(raw: string): Promise<string | null> {
    const ref = parseV1Reference(raw);
    if (ref === null) return null;
    if (ref.kind === "local") return this.own.get(ref.id) ?? null;

    let lookup = this.lookups.get(ref.projectPath);
    if (lookup === undefined) {
      lookup = this.lookupFor(ref.projectPath);
      this.lookups.set(ref.projectPath, lookup);
    }
    const next = (await lookup)?.(ref.id) ?? null;
    if (next === null) return null;
    const stored = `${ref.projectPath}:${next}`;
    return safeParseReference(stored).ok ? stored : null;
  }

  /** A tree that cannot be read is unreachable: its references are kept. */
  private async lookupFor(projectPath: string): Promise<Lookup | null> {
    const found = await findProject(path.resolve(this.root, projectPath));
    if (found === null) return null;
    const root = await realpathOr(found.root);
    if (root === this.root) return (id) => this.own.get(id) ?? null;

    const tasksDir = path.join(root, TASKS_DIRNAME);
    try {
      const version = await detectTreeVersion(tasksDir);
      if (version.kind === "v1") return v1Lookup(await readV1Tasks(tasksDir));
      if (version.kind === "v2") {
        const project = { root, tasksDir };
        return v2Lookup(await loadTree(project, { config: version.config }));
      }
      return null;
    } catch (err) {
      if (isTaskError(err) || errnoCode(err) !== undefined) return null;
      throw err;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* The plan                                                                 */
/* ------------------------------------------------------------------------ */

interface FileWrite {
  /** The v1 file, where it lies once the phase directories are renamed. */
  from: string;
  /** The `task.md` it becomes. */
  to: string;
  content: string;
}

interface Plan {
  renames: Array<{ from: string; to: string }>;
  writes: FileWrite[];
  migration: Migration;
}

/** Everything about one tree the planner needs, read inside the lock. */
interface Source {
  project: Project;
  config: V1Config;
  v1: V1Tasks;
  options: MigrateTreeOptions;
}

class Planner {
  readonly problems: MigrationProblem[] = [];
  private readonly tasksDir: string;
  private readonly all: V1Task[];

  constructor(private readonly source: Source) {
    this.tasksDir = source.project.tasksDir;
    this.all = [...source.v1.tasks, ...source.v1.archived];
  }

  /** A path as messages show it: relative to the project root, posix. */
  shown(target: string): string {
    return path
      .relative(this.source.project.root, target)
      .split(path.sep)
      .join("/");
  }

  phaseOf(phase: string): string {
    return this.source.options.phaseMap.get(phase) ?? phase;
  }

  /** Every phase, live or archived, in name order. */
  phases(): string[] {
    const { v1 } = this.source;
    return [
      ...new Set([...v1.phases, ...v1.archived.map((task) => task.phase)]),
    ].sort();
  }

  checkFiles(): void {
    const { v1 } = this.source;
    for (const entry of v1.malformed) {
      this.problems.push({
        kind: "malformed",
        path: entry.file,
        message: `${this.shown(entry.file)} does not parse as a v1 task: ${entry.message}`,
      });
    }
    for (const name of v1.linkedPhases) {
      const link = path.join(this.tasksDir, name);
      this.problems.push({
        kind: "malformed",
        path: link,
        message: `${this.shown(link)} is a symbolic link to a phase directory; v2 never follows a linked directory, so its tasks would be lost: replace the link with the directory`,
      });
    }
  }

  async checkPhases(): Promise<Array<{ from: string; to: string }>> {
    const phases = this.phases();
    const { phaseMap } = this.source.options;

    for (const old of phaseMap.keys()) {
      if (phases.includes(old)) continue;
      this.problems.push({
        kind: "unknown-mapping",
        option: "--map-phase",
        old,
        message: `--map-phase names "${old}", which is not a phase of this tree (its phases: ${phases.join(", ") || "none"})`,
      });
    }

    for (const phase of phases) {
      if (phaseMap.has(phase) || isSegment(phase)) continue;
      const hint = V1_PHASE_PATTERN.test(phase)
        ? "; v1 allowed . and _ in a phase name, v2 does not"
        : "";
      this.problems.push({
        kind: "unmapped-phase",
        phase,
        message: `phase "${phase}" is not a v2 directory name (${SEGMENT_PATTERN.source})${hint}: rename it with --map-phase ${phase}=<name>`,
      });
    }

    // A migration converts phases one for one; merging them is `move`'s job.
    const owner = new Map<string, string>();
    const merged = new Set<string>();
    for (const phase of phases) {
      const next = this.phaseOf(phase);
      const other = owner.get(next);
      if (other === undefined) {
        owner.set(next, phase);
        continue;
      }
      merged.add(next);
      this.problems.push({
        kind: "collision",
        path: path.join(this.tasksDir, next),
        paths: [],
        message: `phases "${other}" and "${phase}" would both become "${next}"; a migration does not merge phases (\`tasks move\` can, afterwards)`,
      });
    }

    const renames: Array<{ from: string; to: string }> = [];
    for (const phase of this.source.v1.phases) {
      const next = this.phaseOf(phase);
      if (next === phase) continue;
      renames.push({ from: phase, to: next });
      if (merged.has(next)) continue;
      const from = path.join(this.tasksDir, phase);
      const to = path.join(this.tasksDir, next);
      if ((await lstatOrNull(to)) !== null && !(await sameEntry(from, to))) {
        this.problems.push({
          kind: "collision",
          path: to,
          paths: [from],
          message: `--map-phase ${phase}=${next}: ${this.shown(to)} already exists`,
        });
      }
    }
    return renames;
  }

  checkIds(): void {
    for (const task of this.all) {
      if (isSegment(task.id)) continue;
      this.problems.push({
        kind: "invalid-value",
        path: task.file,
        field: "id",
        value: task.id,
        message: `${this.shown(task.file)}: id "${task.id}" is not a v2 directory name (${SEGMENT_PATTERN.source}); rename the task in the v1 file and in the references to it`,
      });
    }
    const { v1 } = this.source;
    for (const [group, label] of [
      [v1.tasks, "live"],
      [v1.archived, "archived"],
    ] as const) {
      for (const [id, list] of groupBy(group, (task) => task.id)) {
        if (list.length < 2) continue;
        this.problems.push({
          kind: "duplicate-id",
          id,
          paths: list.map((task) => task.file),
          message: `${list.length} ${label} v1 tasks declare the id "${id}" (${list.map((task) => this.shown(task.file)).join(", ")}), which v1 required to be unique: keep one`,
        });
      }
    }
  }

  /** The status function, after recording the statuses it cannot map. */
  checkStatuses(): (status: string) => Status | undefined {
    const { config, options } = this.source;
    const targets = new Map<string, Set<Status>>();
    for (const role of V1_ROLE_NAMES) {
      const status = config.roles[role];
      const set = targets.get(status) ?? new Set<Status>();
      set.add(ROLE_STATUS[role]);
      targets.set(status, set);
    }
    // One v1 status can carry two roles (two statuses, default roles): its
    // v2 status is then a person's call.
    const byRole = new Map<string, Status>();
    for (const [status, set] of targets) {
      if (set.size === 1) byRole.set(status, [...set][0]!);
    }
    const statusOf = (status: string): Status | undefined =>
      options.statusMap.get(status) ?? byRole.get(status);

    const used = new Set(this.all.map((task) => task.status));
    for (const old of options.statusMap.keys()) {
      if (used.has(old) || config.statuses.includes(old)) continue;
      this.problems.push({
        kind: "unknown-mapping",
        option: "--map",
        old,
        message: `--map names "${old}", which no task uses and config.yml does not declare (its statuses: ${config.statuses.join(", ")})`,
      });
    }

    const roles = V1_ROLE_NAMES.map(
      (role) => `${role} ${config.roles[role]} → ${ROLE_STATUS[role]}`,
    ).join(", ");
    const unmapped = groupBy(
      this.all.filter((task) => statusOf(task.status) === undefined),
      (task) => task.status,
    );
    for (const [status, list] of unmapped) {
      const why = targets.has(status)
        ? `is the status of several v1 roles (${roles}), so its v2 status is ambiguous`
        : `is outside the roles mapping (${roles})`;
      this.problems.push({
        kind: "unmapped-status",
        status,
        paths: list.map((task) => task.file),
        message: `status "${status}" of ${list.map((task) => this.shown(task.file)).join(", ")} ${why}: map it with --map ${status}=<status>, one of ${STATUSES.join(", ")}`,
      });
    }
    return statusOf;
  }

  /** Values v2 cannot hold, and claims that disagree with the new status. */
  checkValues(statusOf: (status: string) => Status | undefined): void {
    for (const task of this.all) {
      const where = this.shown(task.file);
      const invalid = (field: string, value: unknown, why: string) =>
        this.problems.push({
          kind: "invalid-value",
          path: task.file,
          field,
          value,
          message: `${where}: ${why}`,
        });

      if (task.claimed_by !== null && !ACTOR_PATTERN.test(task.claimed_by)) {
        invalid(
          "claimed_by",
          task.claimed_by,
          `claimed_by "${task.claimed_by}" does not match the actor pattern ${ACTOR_PATTERN.source}; correct it in the v1 file`,
        );
      }
      for (const field of ["created", "updated", "claimed_at"] as const) {
        const value = task[field];
        if (value === null || isIsoTimestamp(value)) continue;
        invalid(
          field,
          value,
          `${field} "${value}" is not an ISO 8601 UTC timestamp at second precision such as 2026-09-21T09:14:00Z; correct it in the v1 file`,
        );
      }
      for (const [key, value] of task.extra) {
        if (!V2_ONLY_KEYS.has(key)) continue;
        invalid(
          key,
          value,
          `the key "${key}" is not a v1 key, and v2 defines it; remove it from the v1 file (the migration sets ${key} itself)`,
        );
      }

      const status = statusOf(task.status);
      if (status === undefined) continue;
      const claimed = task.claimed_by !== null && task.claimed_at !== null;
      const unclaimed = task.claimed_by === null && task.claimed_at === null;
      if (status === "IN_PROGRESS" ? claimed : unclaimed) continue;
      this.problems.push({
        kind: "claim-fields",
        path: task.file,
        status,
        claimed_by: task.claimed_by,
        claimed_at: task.claimed_at,
        message:
          status === "IN_PROGRESS"
            ? `${where}: ${task.status} maps to IN_PROGRESS, which records who claimed the task and when, but claimed_by or claimed_at is null; set both in the v1 file, or map ${task.status} to another status`
            : `${where}: ${task.status} maps to ${status}, but claimed_by or claimed_at is set, and v2 records a claim only on an IN_PROGRESS task; clear them in the v1 file`,
      });
    }
  }

  /** Every destination is free, and `index.md` is not taken. */
  async checkDestinations(): Promise<void> {
    const { v1 } = this.source;
    const live = new Map<string, V1Task>();
    for (const task of v1.tasks) {
      const phase = this.phaseOf(task.phase);
      if (!isSegment(phase) || !isSegment(task.id)) continue;
      live.set(`${phase}/${task.id}`, task);
      // Before its phase directory is renamed, the task directory would sit
      // in the old one.
      const existing = path.join(this.tasksDir, task.phase, task.id);
      if ((await lstatOrNull(existing)) !== null) {
        this.problems.push({
          kind: "collision",
          path: existing,
          paths: [task.file],
          message: `${this.shown(task.file)} would become ${phase}/${task.id}/${TASK_FILENAME}, but ${this.shown(existing)} already exists`,
        });
      }
    }

    for (const task of v1.archived) {
      const phase = this.phaseOf(task.phase);
      if (!isSegment(phase) || !isSegment(task.id)) continue;
      const id = `${phase}/${task.id}`;
      const dest = path.join(this.tasksDir, ARCHIVE_DIRNAME, phase, task.id);
      if ((await lstatOrNull(dest)) !== null) {
        this.problems.push({
          kind: "collision",
          path: dest,
          paths: [task.file],
          message: `${this.shown(task.file)} would become ${this.shown(dest)}/${TASK_FILENAME}, but ${this.shown(dest)} already exists`,
        });
      }
      const twin = live.get(id);
      if (twin !== undefined) {
        this.problems.push({
          kind: "collision",
          path: dest,
          paths: [twin.file, task.file],
          message: `${this.shown(task.file)} would be archived at ${id}, the path of the live task from ${this.shown(twin.file)}, and v2 reserves an archived task's path`,
        });
      }
    }

    const index = path.join(this.tasksDir, INDEX_FILENAME);
    if ((await lstatOrNull(index)) !== null) {
      this.problems.push({
        kind: "collision",
        path: index,
        paths: [],
        message: `${this.shown(index)} exists, and v2 reserves that name for the generated overview: rename it first`,
      });
    }
  }

  refusal(): TaskError {
    const lines = this.problems.map((problem) => `  - ${problem.message}`);
    return TaskError.usage(
      `Cannot migrate ${this.tasksDir} to .tasks v${CONVENTION_VERSION}; nothing was written. Fix these first:\n${lines.join("\n")}`,
      { tasksDir: this.tasksDir, problems: this.problems },
    );
  }

  /**
   * Every status the migration maps, through a role or a `--map`, in the
   * order of the v1 status list; `statusOf` knows no other status.
   */
  statusTable(statusOf: (status: string) => Status | undefined) {
    const out: Record<string, Status> = {};
    for (const key of [
      ...this.source.config.statuses,
      ...this.source.options.statusMap.keys(),
    ]) {
      const target = statusOf(key);
      if (target !== undefined && !Object.hasOwn(out, key)) out[key] = target;
    }
    return out;
  }

  /**
   * v1 id → v2 id, live tasks first: v1 resolved a bare id that way. A task
   * whose phase is renamed is also found by `<old phase>/<id>`: that is how
   * an earlier migration of another tree resolved a reference into this one
   * while it was still v1, and such a reference follows the rename too.
   */
  idMap(): Map<string, string> {
    const ids = new Map<string, string>();
    for (const task of this.all) {
      const next = `${this.phaseOf(task.phase)}/${task.id}`;
      const old = `${task.phase}/${task.id}`;
      if (!ids.has(task.id)) ids.set(task.id, next);
      if (old !== next && isTaskPath(old) && !ids.has(old)) ids.set(old, next);
    }
    return ids;
  }

  async scope(): Promise<{ scope: string | null; dropped: string | null }> {
    const active = this.source.config.activePhase;
    if (active === null) return { scope: null, dropped: null };
    const next = this.phaseOf(active);
    const exists =
      this.source.v1.phases.includes(active) ||
      (isSegment(active) &&
        (await isDirectory(path.join(this.tasksDir, active))));
    return exists && isSegment(next)
      ? { scope: next, dropped: null }
      : { scope: null, dropped: active };
  }

  async readme(): Promise<ReadmeOutcome> {
    const file = path.join(this.tasksDir, README_FILENAME);
    const text = await readRegularFile(file);
    if (text === null) {
      return (await lstatOrNull(file)) === null ? "absent" : "kept";
    }
    // A CRLF checkout of the scaffold is still the scaffold.
    return text.replace(/\r\n/g, "\n") === v1ReadmeTemplate()
      ? "replaced"
      : "kept";
  }
}

async function plan(source: Source): Promise<Plan> {
  const { project, v1, options } = source;
  const planner = new Planner(source);

  planner.checkFiles();
  const renames = await planner.checkPhases();
  planner.checkIds();
  const statusOf = planner.checkStatuses();
  planner.checkValues(statusOf);
  await planner.checkDestinations();
  if (planner.problems.length > 0) throw planner.refusal();

  const ids = planner.idMap();
  const rewriter = new ReferenceRewriter(project.root, ids);
  const writes: FileWrite[] = [];
  const rewritten: RewrittenRefJson[] = [];
  const unrewritten: UnrewrittenRefJson[] = [];
  const inProgress: string[] = [];
  const paused: string[] = [];

  for (const task of [...v1.tasks, ...v1.archived]) {
    const phase = planner.phaseOf(task.phase);
    const id = `${phase}/${task.id}`;
    const status = statusOf(task.status)!;

    const depends_on: string[] = [];
    for (const raw of task.depends_on) {
      const next = await rewriter.rewrite(raw);
      depends_on.push(next ?? raw);
      // Archived tasks take part in no gate: their references are converted
      // alike, but only a live task's are worth a line of output.
      if (task.archived) continue;
      const site = {
        project: options.qualifier,
        task: id,
        field: "depends_on" as const,
      };
      if (next === null) unrewritten.push({ ...site, ref: raw });
      else if (next !== raw) rewritten.push({ ...site, from: raw, to: next });
    }

    const frontmatter: Frontmatter = {
      status,
      priority: DEFAULT_PRIORITY,
      depends_on,
      finishes_after: [],
      assignee: null,
      claimed_by: task.claimed_by,
      claimed_at: task.claimed_at,
      claimed_session: null,
      created: task.created,
      updated: task.updated,
    };
    let content: string;
    try {
      content = renderTaskFile(frontmatter, task.extra, task.body);
    } catch (err) {
      if (!isTaskError(err)) throw err;
      planner.problems.push({
        kind: "malformed",
        path: task.file,
        message: `${planner.shown(task.file)} cannot be written as a v2 manifest: ${err.message}`,
      });
      continue;
    }

    const base = task.archived
      ? path.join(project.tasksDir, ARCHIVE_DIRNAME)
      : project.tasksDir;
    writes.push({
      from: task.archived
        ? task.file
        : path.join(project.tasksDir, phase, path.basename(task.file)),
      to: path.join(base, phase, task.id, TASK_FILENAME),
      content,
    });
    if (!task.archived && status === "IN_PROGRESS") inProgress.push(id);
    if (!task.archived && status === "PAUSED") paused.push(id);
  }
  if (planner.problems.length > 0) throw planner.refusal();

  const phases: Record<string, string> = {};
  for (const phase of planner.phases()) phases[phase] = planner.phaseOf(phase);
  const { scope, dropped } = await planner.scope();
  const legacy = await lstatOrNull(
    path.join(project.tasksDir, V1_INDEX_FILENAME),
  );

  return {
    renames,
    writes,
    migration: {
      project,
      qualifier: options.qualifier,
      ids,
      tasks: v1.tasks.length,
      archived: v1.archived.length,
      phases,
      statuses: planner.statusTable(statusOf),
      rewritten,
      unrewritten,
      readme: await planner.readme(),
      scope,
      droppedScope: dropped,
      legacyIndex: legacy !== null && legacy.isFile(),
      inProgress,
      paused,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Performing it                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Write in an order a crash cannot turn into a v2 tree missing tasks: the
 * tasks first, while `config.yml` still says v1 and every v2 command refuses
 * the tree; then the files beside them; `config.yml` last; `index.md` from
 * the tree as v2 reads it.
 */
async function perform(project: Project, planned: Plan): Promise<void> {
  const { tasksDir } = project;
  const { migration } = planned;

  // Renamed whole, so whatever else a phase directory holds moves with it.
  for (const { from, to } of planned.renames) {
    await fs.rename(path.join(tasksDir, from), path.join(tasksDir, to));
  }
  for (const write of planned.writes) {
    await writeFileAtomic(write.to, write.content);
    await fs.rm(write.from, { force: true });
  }

  if (migration.readme === "replaced") {
    await writeFileAtomic(
      path.join(tasksDir, README_FILENAME),
      readmeTemplate(),
    );
  }
  if (migration.legacyIndex) {
    await fs.rm(path.join(tasksDir, V1_INDEX_FILENAME), { force: true });
  }

  const config = defaultConfig();
  config.scope = migration.scope;
  await writeFileAtomic(
    path.join(tasksDir, CONFIG_FILENAME),
    renderConfig(config),
  );

  await generateIndex(project);
}

/**
 * `index.md` as the migrated tree sees itself: rendered from an
 * actor-independent derivation with the tree as the local one, so its
 * references into other trees read as the tree stores them.
 */
async function generateIndex(project: Project): Promise<void> {
  const tree = await loadTree(project);
  const projects = new Projects(tree);
  const gates = new GateResolver(projects);
  const { derived } = await snapshotTree(
    { projects, gates },
    projects.local,
    null,
  );
  await writeIndex(tree, derived);
}

/**
 * Migrate the v1 tree of `target`, once: plan everything from the tree as
 * read inside its lock, refuse with every problem listed before anything is
 * written, then perform the seven steps.
 */
export async function migrateTree(
  target: Project,
  options: MigrateTreeOptions,
): Promise<Migration> {
  await assertV1Tree(target);
  // Every tree has one identity, its realpath, as `Projects` keys them.
  const root = await realpathOr(target.root);
  const project: Project = { root, tasksDir: path.join(root, TASKS_DIRNAME) };

  return withTreeLock(project.tasksDir, async () => {
    // Another migrate may have finished between the check and the lock.
    await assertV1Tree(project);
    const config = await readV1Config(project.tasksDir);
    const v1 = await readV1Tasks(project.tasksDir);
    const planned = await plan({ project, config, v1, options });
    await perform(project, planned);
    return planned.migration;
  });
}

/* ------------------------------------------------------------------------ */
/* References into the migrated tree                                        */
/* ------------------------------------------------------------------------ */

interface IntoSite {
  task: Task;
  field: GateField;
  index: number;
  ref: string;
  to: string;
}

/**
 * The live references of one tree that still name a task of the migrated
 * tree as v1 knew it: `<path>:<id>`, where the path leads to the migrated
 * tree and the id is one it held, or `<path>:<old phase>/<id>` for a phase
 * the migration renamed.
 */
async function referencesInto(
  projects: Projects,
  holder: LoadedTree,
  migration: Migration,
): Promise<IntoSite[]> {
  const out: IntoSite[] = [];
  for (const task of holder.tree.tasks) {
    for (const field of GATE_FIELDS) {
      const refs = task.frontmatter[field];
      for (let index = 0; index < refs.length; index += 1) {
        const ref = refs[index]!;
        const parsed = safeParseReference(ref);
        if (!parsed.ok || parsed.ref.kind !== "external") continue;
        const next = migration.ids.get(parsed.ref.path);
        if (next === undefined) continue;
        let target;
        try {
          target = await projects.byPath(holder, parsed.ref.projectPath);
        } catch (err) {
          if (isTaskError(err)) continue;
          throw err;
        }
        if (target.kind !== "ok" || target.key !== migration.project.root) {
          continue;
        }
        out.push({
          task,
          field,
          index,
          ref,
          to: `${parsed.ref.projectPath}:${next}`,
        });
      }
    }
  }
  return out;
}

/** Rewrite one tree's references into the migrated tree, inside its lock. */
async function rewriteIn(
  context: CommandContext,
  load: LoadedTree,
  migration: Migration,
): Promise<RewrittenRefJson[]> {
  const project = context.projects.qualifier(load);
  return withMutation(context, load, async (fresh) => {
    const sites = await referencesInto(context.projects, fresh.load, migration);
    const done: RewrittenRefJson[] = [];
    for (const [, list] of groupBy(sites, (site) => site.task.id)) {
      const task = list[0]!.task;
      const frontmatter: Frontmatter = {
        ...task.frontmatter,
        depends_on: [...task.frontmatter.depends_on],
        finishes_after: [...task.frontmatter.finishes_after],
        updated: fresh.now,
      };
      for (const site of list) {
        frontmatter[site.field][site.index] = site.to;
        done.push({
          project,
          task: task.id,
          field: site.field,
          from: site.ref,
          to: site.to,
        });
      }
      await writeTask({ ...task, frontmatter });
    }
    return done;
  });
}

/**
 * Bare-id references into the migrated tree held by other trees: rewritten
 * in the tree the command runs in and in every tree it lists, one tree at a
 * time under that tree's lock; listed when they sit in a tree that can be
 * read but not written (reached by a bare path from a tree the command can
 * see). A v1 tree is left alone: its own migration resolves references into
 * a v2 tree by the task's name.
 */
export async function rewriteReferencesInto(
  context: CommandContext,
  migration: Migration,
): Promise<ReferencesInto> {
  const { projects } = context;
  const rewritten: RewrittenRefJson[] = [];

  for (const load of await projects.writableTrees()) {
    if (load.key === migration.project.root) continue;
    const pending = await referencesInto(projects, load, migration);
    // The local overview follows a write into a listed tree; a listed tree
    // is written only when it holds something to rewrite.
    if (pending.length === 0 && !load.local) continue;
    rewritten.push(...(await rewriteIn(context, load, migration)));
  }

  const holders = await projects.writableTrees();
  const readOnly = new Map<string, LoadedTree>();
  for (const holder of holders) {
    for (const task of holder.tree.tasks) {
      for (const field of GATE_FIELDS) {
        for (const ref of task.frontmatter[field]) {
          const parsed = safeParseReference(ref);
          if (!parsed.ok || parsed.ref.kind !== "external") continue;
          let target;
          try {
            target = await projects.byPath(holder, parsed.ref.projectPath);
          } catch (err) {
            if (isTaskError(err)) continue;
            throw err;
          }
          if (
            target.kind === "ok" &&
            !target.writable &&
            target.key !== migration.project.root
          ) {
            readOnly.set(target.key, target);
          }
        }
      }
    }
  }

  const unrewritten: UnrewrittenRefJson[] = [];
  for (const load of readOnly.values()) {
    for (const site of await referencesInto(projects, load, migration)) {
      unrewritten.push({
        project: projects.qualifier(load),
        task: site.task.id,
        field: site.field,
        ref: site.ref,
      });
    }
  }
  return { rewritten, unrewritten };
}

/* ------------------------------------------------------------------------ */
/* Output                                                                   */
/* ------------------------------------------------------------------------ */

/** The printed consequences, in the order a person should read them. */
function consequencesOf(
  migration: Migration,
  unrewritten: readonly UnrewrittenRefJson[],
): string[] {
  const qualify = (id: string) => qualifyId(migration.qualifier, id);
  const out: string[] = [];
  if (migration.inProgress.length > 0) {
    out.push(
      `IN_PROGRESS with claimed_session: null, so the liveness of each claim is unknown and a claimant that runs with a session token recovers it only with --force: ${migration.inProgress.map(qualify).join(", ")}`,
    );
  }
  if (migration.paused.length > 0) {
    out.push(
      `PAUSED without a state.md, which validation reports until one is written (\`tasks state <task>\`): ${migration.paused.map(qualify).join(", ")}`,
    );
  }
  if (unrewritten.length > 0) {
    const listed = unrewritten.map(
      (ref) => `${qualifyId(ref.project, ref.task)} ${ref.field} ${ref.ref}`,
    );
    out.push(
      `kept as written, so blocking until edited (${plural(unrewritten.length, "reference")}): ${listed.join(", ")}`,
    );
  }
  if (migration.readme === "kept") {
    out.push(
      `${path.join(migration.project.tasksDir, README_FILENAME)} was edited after v1 scaffolded it, so it was kept, and it still describes v1`,
    );
  }
  if (migration.droppedScope !== null) {
    out.push(
      `no scope: active_phase "${migration.droppedScope}" names no phase directory of the tree`,
    );
  }
  return out;
}

export function migrateJson(
  migration: Migration,
  into: ReferencesInto,
): MigrateJson {
  const unrewritten = [...migration.unrewritten, ...into.unrewritten];
  return {
    tree: migration.project.tasksDir,
    tasks: migration.tasks,
    archived: migration.archived,
    phases: migration.phases,
    statuses: migration.statuses,
    rewritten: [...migration.rewritten, ...into.rewritten],
    unrewritten,
    readme: migration.readme,
    scope: migration.scope,
    consequences: consequencesOf(migration, unrewritten),
  };
}
