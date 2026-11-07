import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { TaskError } from "../errors.js";
import { errnoCode, isDirectory, writeFileAtomic } from "./fs-utils.js";
import type { Task, WorkspacePresence } from "./task.js";
import { isIsoTimestamp } from "./time.js";
import type {
  Identity,
  LastEntryJson,
  Liveness,
  LogEntryJson,
  Status,
  WorkspaceFilename,
} from "./types.js";
import {
  ACTOR_PATTERN,
  DESIGN_FILENAME,
  LOG_FILENAME,
  PLAN_FILENAME,
  STATE_FILENAME,
} from "./types.js";

/**
 * The workspace vocabulary beside `task.md`: `state.md` (the resume point,
 * replaced whole), `design.md` and `plan.md` (edited by their authors, never
 * by the tooling), and `log.md` (history, append-only). This module owns the
 * reads and the two writes the tooling may make: `state.md` through the
 * explicit `state` command, and log entries.
 */

/* ------------------------------------------------------------------------ */
/* Presence                                                                 */
/* ------------------------------------------------------------------------ */

const VOCABULARY: ReadonlyArray<
  readonly [keyof WorkspacePresence, WorkspaceFilename]
> = [
  ["state", STATE_FILENAME],
  ["design", DESIGN_FILENAME],
  ["plan", PLAN_FILENAME],
  ["log", LOG_FILENAME],
];

function isMissing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/**
 * The file's stats when it is a regular file (or a symlink to one), else
 * `null`: a directory named `state.md` is workspace content, not a resume
 * point, exactly as the scanner sees it.
 */
async function statFile(target: string): Promise<Stats | null> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() ? stat : null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

async function readTextFile(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Which vocabulary files exist in `taskDir`, as on disk now. */
export async function workspacePresence(
  taskDir: string,
): Promise<WorkspacePresence> {
  const presence: WorkspacePresence = {
    state: false,
    design: false,
    plan: false,
    log: false,
  };
  await Promise.all(
    VOCABULARY.map(async ([key, filename]) => {
      presence[key] = (await statFile(path.join(taskDir, filename))) !== null;
    }),
  );
  return presence;
}

/** The vocabulary files a task has, in order: state, design, plan, log. */
export function workspaceFiles(task: Task): WorkspaceFilename[] {
  return VOCABULARY.filter(([key]) => task.workspace[key]).map(
    ([, filename]) => filename,
  );
}

/* ------------------------------------------------------------------------ */
/* state.md                                                                 */
/* ------------------------------------------------------------------------ */

export async function readState(taskDir: string): Promise<string | null> {
  return readTextFile(path.join(taskDir, STATE_FILENAME));
}

/**
 * Replace `state.md` atomically with exactly `content`: no normalization and
 * no trailing-newline fix-up, because the file is the caller's words. The
 * task directory must exist; this never creates one.
 */
export async function writeState(
  taskDir: string,
  content: string,
): Promise<void> {
  if (!(await isDirectory(taskDir))) {
    throw TaskError.notFound(`No task directory at ${taskDir}.`, {
      path: taskDir,
    });
  }
  await writeFileAtomic(path.join(taskDir, STATE_FILENAME), content);
}

/** When `state.md` was last written, or `null` when there is none. */
export async function stateMtime(taskDir: string): Promise<Date | null> {
  return (await statFile(path.join(taskDir, STATE_FILENAME)))?.mtime ?? null;
}

/* ------------------------------------------------------------------------ */
/* log.md: the heading grammar                                              */
/* ------------------------------------------------------------------------ */

/**
 * One entry of `log.md`. The same fields as the CLI's `last_entry`; `text`
 * is the body below the heading.
 */
export interface LogEntry {
  time: string;
  actor: string;
  /** The operator when the entry was made on behalf of `actor`. */
  via: string | null;
  session: string | null;
  text: string;
}

export type LogHeading = Omit<LogEntry, "text">;

const HEADING_PREFIX = "## ";
const VIA_WORD = "via";
const SESSION_PREFIX = "s:";

function headingProblem(heading: LogHeading): string | null {
  if (!isIsoTimestamp(heading.time)) {
    return `time ${JSON.stringify(heading.time)} is not an ISO 8601 UTC timestamp`;
  }
  const names: Array<[string, string | null]> = [
    ["actor", heading.actor],
    ["via", heading.via],
    ["session", heading.session],
  ];
  for (const [label, value] of names) {
    if (value !== null && !ACTOR_PATTERN.test(value)) {
      return `${label} ${JSON.stringify(value)} does not match ${ACTOR_PATTERN.source}`;
    }
  }
  return null;
}

/**
 * `## <time> <actor>[ via <operator>][ s:<session>]`. Every value was
 * validated where it entered (options, environment, manifest), so a value
 * that fails here is a bug, not a usage error: writing it would leave a
 * heading no reader can parse.
 */
export function formatLogHeading(heading: LogHeading): string {
  const problem = headingProblem(heading);
  if (problem !== null) {
    throw TaskError.internal(`Cannot write a log heading: ${problem}.`, {
      time: heading.time,
      actor: heading.actor,
      via: heading.via,
      session: heading.session,
    });
  }
  let line = `${HEADING_PREFIX}${heading.time} ${heading.actor}`;
  if (heading.via !== null) line += ` ${VIA_WORD} ${heading.via}`;
  if (heading.session !== null) line += ` ${SESSION_PREFIX}${heading.session}`;
  return line;
}

/**
 * Parse a heading line, or `null` when it does not follow the grammar. The
 * grammar splits on single spaces with every position fixed — timestamp,
 * actor, optional `via <operator>`, optional `s:<session>`, in that order —
 * which is unambiguous because actors and sessions contain neither spaces
 * nor colons. Trailing whitespace (an editor's, or a CR) is tolerated.
 */
export function parseLogHeading(line: string): LogHeading | null {
  const trimmed = line.replace(/[ \t\r]+$/, "");
  if (!trimmed.startsWith(HEADING_PREFIX)) return null;

  const [time, actor, ...rest] = trimmed
    .slice(HEADING_PREFIX.length)
    .split(" ");
  if (time === undefined || !isIsoTimestamp(time)) return null;
  if (actor === undefined || !ACTOR_PATTERN.test(actor)) return null;

  let next = 0;
  let via: string | null = null;
  if (rest[next] === VIA_WORD) {
    const operator = rest[next + 1];
    if (operator === undefined || !ACTOR_PATTERN.test(operator)) return null;
    via = operator;
    next += 2;
  }

  let session: string | null = null;
  const tagged = rest[next];
  if (tagged !== undefined && tagged.startsWith(SESSION_PREFIX)) {
    const token = tagged.slice(SESSION_PREFIX.length);
    if (!ACTOR_PATTERN.test(token)) return null;
    session = token;
    next += 1;
  }

  return next === rest.length ? { time, actor, via, session } : null;
}

/* ------------------------------------------------------------------------ */
/* log.md: entries                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Git's conflict markers at the default size of seven: the opening, base and
 * closing markers followed by a space and a label (or nothing), and the bare
 * separator. Longer runs, such as a setext heading's underline, are not
 * markers.
 */
function isConflictMarkerLine(line: string): boolean {
  const text = line.replace(/\r$/, "");
  return /^(?:<{7}|>{7}|\|{7})(?: |$)/.test(text) || /^={7}[ \t]*$/.test(text);
}

/** True when `source` holds a version-control conflict marker line. */
export function hasConflictMarkers(source: string): boolean {
  return source.split("\n").some(isConflictMarkerLine);
}

/**
 * Refuse text that would corrupt the log: a line that reads as a heading
 * would split the entry in two for every reader, and a line that reads as a
 * conflict marker would make validation report the log as conflicted. Call
 * it while validating arguments, before anything is written.
 */
export function assertLogText(text: string): void {
  text.split(/\r?\n/).forEach((line, index) => {
    const reason =
      parseLogHeading(line) !== null
        ? "reads as a log heading and would start a new entry"
        : isConflictMarkerLine(line)
          ? "reads as a version-control conflict marker"
          : null;
    if (reason !== null) {
      throw TaskError.usage(
        `Line ${index + 1} of the log text ${reason}: ${JSON.stringify(line)}. Indent or rephrase it.`,
        { line: index + 1, text: line },
      );
    }
  });
}

/**
 * What the writer emits and the reader returns, so an entry round-trips: LF
 * line ends, no leading blank lines, no trailing whitespace. Indentation of
 * the first line survives; it can be meaningful markdown.
 */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

/** The heading, a newline, the text, a newline. */
export function formatLogEntry(entry: LogEntry): string {
  const heading = formatLogHeading(entry);
  assertLogText(entry.text);
  const text = normalizeText(entry.text);
  return text === "" ? `${heading}\n` : `${heading}\n${text}\n`;
}

/** How many line breaks `tail` ends with, counting CRLF as one. */
function trailingLineBreaks(tail: string): number {
  let count = 0;
  let at = tail.length - 1;
  while (at >= 0 && tail[at] === "\n") {
    count += 1;
    at -= tail[at - 1] === "\r" ? 2 : 1;
  }
  return count;
}

/** What must precede a new entry so exactly one blank line separates it. */
async function separatorFor(file: string): Promise<string> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return "";
    throw err;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return "";
    // Four bytes tell "\n\n" and "\r\n\r\n" apart from a single break; CR and
    // LF never occur inside a multi-byte UTF-8 sequence, so bytes suffice.
    const length = Math.min(size, 4);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const breaks = trailingLineBreaks(buffer.toString("latin1"));
    return breaks >= 2 ? "" : breaks === 1 ? "\n" : "\n\n";
  } finally {
    await handle.close();
  }
}

/**
 * Append one entry to `log.md`, creating it when missing. The log is history:
 * existing bytes are never rewritten, which is why this appends in place
 * instead of replacing the file atomically, and why a file that already ends
 * in several blank lines keeps them. Callers hold the tree lock.
 */
export async function appendLogEntry(
  taskDir: string,
  entry: LogEntry,
): Promise<void> {
  // Format first: a refused entry must leave the file untouched.
  const chunk = formatLogEntry(entry);
  const file = path.join(taskDir, LOG_FILENAME);
  const separator = await separatorFor(file);
  await fs.appendFile(file, separator + chunk, "utf8");
}

/**
 * Parse a whole log. An entry starts at each line that follows the heading
 * grammar and runs to the next one; text before the first heading (a title,
 * say) is ignored, and a `## ` line outside the grammar is ordinary text of
 * the entry it sits in. Parsing is line by line and ignores code fences, so
 * every implementation can agree on it.
 */
export function parseLog(source: string): LogEntry[] {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const entries: LogEntry[] = [];
  let heading: LogHeading | null = null;
  let lines: string[] = [];

  const flush = () => {
    if (heading !== null) {
      entries.push({ ...heading, text: normalizeText(lines.join("\n")) });
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const parsed = parseLogHeading(line);
    if (parsed !== null) {
      flush();
      heading = parsed;
      lines = [];
    } else if (heading !== null) {
      lines.push(line);
    }
  }
  flush();
  return entries;
}

export async function readLog(taskDir: string): Promise<LogEntry[]> {
  const source = await readTextFile(path.join(taskDir, LOG_FILENAME));
  return source === null ? [] : parseLog(source);
}

export function toLastEntryJson(entry: LogEntry): LastEntryJson {
  return {
    time: entry.time,
    actor: entry.actor,
    via: entry.via,
    session: entry.session,
    text: entry.text,
  };
}

/** The `log --since` shape; `task` is already qualified for a foreign tree. */
export function toLogEntryJson(entry: LogEntry, task: string): LogEntryJson {
  return { task, ...toLastEntryJson(entry) };
}

/**
 * The most recent entry, or `null` without a log. Most recent by time, not
 * by position: a merge resolved without sorting must not hide the latest
 * note. Canonical timestamps compare as text; a tie goes to the later entry.
 */
export async function lastLogEntry(
  taskDir: string,
): Promise<LastEntryJson | null> {
  let latest: LogEntry | null = null;
  for (const entry of await readLog(taskDir)) {
    if (latest === null || entry.time >= latest.time) latest = entry;
  }
  return latest === null ? null : toLastEntryJson(latest);
}

/** An entry stamped with who acts; `null` and `undefined` lines are dropped. */
export function logEntryFor(
  identity: Identity,
  time: string,
  lines: ReadonlyArray<string | null | undefined>,
): LogEntry {
  return {
    time,
    actor: identity.actor,
    via: identity.via,
    session: identity.session,
    text: lines
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
  };
}

/* ------------------------------------------------------------------------ */
/* log.md: first lines                                                      */
/* ------------------------------------------------------------------------ */

/*
 * The first line of an entry names what happened. Every writer builds it
 * here, so transitions, cascades, structure commands and `migrate` agree
 * byte for byte, and a forced transition is marked the same way everywhere.
 */

export interface LineOptions {
  /** Marks the entry of a transition that `--force` allowed. */
  forced?: boolean;
}

const ARROW = "→";
const FORCED_MARK = " (forced)";

/** ` (forced)` when `--force` was needed, else nothing. */
export function forcedSuffix(forced: boolean): string {
  return forced ? FORCED_MARK : "";
}

function forcedMark(options: LineOptions | undefined): string {
  return forcedSuffix(options?.forced === true);
}

/**
 * `move: a/x → b/x`, with ` (forced)` when `--force` was needed. Ids are the
 * tree's own: an alias means nothing inside it.
 */
export function moveLine(from: string, to: string, forced: boolean): string {
  return `move: ${from} ${ARROW} ${to}${forcedSuffix(forced)}`;
}

/** `claim: TODO → IN_PROGRESS`, with ` (forced)` when forced. */
export function transitionLine(
  command: string,
  from: Status,
  to: Status,
  options?: LineOptions,
): string {
  return `${command}: ${from} ${ARROW} ${to}${forcedMark(options)}`;
}

/** On a task a cascade reached: `cancel with epic: TODO → CANCELLED`. */
export function cascadeLine(
  command: string,
  parentId: string,
  from: Status,
  to: Status,
  options?: LineOptions,
): string {
  return `${command} with ${parentId}: ${from} ${ARROW} ${to}${forcedMark(options)}`;
}

/** On the task a cascade was ordered on, after its transition line. */
export function reachedLine(ids: readonly string[]): string {
  return `reached: ${ids.join(", ")}`;
}

/** `handoff alice: IN_PROGRESS → PAUSED`: one entry for pause plus assign. */
export function handoffLine(actor: string, options?: LineOptions): string {
  return `handoff ${actor}: IN_PROGRESS ${ARROW} PAUSED${forcedMark(options)}`;
}

/** `assign: alice`, `priority: high`. */
export function fieldLine(
  command: "assign" | "priority",
  value: string,
  options?: LineOptions,
): string {
  return `${command}: ${value}${forcedMark(options)}`;
}

/** `unassign`: the word alone. */
export function unassignLine(options?: LineOptions): string {
  return `unassign${forcedMark(options)}`;
}

/** `new: TODO`, or `new: BACKLOG`. */
export function creationLine(status: Status): string {
  return `new: ${status}`;
}

/**
 * What a takeover, or any transition over an orphaned claim, records about
 * the claim it superseded: `supersedes alice s:7f3a, last seen <time>`, with
 * `unknown` when no heartbeat was ever seen.
 */
export function takeoverLine(
  claimant: string,
  session: string | null,
  lastSeen: string | null,
): string {
  const tag = session === null ? "" : ` ${SESSION_PREFIX}${session}`;
  return `supersedes ${claimant}${tag}, last seen ${lastSeen ?? "unknown"}`;
}

/**
 * What a write that is not a transition records about a claim it went past;
 * the claim stays in place: `over the claim of alice s:7f3a (orphaned, last
 * seen <time>)`, `(live, last seen <time>)` when `--force` went past live
 * work, `(liveness unknown)` when no heartbeat was ever seen.
 */
export function passedOverLine(
  claimant: string,
  session: string | null,
  liveness: Liveness,
  lastSeen: string | null,
): string {
  const tag = session === null ? "" : ` ${SESSION_PREFIX}${session}`;
  const state =
    liveness === "unknown"
      ? "liveness unknown"
      : `${liveness}, last seen ${lastSeen ?? "unknown"}`;
  return `over the claim of ${claimant}${tag} (${state})`;
}
