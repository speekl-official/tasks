import { Command } from "commander";

import type { CommandContext } from "../context.js";
import { assertLocalScope, openContext } from "../context.js";
import { addressTree, readArchivedTask } from "../core/archive.js";
import { compareIds, isWithin } from "../core/ids.js";
import { withMutation } from "../core/mutate.js";
import type { LoadedTree } from "../core/projects.js";
import { parseSince } from "../core/time.js";
import { resolveTaskArg } from "../core/tree.js";
import type { LogEntriesJson, LogEntryJson } from "../core/types.js";
import type { LogEntry } from "../core/workspace.js";
import {
  appendLogEntry,
  assertLogText,
  logEntryFor,
  readLog,
  toLogEntryJson,
} from "../core/workspace.js";
import { TaskError } from "../errors.js";
import { emitJson, renderLogEntries, ui, writeOut } from "../output.js";

interface LogOptions {
  since?: string;
  /** Keep one actor's entries, in a listing or in a task's history. */
  actor?: string;
  /** With `--since`: a task or group of the local tree and all beneath it. */
  scope?: string;
  local?: boolean;
  /** Read an archived task's log, or include the archive in `--since`. */
  archived?: boolean;
  json?: boolean;
}

/** What narrows a task's history: a lower time bound, one actor's entries. */
interface EntryFilter {
  since: string | null;
  actor: string | null;
}

function passes(entry: LogEntry, filter: EntryFilter): boolean {
  return (
    (filter.since === null || entry.time >= filter.since) &&
    (filter.actor === null || entry.actor === filter.actor)
  );
}

/** The narrative is the caller's words; only what would corrupt the log is refused. */
function entryText(words: string[]): string {
  const text = words.join(" ");
  if (text.trim().length === 0) {
    throw TaskError.usage(
      'A log entry needs text: tasks log <task> "<text>".',
      { text },
    );
  }
  assertLogText(text);
  return text;
}

async function appendNarrative(
  context: CommandContext,
  taskArg: string,
  text: string,
): Promise<void> {
  const { load, path } = await addressTree(context, taskArg);
  // History, not state: the manifest does not change, so neither does
  // `updated`, and nothing index.md renders depends on the log.
  const entry = await withMutation(
    context,
    load,
    async (fresh): Promise<LogEntryJson> => {
      const task = resolveTaskArg(fresh.tree, path);
      await appendLogEntry(
        task.dir,
        logEntryFor(context.identity, fresh.now, [text]),
      );
      // Read back, so the result is the entry as every reader will parse it.
      const entries = await readLog(task.dir);
      return toLogEntryJson(
        entries[entries.length - 1]!,
        context.projects.qualify(fresh.load, task.id),
      );
    },
    { refreshIndex: false },
  );

  if (context.json) {
    emitJson(entry);
    return;
  }
  const via = entry.via === null ? "" : ` via ${entry.via}`;
  const session = entry.session === null ? "" : ` s:${entry.session}`;
  writeOut(
    ui.success(
      `log ${entry.task}: ${entry.time} ${entry.actor}${via}${session}`,
    ),
  );
}

/**
 * `tasks log <task>` without text: one task's entries, oldest first, as the
 * entries object, narrowed by `--since` and `--actor` on request; with
 * `--archived`, a task under `.archive/` by its former path in full. A read,
 * so no lock and no `updated`.
 */
async function readTaskLog(
  context: CommandContext,
  taskArg: string,
  archived: boolean,
  filter: EntryFilter,
): Promise<void> {
  const { load, path } = await addressTree(
    context,
    taskArg,
    archived ? "path" : "task",
  );
  const task = archived
    ? readArchivedTask(context, load, path)
    : resolveTaskArg(load.tree, path);
  const id = context.projects.qualify(load, task.id);
  const entries = (await readLog(task.dir))
    .filter((entry) => passes(entry, filter))
    .map((entry) => toLogEntryJson(entry, id));
  const result: LogEntriesJson = { count: entries.length, entries };

  if (context.json) {
    emitJson(result);
    return;
  }
  writeOut(renderLogEntries(entries, archived ? new Set([id]) : undefined));
}

/** Canonical timestamps order correctly as text. */
function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

interface Collected {
  entry: LogEntry;
  task: string;
  /** Position of the tree among those read: local first. */
  tree: number;
  /** The id inside its tree, for ordering. */
  id: string;
  /** Position in the task's log, so equal times keep the file's order. */
  index: number;
}

interface Since {
  entries: LogEntryJson[];
  /** Qualified ids of the archived tasks among them, for the human marker. */
  archived: Set<string>;
}

/**
 * Entries at or after `since` from every live task of `trees` — and, with
 * `archived`, from every archived task too, under its former id — oldest
 * first, one actor's only and under one scope only on request. Equal times
 * order by tree (local first, then listed projects in configuration order),
 * then task id, then position in the log.
 */
async function collectEntries(
  context: CommandContext,
  trees: LoadedTree[],
  filter: EntryFilter,
  scope: string | null,
  archived: boolean,
): Promise<Since> {
  const found: Collected[] = [];
  const fromArchive = new Set<string>();
  for (const [rank, load] of trees.entries()) {
    // A manifest that does not parse still has a history worth listing.
    const dirs = [
      ...load.tree.tasks.map((task) => ({ id: task.id, dir: task.dir })),
      ...load.tree.malformed
        .filter((entry) => entry.id !== "")
        .map((entry) => ({ id: entry.id, dir: entry.dir })),
    ];
    if (archived) {
      for (const entry of [
        ...load.tree.archived,
        ...load.tree.archivedMalformed,
      ]) {
        if (entry.id === "") continue;
        dirs.push({ id: entry.id, dir: entry.dir });
        fromArchive.add(context.projects.qualify(load, entry.id));
      }
    }
    for (const { id, dir } of dirs) {
      if (scope !== null && !isWithin(id, scope)) continue;
      const task = context.projects.qualify(load, id);
      (await readLog(dir)).forEach((entry, index) => {
        if (passes(entry, filter)) {
          found.push({ entry, task, tree: rank, id, index });
        }
      });
    }
  }
  found.sort(
    (a, b) =>
      compareText(a.entry.time, b.entry.time) ||
      a.tree - b.tree ||
      compareIds(a.id, b.id) ||
      a.index - b.index,
  );
  return {
    entries: found.map(({ entry, task }) => toLogEntryJson(entry, task)),
    archived: fromArchive,
  };
}

async function listSince(
  context: CommandContext,
  filter: EntryFilter,
  options: LogOptions,
): Promise<void> {
  // A scope is a path of the local tree, so it keeps the listing to that
  // tree, as a scope keeps an overview.
  const scope =
    options.scope === undefined
      ? null
      : assertLocalScope(context, options.scope);
  const trees =
    options.local === true || scope !== null
      ? [context.projects.local]
      : await context.trees();
  const { entries, archived } = await collectEntries(
    context,
    trees,
    filter,
    scope,
    options.archived === true,
  );
  const result: LogEntriesJson = { count: entries.length, entries };

  if (context.json) {
    emitJson(result);
    return;
  }
  writeOut(renderLogEntries(entries, archived));
}

export function logCommand(): Command {
  return new Command("log")
    .summary(
      "append a narrative log entry to a task, read a task's log, or list entries since a time (--since), one actor's or one scope's on request",
    )
    .description(
      'append a narrative entry to a task\'s log.md (tasks log <task> "<text>"),\n' +
        "print a task's entries (tasks log <task>, since a time with --since),\n" +
        "or list the entries since a time across the local tree and every\n" +
        "listed project, oldest first (tasks log --since 7d); --actor keeps one\n" +
        "actor's entries, --scope those under one task or group",
    )
    .argument(
      "[task]",
      "the task whose log.md receives the entry, or whose log is read when no text follows",
    )
    .argument("[text...]", "the entry's text")
    .option(
      "--since <when>",
      "list entries since a timestamp, a date, or a duration back from now (30m, 12h, 7d, 2w)",
    )
    .option(
      "--actor <actor>",
      "only the entries this actor wrote, in a listing or in a task's log",
    )
    .option(
      "--scope <path>",
      "with --since: only the entries of this task or group of the local tree and everything beneath it; keeps to that tree",
    )
    .option("--local", "with --since: the local tree only")
    .option(
      "--archived",
      "read the log of a task under .archive/ (by its former path in full), or include the archive in --since",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(
      async (
        task: string | undefined,
        words: string[],
        options: LogOptions,
        command: Command,
      ) => {
        const actor = options.actor ?? null;
        if (options.since !== undefined) {
          const since = parseSince(options.since);
          if (task === undefined) {
            await listSince(
              await openContext(command),
              { since, actor },
              options,
            );
            return;
          }
          if (words.length > 0) {
            throw TaskError.usage(
              "--since lists entries: drop the text to read the task's history since a time, or drop --since to append.",
              { task, since: options.since },
            );
          }
          if (options.scope !== undefined) {
            throw TaskError.usage(
              "--scope narrows a listing across the tree; a task's history is already one task's.",
              { task, scope: options.scope },
            );
          }
          await readTaskLog(
            await openContext(command),
            task,
            options.archived === true,
            { since, actor },
          );
          return;
        }
        if (task === undefined) {
          throw TaskError.usage(
            'Name a task and the text to append (tasks log <task> "<text>"), or list entries with --since.',
          );
        }
        if (options.local === true) {
          throw TaskError.usage("--local applies to log --since only.", {
            task,
          });
        }
        if (options.scope !== undefined) {
          throw TaskError.usage("--scope applies to log --since only.", {
            task,
            scope: options.scope,
          });
        }
        if (words.length === 0) {
          await readTaskLog(
            await openContext(command),
            task,
            options.archived === true,
            { since: null, actor },
          );
          return;
        }
        if (actor !== null) {
          throw TaskError.usage(
            "--actor filters a listing; an entry is written under the acting identity (--as names someone else).",
            { task, actor },
          );
        }
        if (options.archived === true) {
          throw TaskError.usage(
            "--archived reads a log; an archived task's log is not appended to. Restore the task first.",
            { task },
          );
        }
        const text = entryText(words);
        await appendNarrative(await openContext(command), task, text);
      },
    );
}
