import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { Command } from "commander";
import { expect } from "vitest";

import type { GlobalOptions } from "../src/context.js";
import type { DerivedTask } from "../src/core/derive.js";
import { GateResolver } from "../src/core/gates.js";
import { idToNative } from "../src/core/ids.js";
import { Projects } from "../src/core/projects.js";
import { snapshotTree } from "../src/core/snapshot.js";
import { loadTree } from "../src/core/tree.js";
import type { Frontmatter } from "../src/core/types.js";
import { LOCKS_DIRNAME, SESSIONS_DIRNAME } from "../src/core/types.js";
import type { LogEntry } from "../src/core/workspace.js";
import { readLog } from "../src/core/workspace.js";
import type { CliResult, Sandbox } from "./helpers.js";

/**
 * Shared helpers of the transition suites: reading a task back from disk,
 * its log, its derived conditions, and laying out session registry files.
 */

export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** The JSON error envelope a `--json` run wrote to stderr. */
export function errorOf(result: CliResult): ErrorBody {
  expect(result.stdout).toBe("");
  return (JSON.parse(result.stderr) as { error: ErrorBody }).error;
}

/** Exit code and error kind of a refused `--json` run, for one expect. */
export function refusal(result: CliResult): {
  code: number;
  error: string;
  kind: unknown;
} {
  const error = errorOf(result);
  return { code: result.code, error: error.code, kind: error.details?.kind };
}

/** The tree root of the local project, or of a sibling project root. */
function tasksDirOf(sandbox: Sandbox, projectRoot?: string): string {
  return projectRoot === undefined
    ? sandbox.tasksDir
    : path.join(projectRoot, ".tasks");
}

export async function frontmatterOf(
  sandbox: Sandbox,
  id: string,
  projectRoot?: string,
): Promise<Frontmatter> {
  const tasksDir = tasksDirOf(sandbox, projectRoot);
  const tree = await loadTree({ root: path.dirname(tasksDir), tasksDir });
  const task = tree.byId.get(id);
  if (task === undefined) throw new Error(`No parsed task ${id}.`);
  return task.frontmatter;
}

export async function logOf(
  sandbox: Sandbox,
  id: string,
  projectRoot?: string,
): Promise<LogEntry[]> {
  return readLog(idToNative(tasksDirOf(sandbox, projectRoot), id));
}

/** The text of every entry of a task's log, oldest first. */
export async function logTexts(
  sandbox: Sandbox,
  id: string,
  projectRoot?: string,
): Promise<string[]> {
  return (await logOf(sandbox, id, projectRoot)).map((entry) => entry.text);
}

export async function lastEntry(
  sandbox: Sandbox,
  id: string,
  projectRoot?: string,
): Promise<LogEntry> {
  const entries = await logOf(sandbox, id, projectRoot);
  const last = entries[entries.length - 1];
  if (last === undefined) throw new Error(`${id} has no log entry.`);
  return last;
}

/** The task as `show` would derive it for `actor`, from a fresh read. */
export async function derivedOf(
  sandbox: Sandbox,
  id: string,
  actor = "tester",
): Promise<DerivedTask> {
  const projects = new Projects(await sandbox.loadTree());
  const gates = new GateResolver(projects);
  const { derived } = await snapshotTree(
    { projects, gates },
    projects.local,
    actor,
  );
  const entry = derived.get(id);
  if (entry === undefined) throw new Error(`No derived task ${id}.`);
  return entry;
}

function registryFile(
  sandbox: Sandbox,
  session: string,
  projectRoot?: string,
): string {
  const file = path.join(
    tasksDirOf(sandbox, projectRoot),
    LOCKS_DIRNAME,
    SESSIONS_DIRNAME,
    session,
  );
  return path.relative(sandbox.dir, file);
}

/** A heartbeat for `session`, last touched `minutes` ago. */
export async function heartbeat(
  sandbox: Sandbox,
  session: string,
  minutes = 0,
  projectRoot?: string,
): Promise<void> {
  const file = registryFile(sandbox, session, projectRoot);
  await sandbox.write(file, "");
  if (minutes > 0) await sandbox.age(file, minutes);
}

/** What `session-end` leaves behind: the registry file marked `ended`. */
export async function endSession(
  sandbox: Sandbox,
  session: string,
  projectRoot?: string,
): Promise<void> {
  await sandbox.write(registryFile(sandbox, session, projectRoot), "ended\n");
}

/** The ISO mtime of a session's registry file, as liveness reports it. */
export async function lastSeen(
  sandbox: Sandbox,
  session: string,
  projectRoot?: string,
): Promise<string> {
  const file = path.resolve(
    sandbox.dir,
    registryFile(sandbox, session, projectRoot),
  );
  return `${(await fs.stat(file)).mtime.toISOString().slice(0, 19)}Z`;
}

/** Human output without colour codes. */
export function plain(text: string): string {
  return stripVTControlCharacters(text);
}

/** The slice of a commander `Command` that `openContext` reads. */
export function fakeCommand(options: GlobalOptions): Command {
  return { optsWithGlobals: () => options } as unknown as Command;
}
