import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";

import type { CommandContext } from "../context.js";
import { openContext } from "../context.js";
import type { Addressed } from "../core/archive.js";
import { addressTree, authorize, displayPath } from "../core/archive.js";
import { withMutation } from "../core/mutate.js";
import { resolveTaskArg } from "../core/tree.js";
import { STATE_FILENAME } from "../core/types.js";
import { readState, writeState } from "../core/workspace.js";
import { TaskError, isTaskError } from "../errors.js";
import { emitJson, ui, writeErr, writeOut } from "../output.js";

/** What `--edit` opens when the task has no resume point yet. */
export const STATE_SKELETON = "## Done\n\n## Verified\n\n## Open\n\n## Next\n";

interface StateOptions {
  edit?: boolean;
  force?: boolean;
  json?: boolean;
}

export interface StateResult {
  id: string;
  /** Absolute path of `state.md`. */
  path: string;
  /** Size of what was written, in UTF-8 bytes. */
  bytes: number;
}

/**
 * The whole of a stream as UTF-8: the new `state.md` when no `--edit` is
 * given. `process.stdin` is read at call time, so a test can substitute it.
 */
export async function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `VISUAL`, then `EDITOR`; an empty variable counts as unset. */
function editorCommand(): string {
  for (const name of ["VISUAL", "EDITOR"]) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  throw TaskError.usage(
    "--edit needs an editor: set VISUAL or EDITOR, or pipe the new state.md to `tasks state <task>` on standard input.",
    { variables: ["VISUAL", "EDITOR"] },
  );
}

/**
 * Run the editor on `file` with the terminal handed over, and resolve with
 * how it ended. The variable is a shell command line (`code --wait` works),
 * so it runs through the shell with the file as its argument, as git does.
 */
function runEditor(
  editor: string,
  file: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(`${editor} "${file}"`, { shell: true, stdio: "inherit" })
        : spawn("/bin/sh", ["-c", `${editor} "$@"`, editor, file], {
            stdio: "inherit",
          });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

interface Edited {
  content: string;
  /** The editor's copy, kept when the write is refused so no text is lost. */
  file: string;
  dir: string;
}

/**
 * Open a copy of `initial` in the caller's editor, outside the tree lock (an
 * editing session can last minutes), and return what it saved. A non-zero
 * exit is the person's way to abandon the edit: nothing is written.
 */
async function editInEditor(initial: string): Promise<Edited> {
  const editor = editorCommand();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-state-"));
  const file = path.join(dir, STATE_FILENAME);
  try {
    await fs.writeFile(file, initial, "utf8");
    const { code, signal } = await runEditor(editor, file);
    if (code !== 0) {
      const how =
        code === null
          ? `was terminated by ${signal ?? "a signal"}`
          : `exited with code ${code}`;
      throw TaskError.conflict(`The editor ${how}; state.md was not written.`, {
        editor,
        code,
        signal,
      });
    }
    return { content: await fs.readFile(file, "utf8"), file, dir };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** A refused write, naming where the edited text was kept. */
function keptEdit(err: unknown, file: string): unknown {
  if (!isTaskError(err)) return err;
  return new TaskError(
    err.code,
    `${err.message} Your edit is kept at ${file}.`,
    {
      ...err.details,
      kept: file,
    },
  );
}

function assertNotEmpty(content: string): void {
  if (content.trim().length === 0) {
    throw TaskError.usage(
      "Refusing to write an empty state.md: it is the task's resume point.",
      { bytes: Buffer.byteLength(content, "utf8") },
    );
  }
}

async function writeResumePoint(
  context: CommandContext,
  addressed: Addressed,
  content: string,
  options: StateOptions,
  /** The `state.md` the editor started from, `undefined` without --edit. */
  basis: string | null | undefined,
): Promise<StateResult> {
  const { load, path: taskPath } = addressed;
  // No transition, no log entry, no manifest change. index.md is refreshed
  // as after any write: whether state.md exists decides `parked`.
  return withMutation(context, load, async (fresh) => {
    const task = resolveTaskArg(fresh.tree, taskPath);
    const shown = context.projects.qualify(fresh.load, task.id);
    // The fence: re-checked inside the lock, so a session whose claim was
    // taken over learns of it here instead of overwriting the new
    // claimant's resume point.
    await authorize(fresh.tree, task, context.identity, {
      force: options.force,
      label: shown,
    });
    if (basis !== undefined && (await readState(task.dir)) !== basis) {
      throw TaskError.conflict(
        `${shown}: state.md changed while it was being edited; nothing was written.`,
        { id: shown, kind: "state-changed" },
      );
    }
    await writeState(task.dir, content);
    return {
      id: shown,
      path: path.join(task.dir, STATE_FILENAME),
      bytes: Buffer.byteLength(content, "utf8"),
    };
  });
}

export function stateCommand(): Command {
  return new Command("state")
    .summary(
      "replace a task's state.md from standard input, or edit it with --edit",
    )
    .description(
      "replace a task's state.md, its resume point, with standard input, or\n" +
        "edit it in $VISUAL / $EDITOR with --edit; no transition, no log entry,\n" +
        "and a claimed task is written only by its claimant's session",
    )
    .argument("<task>", "the task whose state.md to write")
    .option("--edit", "open the current state.md (or a skeleton) in the editor")
    .option(
      "--force",
      "override authorization (another session's live claim, an assignee)",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(async (arg: string, options: StateOptions, command: Command) => {
      const context = await openContext(command);
      const addressed = await addressTree(context, arg);

      // Fail before reading input or opening an editor when the write would
      // be refused anyway; the lock re-checks all of it.
      const task = resolveTaskArg(addressed.load.tree, addressed.path);
      await authorize(addressed.load.tree, task, context.identity, {
        force: options.force,
        label: context.projects.qualify(addressed.load, task.id),
      });

      let result: StateResult;
      if (options.edit === true) {
        const basis = await readState(task.dir);
        const edited = await editInEditor(basis ?? STATE_SKELETON);
        try {
          assertNotEmpty(edited.content);
        } catch (err) {
          await fs.rm(edited.dir, { recursive: true, force: true });
          throw err;
        }
        try {
          result = await writeResumePoint(
            context,
            addressed,
            edited.content,
            options,
            basis,
          );
        } catch (err) {
          // The editor's copy stays, so the person's text is never lost.
          throw keptEdit(err, edited.file);
        }
        await fs.rm(edited.dir, { recursive: true, force: true });
      } else {
        // A hint on stderr would break the one JSON document an error is.
        if (process.stdin.isTTY && !context.json) {
          writeErr(
            ui.dim(
              "Reading the new state.md from standard input; end it with Ctrl-D (or use --edit).",
            ),
          );
        }
        const content = await readStdin();
        assertNotEmpty(content);
        result = await writeResumePoint(
          context,
          addressed,
          content,
          options,
          undefined,
        );
      }

      if (context.json) {
        emitJson(result);
        return;
      }
      writeOut(
        ui.success(
          `state ${result.id}: wrote ${result.bytes} bytes to ${displayPath(result.path)}`,
        ),
      );
    });
}
