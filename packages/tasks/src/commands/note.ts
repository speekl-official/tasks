import { Command } from "commander";

import { openContext } from "../context.js";
import { addressTree, derivedTaskJson } from "../core/archive.js";
import { withMutation } from "../core/mutate.js";
import { appendNote, assertNoteText, noteItem } from "../core/notes.js";
import { resolveTaskArg, writeTask } from "../core/tree.js";
import { appendLogEntry, logEntryFor } from "../core/workspace.js";
import { emitTaskJson, ui, writeOut } from "../output.js";
import { FIELDS_FLAG, FIELDS_HELP } from "./options.js";

interface NoteOptions {
  json?: boolean;
}

/** The note is the caller's words; only what would corrupt a file is refused. */
function noteText(words: string[]): string {
  const text = words.join(" ");
  assertNoteText(text);
  return text;
}

export function noteCommand(): Command {
  return new Command("note")
    .description(
      "append a dated, attributed note under ## Notes of the task's task.md — an input for whoever works on it next — and log it; no transition, no authorization",
    )
    .argument(
      "<task>",
      "full path, an unambiguous suffix, or alias:path in a listed project",
    )
    .argument("<text...>", "the note; several words are joined with spaces")
    .option("--json", "emit machine-readable JSON")
    .option(FIELDS_FLAG, FIELDS_HELP)
    .action(
      async (
        taskArg: string,
        words: string[],
        options: NoteOptions,
        command: Command,
      ) => {
        void options;
        const context = await openContext(command);
        const text = noteText(words);
        const { load, path } = await addressTree(context, taskArg);

        const outcome = await withMutation(context, load, async (fresh) => {
          const task = resolveTaskArg(fresh.tree, path);
          const item = noteItem(
            fresh.now.slice(0, 10),
            context.identity.actor,
            context.identity.via,
            text,
          );
          await writeTask({
            ...task,
            frontmatter: { ...task.frontmatter, updated: fresh.now },
            body: appendNote(task.body, item),
          });
          await appendLogEntry(
            task.dir,
            logEntryFor(context.identity, fresh.now, ["note", text]),
          );
          return {
            id: task.id,
            shown: context.projects.qualify(fresh.load, task.id),
          };
        });

        const json = await derivedTaskJson(context, load, outcome.id);
        if (context.json) {
          emitTaskJson(context, json);
          return;
        }
        const first = text.trim().split(/\r?\n/)[0]!;
        writeOut(
          [
            ui.success(`note ${outcome.shown}: ${first}`),
            `  ${ui.dim("appended under ## Notes of task.md, and logged")}`,
          ].join("\n"),
        );
      },
    );
}
