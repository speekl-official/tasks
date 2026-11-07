import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { TaskError } from "../errors.js";
import { errnoCode, writeFileAtomic } from "./fs-utils.js";
import { AGENT_ACTOR } from "./types.js";

/** Claude Code's shared project settings, where its hooks are configured. */
export const SETTINGS_RELATIVE_PATH = path.join(".claude", "settings.json");

/** The actor the hooks act as unless `--actor` names another. */
export const DEFAULT_HOOKS_ACTOR = AGENT_ACTOR;

/** The events the hooks attach to, in the order the block lists them. */
export const HOOK_EVENTS = [
  "SessionStart",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The subcommand that makes a hook of each event a tasks hook. */
const SUBCOMMANDS: Record<HookEvent, string> = {
  SessionStart: "mine",
  PostToolUse: "heartbeat",
  Stop: "session-check",
  SessionEnd: "session-end",
};

const SESSION_START_NOTE =
  "Your tasks (tasks mine --json). Resume a claimed task with tasks resume <id> before taking new work; a task only assigned to you is your inbox.";

const STOP_NOTE =
  "A claimed task has no state.md. Write its resume point (tasks state <task>), or pause, hand off or finish it, before ending the turn:";

/**
 * The shell command of each hook, for `actor`: the commands of the harness
 * guide (`apps/docs/content/docs/guides/harness.mdx`) character for
 * character, one statement per line here; a test holds the two together.
 * The actor matches the actor pattern, which admits nothing the shell or
 * `printf` would read as special, so it is spliced in as it is.
 */
function hookCommands(actor: string): Record<HookEvent, string> {
  const env = `TASKS_ACTOR=${actor}`;
  const session = String.raw`--session "$(jq -r .session_id)"`;
  return {
    SessionStart: [
      "sid=$(jq -r .session_id)",
      String.raw`[ -n "$CLAUDE_ENV_FILE" ] && printf 'export TASKS_SESSION=%s\nexport ${env}\n' "$sid" >> "$CLAUDE_ENV_FILE"`,
      String.raw`mine=$(${env} tasks mine --json --session "$sid" 2>/dev/null) && printf '${SESSION_START_NOTE}\n%s\n' "$mine"`,
      "exit 0",
    ].join("; "),
    PostToolUse: [
      `${env} tasks heartbeat ${session} >/dev/null 2>&1`,
      "exit 0",
    ].join("; "),
    Stop: [
      `out=$(${env} tasks session-check --json ${session} 2>/dev/null)`,
      "code=$?",
      String.raw`if [ "$code" -eq 4 ]; then printf '${STOP_NOTE}\n%s\n' "$out" >&2; exit 2; fi`,
      String.raw`[ "$code" -eq 0 ] && printf '%s' "$out" | jq -c 'select(.warnings | length > 0) | {systemMessage: ([.warnings[].message] | join("\n"))}'`,
      "exit 0",
    ].join("; "),
    SessionEnd: [
      `${env} tasks session-end ${session} >/dev/null 2>&1`,
      "exit 0",
    ].join("; "),
  };
}

/** One command a hook runs, as Claude Code's settings spell it. */
interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

/** An entry of an event: the hooks it runs. No matcher: on every occasion. */
interface HookEntry {
  hooks: CommandHook[];
}

/** The entry the block gives `event`, acting as `actor`. */
function hookEntry(event: HookEvent, actor: string): HookEntry {
  const hook: CommandHook = {
    type: "command",
    command: hookCommands(actor)[event],
  };
  // SessionEnd hooks get 1.5 seconds by default; the block raises this
  // one's budget to ten.
  if (event === "SessionEnd") hook.timeout = 10;
  return { hooks: [hook] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The hooks an entry runs; none for an entry of any other shape. */
function hooksOf(entry: unknown): unknown[] {
  return isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
}

/**
 * A hook of `event` that runs the event's tasks subcommand: `tasks mine`,
 * the program also reached through a path or a package runner
 * (`./node_modules/.bin/tasks mine`, `npx @speekl/tasks mine`), as the
 * guide's adjustments write it.
 */
function isTasksHook(event: HookEvent, hook: unknown): boolean {
  if (!isRecord(hook) || typeof hook.command !== "string") return false;
  const invocation = new RegExp(
    String.raw`(?<![\w.-])tasks\s+${SUBCOMMANDS[event]}(?![\w-])`,
  );
  return invocation.test(hook.command);
}

function holdsTasksHook(
  event: HookEvent,
  entry: unknown,
): entry is Record<string, unknown> {
  return hooksOf(entry).some((hook) => isTasksHook(event, hook));
}

/**
 * The entries of `event` with its tasks hook in place, or `null` when they
 * stay as they are. A missing tasks hook is appended after the entries
 * already there. One that is present is kept, whatever its text, unless
 * `force`; then the documented entry takes the place of the first entry
 * holding a tasks hook, and the event's other tasks hooks go. A hook that
 * shares an entry with a tasks hook stays in that entry; an entry left with
 * nothing to run goes.
 */
function mergeEvent(
  event: HookEvent,
  entries: unknown[] | undefined,
  documented: HookEntry,
  force: boolean,
): unknown[] | null {
  if (entries === undefined) return [documented];
  const owned = entries.filter((entry) => holdsTasksHook(event, entry));
  if (owned.length === 0) return [...entries, documented];
  if (!force) return null;
  if (owned.length === 1 && isDeepStrictEqual(owned[0], documented)) {
    return null;
  }

  const merged: unknown[] = [];
  let placed = false;
  for (const entry of entries) {
    if (!holdsTasksHook(event, entry)) {
      merged.push(entry);
      continue;
    }
    if (!placed) {
      merged.push(documented);
      placed = true;
    }
    const others = hooksOf(entry).filter((hook) => !isTasksHook(event, hook));
    if (others.length > 0) merged.push({ ...entry, hooks: others });
  }
  return merged;
}

/** A settings file this command will not edit; nothing is written. */
function refused(
  file: string,
  problem: string,
  details: Record<string, unknown> = {},
): TaskError {
  return TaskError.usage(
    `${file}: ${problem}. Nothing was changed; fix the file, then run \`tasks hooks install\` again.`,
    { file, ...details },
  );
}

/** The settings as a JSON object, `null` when the file does not exist. */
async function readSettings(
  file: string,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    switch (errnoCode(err)) {
      case "ENOENT":
        return null;
      case "EISDIR":
        throw refused(file, "is a directory, not a settings file");
      case "ENOTDIR":
        throw refused(file, `${path.dirname(file)} is not a directory`);
      default:
        throw err;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw refused(file, `is not valid JSON (${reason})`);
  }
  if (!isRecord(parsed)) throw refused(file, "does not hold a JSON object");
  return parsed;
}

export interface HooksInstallResult {
  /** False when every event already had its tasks hook: nothing was written. */
  installed: boolean;
  file: string;
  /** The actor the hooks this run writes act as. */
  actor: string;
  /** The events whose tasks hook this run added or replaced. */
  written: HookEvent[];
  /** The events whose tasks hook was already there and was left as it was. */
  kept: HookEvent[];
  skippedReason?: "exists";
}

/**
 * Install the harness hooks into `<projectRoot>/.claude/settings.json`, the
 * file and its directory created when absent. Everything else the file
 * holds — other settings, other events, other entries of the same events —
 * is kept where it is. An event that already has a tasks hook keeps it, so
 * a local edit survives; `force` replaces it with the documented entry.
 *
 * When nothing is to change the file is not touched, its formatting
 * included; otherwise it is rewritten with two-space indentation.
 */
export async function installHooks(
  projectRoot: string,
  options: { actor: string; force?: boolean },
): Promise<HooksInstallResult> {
  const { actor } = options;
  const file = path.join(projectRoot, SETTINGS_RELATIVE_PATH);
  const settings = (await readSettings(file)) ?? {};
  const hooks = settings.hooks === undefined ? {} : settings.hooks;
  if (!isRecord(hooks)) {
    throw refused(file, '"hooks" is not an object of events', {
      key: "hooks",
    });
  }

  const written: HookEvent[] = [];
  const kept: HookEvent[] = [];
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event];
    if (entries !== undefined && !Array.isArray(entries)) {
      throw refused(file, `"hooks.${event}" is not a list of entries`, {
        key: `hooks.${event}`,
      });
    }
    const merged = mergeEvent(
      event,
      entries,
      hookEntry(event, actor),
      options.force === true,
    );
    if (merged === null) {
      kept.push(event);
    } else {
      hooks[event] = merged;
      written.push(event);
    }
  }

  if (written.length === 0) {
    return {
      installed: false,
      file,
      actor,
      written,
      kept,
      skippedReason: "exists",
    };
  }
  settings.hooks = hooks;
  await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { installed: true, file, actor, written, kept };
}
