import { Command } from "commander";

import type { CommandContext } from "../context.js";
import { openContext } from "../context.js";
import { addressTree } from "../core/archive.js";
import { compareIds } from "../core/ids.js";
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
  local?: boolean;
  json?: boolean;
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

/**
 * Entries at or after `since` from every live task of `trees`, oldest first.
 * Equal times order by tree (local first, then listed projects in
 * configuration order), then task id, then position in the log.
 */
async function collectEntries(
  context: CommandContext,
  trees: LoadedTree[],
  since: string,
): Promise<LogEntryJson[]> {
  const found: Collected[] = [];
  for (const [rank, load] of trees.entries()) {
    // A manifest that does not parse still has a history worth listing.
    const dirs = [
      ...load.tree.tasks.map((task) => ({ id: task.id, dir: task.dir })),
      ...load.tree.malformed
        .filter((entry) => entry.id !== "")
        .map((entry) => ({ id: entry.id, dir: entry.dir })),
    ];
    for (const { id, dir } of dirs) {
      const task = context.projects.qualify(load, id);
      (await readLog(dir)).forEach((entry, index) => {
        if (entry.time >= since) {
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
  return found.map(({ entry, task }) => toLogEntryJson(entry, task));
}

async function listSince(
  context: CommandContext,
  arg: string,
  options: LogOptions,
): Promise<void> {
  const since = parseSince(arg);
  const trees =
    options.local === true ? [context.projects.local] : await context.trees();
  const entries = await collectEntries(context, trees, since);
  const result: LogEntriesJson = { count: entries.length, entries };

  if (context.json) {
    emitJson(result);
    return;
  }
  writeOut(renderLogEntries(entries));
}

export function logCommand(): Command {
  return new Command("log")
    .summary(
      "append a narrative log entry to a task, or list entries since a time (--since)",
    )
    .description(
      'append a narrative entry to a task\'s log.md (tasks log <task> "<text>"),\n' +
        "or list the entries since a time across the local tree and every\n" +
        "listed project, oldest first (tasks log --since 7d)",
    )
    .argument("[task]", "the task whose log.md receives the entry")
    .argument("[text...]", "the entry's text")
    .option(
      "--since <when>",
      "list entries since a timestamp, a date, or a duration back from now (30m, 12h, 7d, 2w)",
    )
    .option("--local", "with --since: the local tree only")
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(
      async (
        task: string | undefined,
        words: string[],
        options: LogOptions,
        command: Command,
      ) => {
        if (options.since !== undefined) {
          if (task !== undefined) {
            throw TaskError.usage(
              "Give a task and text to append an entry, or --since to list entries; not both.",
              { task, since: options.since },
            );
          }
          await listSince(await openContext(command), options.since, options);
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
        const text = entryText(words);
        await appendNarrative(await openContext(command), task, text);
      },
    );
}
