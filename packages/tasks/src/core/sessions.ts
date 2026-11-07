import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { TaskError } from "../errors.js";
import { errnoCode, isDirectory, writeFileAtomic } from "./fs-utils.js";
import { qualifyId } from "./ids.js";
import type { Task } from "./task.js";
import { formatIso, minutesSince } from "./time.js";
import type { Tree } from "./tree.js";
import type {
  ClaimLiveness,
  Identity,
  SessionCheckJson,
  SessionEndJson,
  SessionViolationJson,
  SessionWarningJson,
} from "./types.js";
import {
  ACTOR_ENV,
  ACTOR_PATTERN,
  LOCKS_DIRNAME,
  SESSION_ENV,
  SESSIONS_DIRNAME,
} from "./types.js";
import { lastLogEntry, stateMtime } from "./workspace.js";

/**
 * Who acts, in which run, and whether a claim is still worked: actor and
 * session resolution, the heartbeat registry under `.tasks/.locks/sessions/`,
 * claim liveness, and the exit invariant a harness checks at every stop.
 *
 * Liveness is read from file modification times with the real clock. The
 * `now` parameters exist so one command judges every claim at one instant,
 * not to inject a clock; tests age files instead.
 */

/* ------------------------------------------------------------------------ */
/* Actors and session tokens                                                */
/* ------------------------------------------------------------------------ */

const execFileAsync = promisify(execFile);

/**
 * Generous for a cold `git`, short enough that a wedged one cannot stall a
 * hook.
 */
const GIT_TIMEOUT_MS = 5_000;

const GIT_IDENTITY_KEYS = ["user.name", "user.email"] as const;

export interface IdentityOptions {
  /** `--as`: the principal. */
  as?: string | null;
  /** `--session`. */
  session?: string | null;
  /** The environment to read, also handed to `git`; `process.env` if unset. */
  env?: NodeJS.ProcessEnv;
  /** The project root: the working directory `git config` is read in. */
  projectRoot: string;
  /**
   * Receives one line per skipped source ("git user.name "Ada L" does not
   * match ..."); the CLI routes it to stderr.
   */
  diagnose?: (message: string) => void;
}

export type OperatorOptions = Omit<IdentityOptions, "as" | "session">;

function patternError(label: string, value: string, what: string): TaskError {
  return TaskError.usage(
    `Invalid ${label} ${JSON.stringify(value)}: ${what} must match ${ACTOR_PATTERN.source} (letters, digits and . _ @ + -, no spaces).`,
    { field: label, value, pattern: ACTOR_PATTERN.source },
  );
}

/** `value` when it is a valid actor; a usage error naming `label` if not. */
export function assertActor(value: string, label: string): string {
  if (!ACTOR_PATTERN.test(value)) throw patternError(label, value, "an actor");
  return value;
}

/** `value` when it matches the session pattern; a usage error otherwise. */
export function assertSession(value: string, label = "session"): string {
  if (!ACTOR_PATTERN.test(value)) {
    throw patternError(label, value, "a session token");
  }
  return value;
}

/** An empty variable reads as unset, the way shells treat `VAR=`. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value === undefined || value === "" ? null : value;
}

/**
 * `--session`, else `TASKS_SESSION`, else `null`. A token that fails the
 * pattern is a usage error from either source: it names a file under
 * `.locks/` and ends every log heading the session writes.
 */
export function resolveSession(
  options: { session?: string | null; env?: NodeJS.ProcessEnv } = {},
): string | null {
  if (options.session !== undefined && options.session !== null) {
    return assertSession(options.session, "--session");
  }
  const value = readEnv(options.env ?? process.env, SESSION_ENV);
  return value === null ? null : assertSession(value, SESSION_ENV);
}

/** A git identity value, or `null` when git is absent, fails, or has none. */
async function gitConfig(
  key: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", key], {
      cwd,
      env,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const value = stdout.replace(/\r?\n$/, "");
    return value === "" ? null : value;
  } catch {
    // No git, no repository, or the key is unset: not a source here.
    return null;
  }
}

function osUsername(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    // Some containers run as a uid without a passwd entry.
    return null;
  }
}

interface OperatorSearch {
  operator: string | null;
  /** The operating-system user when the search reached it, for messages. */
  osUser: string | null;
}

async function searchOperator(
  options: OperatorOptions,
): Promise<OperatorSearch> {
  const env = options.env ?? process.env;

  // An explicit variable is a deliberate choice: a bad value is refused,
  // never skipped in favor of some other identity.
  const explicit = readEnv(env, ACTOR_ENV);
  if (explicit !== null) {
    return { operator: assertActor(explicit, ACTOR_ENV), osUser: null };
  }

  for (const key of GIT_IDENTITY_KEYS) {
    const value = await gitConfig(key, options.projectRoot, env);
    if (value === null) continue;
    if (ACTOR_PATTERN.test(value)) return { operator: value, osUser: null };
    options.diagnose?.(
      `git ${key} ${JSON.stringify(value)} does not match ${ACTOR_PATTERN.source}; skipped (set ${ACTOR_ENV} to a short name${shortNameHint(value)}).`,
    );
  }

  const osUser = osUsername();
  if (osUser !== null && ACTOR_PATTERN.test(osUser)) {
    return { operator: osUser, osUser };
  }
  return { operator: null, osUser };
}

/** The first word of a skipped git name, lower-cased, when it would do. */
function shortNameHint(value: string): string {
  const first = value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return ACTOR_PATTERN.test(first) ? `, for instance ${first}` : "";
}

/** Why the search found nobody, for the error and the `--as` diagnostic. */
function describeSearch(osUser: string | null): string {
  const user =
    osUser === null
      ? "the operating-system user cannot be read"
      : `the operating-system user ${JSON.stringify(osUser)} is not a valid actor`;
  return `${ACTOR_ENV} is not set, git has no usable user.name or user.email, and ${user}`;
}

function noActorError(osUser: string | null): TaskError {
  return TaskError.usage(
    `No actor could be resolved: ${describeSearch(osUser)} (an actor must match ${ACTOR_PATTERN.source}). Set ${ACTOR_ENV} or pass --as <actor>.`,
    { pattern: ACTOR_PATTERN.source, os_user: osUser },
  );
}

/**
 * The operator, from the first source that yields one: `TASKS_ACTOR` (a
 * value failing the pattern is a usage error), `git config user.name`, then
 * `user.email` (read with the project root as cwd and `env` handed to git, so
 * repository and conditional includes apply; a value failing the pattern is
 * skipped with a diagnostic, an absent git silently), then the
 * operating-system user. A usage error when none yields a valid actor.
 */
export async function resolveOperator(
  options: OperatorOptions,
): Promise<string> {
  const found = await searchOperator(options);
  if (found.operator === null) throw noActorError(found.osUser);
  return found.operator;
}

/**
 * Principal, operator and session. `actor` is `--as` when given, else the
 * operator; `via` is the operator when `--as` named someone else, so the log
 * records both. When `--as` is given and no operator can be resolved, `--as`
 * stands alone, with a diagnostic: it is the remedy the error names.
 */
export async function resolveIdentity(
  options: IdentityOptions,
): Promise<Identity> {
  const principal =
    options.as === undefined || options.as === null
      ? null
      : assertActor(options.as, "--as");
  const session = resolveSession({
    session: options.session,
    env: options.env,
  });
  const found = await searchOperator(options);

  if (principal === null) {
    if (found.operator === null) throw noActorError(found.osUser);
    return { actor: found.operator, via: null, session };
  }
  if (found.operator === null) {
    options.diagnose?.(
      `No operator identity could be resolved (${describeSearch(found.osUser)}); acting as ${principal} with no operator recorded.`,
    );
    return { actor: principal, via: null, session };
  }
  return {
    actor: principal,
    via: principal === found.operator ? null : found.operator,
    session,
  };
}

/* ------------------------------------------------------------------------ */
/* The heartbeat registry                                                   */
/* ------------------------------------------------------------------------ */

/** The content of an ended session's registry file, newline optional. */
export const SESSION_ENDED_MARK = "ended";

const ENDED_CONTENT = /^ended(?:\r?\n)?$/;

/** Larger than any content that could still be the mark. */
const MARK_MAX_BYTES = 16;

/** `.tasks/.locks/sessions`. */
export function registryDir(tasksDir: string): string {
  return path.join(tasksDir, LOCKS_DIRNAME, SESSIONS_DIRNAME);
}

/**
 * The registry file of `session`. The token pattern is what makes it safe as
 * a file name — no separator, no leading dot — so it is checked here too.
 */
export function sessionFile(tasksDir: string, session: string): string {
  return path.join(registryDir(tasksDir), assertSession(session));
}

/**
 * Create the registry on demand, but never a tree: a listed project that is
 * not checked out has no registry to touch, and a recursive mkdir would
 * conjure an empty `.tasks/` in its place.
 */
async function ensureRegistry(tasksDir: string): Promise<void> {
  if (!(await isDirectory(tasksDir))) {
    throw TaskError.notFound(
      `No .tasks/ directory at ${tasksDir}; a session is recorded only in an existing tree.`,
      { tasksDir },
    );
  }
  await fs.mkdir(registryDir(tasksDir), { recursive: true });
}

/**
 * Record activity: the file exists, is empty, and its mtime is now. Emptying
 * it clears an `ended` mark — a session that runs a command is evidently
 * running again.
 */
export async function touchSession(
  tasksDir: string,
  session: string,
): Promise<void> {
  const file = sessionFile(tasksDir, session);
  await ensureRegistry(tasksDir);
  await fs.writeFile(file, "");
  // Explicit, since truncating an already empty file need not bump the mtime.
  const now = new Date();
  await fs.utimes(file, now, now);
}

/**
 * Mark the session ended: the single line `ended`, written atomically so no
 * reader sees an empty file in between. The mtime is set to `at`, which is
 * the session's last activity, so `last_seen` of its claims stays truthful.
 * Returns the time of the mark.
 */
export async function markSessionEnded(
  tasksDir: string,
  session: string,
  at: Date = new Date(),
): Promise<string> {
  const file = sessionFile(tasksDir, session);
  await ensureRegistry(tasksDir);
  await writeFileAtomic(file, `${SESSION_ENDED_MARK}\n`);
  await fs.utimes(file, at, at);
  return formatIso(at);
}

interface Heartbeat {
  mtime: Date;
  ended: boolean;
}

/** The registry file as liveness needs it, or `null` when there is none. */
async function readHeartbeat(file: string): Promise<Heartbeat | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    // An empty file, the usual case, is never read.
    const ended =
      stat.size > 0 &&
      stat.size <= MARK_MAX_BYTES &&
      ENDED_CONTENT.test(await fs.readFile(file, "utf8"));
    return { mtime: stat.mtime, ended };
  } catch (err) {
    const code = errnoCode(err);
    // Gone between the stat and the read: housekeeping won the race.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

export interface SessionRecord {
  exists: boolean;
  ended: boolean;
  /** The file's mtime as an ISO timestamp, or `null` without a file. */
  lastSeen: string | null;
}

export async function readSession(
  tasksDir: string,
  session: string,
): Promise<SessionRecord> {
  const heartbeat = await readHeartbeat(sessionFile(tasksDir, session));
  return heartbeat === null
    ? { exists: false, ended: false, lastSeen: null }
    : {
        exists: true,
        ended: heartbeat.ended,
        lastSeen: formatIso(heartbeat.mtime),
      };
}

/* ------------------------------------------------------------------------ */
/* Liveness                                                                 */
/* ------------------------------------------------------------------------ */

function unknown(): ClaimLiveness {
  return { liveness: "unknown", last_seen: null };
}

/** Old enough that a claim it backs is orphaned, and housekeeping may act. */
function isStale(heartbeat: Heartbeat, timeoutMinutes: number, now: Date) {
  return minutesSince(heartbeat.mtime, now) >= timeoutMinutes;
}

/**
 * The spec's table: no file is `unknown` (another machine, or a cleaned
 * registry); a file marked `ended` or at least the timeout old is
 * `orphaned`; anything else is `live`.
 */
function judge(
  heartbeat: Heartbeat | null,
  timeoutMinutes: number,
  now: Date,
): ClaimLiveness {
  if (heartbeat === null) return unknown();
  const orphaned = heartbeat.ended || isStale(heartbeat, timeoutMinutes, now);
  return {
    liveness: orphaned ? "orphaned" : "live",
    last_seen: formatIso(heartbeat.mtime),
  };
}

function claimSession(task: Task): string | null {
  const session = task.frontmatter.claimed_session;
  // The manifest parser enforces the pattern; the guard keeps a path built
  // from a token inside the registry no matter where the task came from.
  return session !== null && ACTOR_PATTERN.test(session) ? session : null;
}

/**
 * The liveness of a task's claim, judged by the registry and the
 * `session_timeout_minutes` of the tree that holds the task. Meaningful for
 * `IN_PROGRESS`; a claim without a session is `unknown`.
 */
export async function claimLiveness(
  tree: Tree,
  task: Task,
  now: Date = new Date(),
): Promise<ClaimLiveness> {
  const session = claimSession(task);
  if (session === null) return unknown();
  const heartbeat = await readHeartbeat(
    path.join(registryDir(tree.project.tasksDir), session),
  );
  return judge(heartbeat, tree.config.sessionTimeoutMinutes, now);
}

/** Liveness of every `IN_PROGRESS` task of the tree, by id. */
export async function livenessForTree(
  tree: Tree,
  now: Date = new Date(),
): Promise<Map<string, ClaimLiveness>> {
  const heartbeats = new Map<string, Heartbeat | null>();
  const out = new Map<string, ClaimLiveness>();
  for (const task of tree.tasks) {
    if (task.frontmatter.status !== "IN_PROGRESS") continue;
    const session = claimSession(task);
    if (session === null) {
      out.set(task.id, unknown());
      continue;
    }
    if (!heartbeats.has(session)) {
      heartbeats.set(
        session,
        await readHeartbeat(
          path.join(registryDir(tree.project.tasksDir), session),
        ),
      );
    }
    out.set(
      task.id,
      judge(
        heartbeats.get(session) ?? null,
        tree.config.sessionTimeoutMinutes,
        now,
      ),
    );
  }
  return out;
}

/**
 * Remove registry files that tell nothing any more: older than the timeout,
 * or marked `ended`, and named by no task of this tree. A file a claim names
 * stays at any age, because it is what tells an orphaned claim from an
 * unknown one. A tree with an unreadable manifest keeps every file, since
 * that manifest may hold a claim nobody can see. Returns the sessions
 * removed; a missing registry removes nothing.
 */
export async function housekeepSessions(
  tree: Tree,
  now: Date = new Date(),
): Promise<string[]> {
  if (tree.malformed.length > 0) return [];

  const dir = registryDir(tree.project.tasksDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }

  // Any claim field counts, not only IN_PROGRESS ones: keeping a file is
  // always safe, and an inconsistent manifest is validation's to report.
  const referenced = new Set<string>();
  for (const task of tree.tasks) {
    const session = task.frontmatter.claimed_session;
    if (session !== null) referenced.add(session);
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const session = entry.name;
    // The temporary file of an atomic write starts with a dot: never a token.
    if (!entry.isFile() || !ACTOR_PATTERN.test(session)) continue;
    if (referenced.has(session)) continue;

    const file = path.join(dir, session);
    // Read right before removing, so a touch that landed meanwhile counts.
    const heartbeat = await readHeartbeat(file);
    if (heartbeat === null) continue;
    if (
      !heartbeat.ended &&
      !isStale(heartbeat, tree.config.sessionTimeoutMinutes, now)
    ) {
      continue;
    }
    try {
      await fs.unlink(file);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") continue;
      throw err;
    }
    removed.push(session);
  }
  return removed.sort();
}

/* ------------------------------------------------------------------------ */
/* Session check and session end                                            */
/* ------------------------------------------------------------------------ */

/** A tree and the alias that qualifies its ids (`null` for the local tree). */
export interface AliasedTree {
  tree: Tree;
  alias: string | null;
}

/** Each tree once, under its first alias, however many aliases reach it. */
function distinctTrees(trees: ReadonlyArray<AliasedTree>): AliasedTree[] {
  const seen = new Set<string>();
  return trees.filter(({ tree }) => {
    const key = tree.project.tasksDir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isInProgress(task: Task): boolean {
  return task.frontmatter.status === "IN_PROGRESS";
}

/**
 * The claims a session check covers: with a session, every claim taken in
 * it, whoever the principal was; without one, the actor's claims that carry
 * no session either.
 */
function isCovered(task: Task, identity: Identity): boolean {
  const { claimed_by, claimed_session } = task.frontmatter;
  return identity.session !== null
    ? claimed_session === identity.session
    : claimed_session === null && claimed_by === identity.actor;
}

/**
 * The advisory half of the check: a resume point that predates the claim, or
 * the last log entry. The claim writes a log entry of its own, so while that
 * entry is still the latest the claim warning already says everything and
 * the log warning is left out.
 */
async function ageWarnings(
  id: string,
  task: Task,
  written: Date,
): Promise<SessionWarningJson[]> {
  const warnings: SessionWarningJson[] = [];
  const writtenIso = formatIso(written);
  const claimedAt = task.frontmatter.claimed_at;

  if (claimedAt !== null && written.getTime() < Date.parse(claimedAt)) {
    warnings.push({
      id,
      kind: "state-older-than-claim",
      message: `${id}: state.md was last written at ${writtenIso}, before the claim at ${claimedAt}; refresh it once the work has moved.`,
    });
  }

  const last = await lastLogEntry(task.dir);
  if (
    last !== null &&
    written.getTime() < Date.parse(last.time) &&
    (claimedAt === null || last.time > claimedAt)
  ) {
    warnings.push({
      id,
      kind: "state-older-than-log",
      message: `${id}: state.md was last written at ${writtenIso}, before the last log entry at ${last.time}; refresh it if the work has moved since.`,
    });
  }
  return warnings;
}

/**
 * The exit invariant: every `IN_PROGRESS` task the check covers (see
 * `isCovered`) has a `state.md`. Existence is all it enforces; an ageing
 * resume point is only a warning, so a turn that made no progress is never
 * forced into a meaningless write. Ids are qualified by their tree's alias.
 */
export async function sessionCheck(
  trees: ReadonlyArray<AliasedTree>,
  identity: Identity,
): Promise<SessionCheckJson> {
  const violations: SessionViolationJson[] = [];
  const warnings: SessionWarningJson[] = [];

  for (const { tree, alias } of distinctTrees(trees)) {
    for (const task of tree.tasks) {
      if (!isInProgress(task) || !isCovered(task, identity)) continue;
      const id = qualifyId(alias, task.id);
      // From disk rather than the snapshot: the age is needed anyway.
      const written = await stateMtime(task.dir);
      if (written === null) {
        violations.push({ id, kind: "missing-state" });
        continue;
      }
      warnings.push(...(await ageWarnings(id, task, written)));
    }
  }

  return {
    ok: violations.length === 0,
    session: identity.session,
    violations,
    warnings,
  };
}

/**
 * Mark `session` ended in every given tree and report the claims that are
 * orphaned by it: the `IN_PROGRESS` tasks whose `claimed_session` it is, ids
 * qualified. A session that holds nothing ends just the same, with no
 * claims.
 */
export async function sessionEnd(
  trees: ReadonlyArray<AliasedTree>,
  session: string,
  now: Date = new Date(),
): Promise<SessionEndJson> {
  assertSession(session);
  const claims: string[] = [];
  for (const { tree, alias } of distinctTrees(trees)) {
    await markSessionEnded(tree.project.tasksDir, session, now);
    for (const task of tree.tasks) {
      if (isInProgress(task) && task.frontmatter.claimed_session === session) {
        claims.push(qualifyId(alias, task.id));
      }
    }
  }
  return { session, ended: formatIso(now), claims };
}
