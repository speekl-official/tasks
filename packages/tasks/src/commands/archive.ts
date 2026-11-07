import { Command } from "commander";

import type { CommandContext } from "../context.js";
import { openContext } from "../context.js";
import type {
  ResolvedArchiveJson,
  SkippedResolvedJson,
} from "../core/archive.js";
import {
  addressTree,
  archiveResolved,
  archiveTask,
  deleteTask,
  derivedTaskJson,
  displayPath,
  purgeArchive,
  restoreTask,
} from "../core/archive.js";
import { daysBefore, parseSince } from "../core/time.js";
import { TaskError } from "../errors.js";
import { emitJson, renderTransitionResult, ui, writeOut } from "../output.js";

interface ForceOptions {
  force?: boolean;
  json?: boolean;
}

interface JsonOptions {
  json?: boolean;
}

export function archiveCommand(): Command {
  return new Command("archive")
    .summary("move a resolved task and its subtree to .tasks/.archive/")
    .description(
      "move a resolved task and its subtree to .tasks/.archive/, where it\n" +
        "satisfies no gate and keeps its path reserved; refused while a\n" +
        "descendant is open or open tasks reference the subtree. With\n" +
        "--resolved-before or --all-resolved: every resolved subtree of this\n" +
        "tree, skipping and listing the ones a refusal keeps",
    )
    .argument("[task]", "the task to archive; none with the batch options")
    .option(
      "--force",
      "archive although open tasks reference it; they are reported as left blocked",
    )
    .option(
      "--resolved-before [when]",
      "archive every resolved subtree whose root was resolved before a timestamp, a date or a duration back from now (30d, 2w); without a value, config.yml's archive_resolved_after_days",
    )
    .option(
      "--all-resolved",
      "archive every resolved subtree, whatever its age",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(
      async (
        arg: string | undefined,
        options: ArchiveCommandOptions,
        command: Command,
      ) => {
        const batch =
          options.resolvedBefore !== undefined || options.allResolved === true;
        if (batch) {
          await archiveBatch(arg, options, command);
          return;
        }
        if (arg === undefined) {
          throw TaskError.usage(
            "archive needs a task, or --resolved-before <when> / --all-resolved for every resolved subtree.",
          );
        }
        const context = await openContext(command);
        const { load, path: rest } = await addressTree(context, arg);
        const result = await archiveTask(context, load, rest, {
          force: options.force,
        });

        if (context.json) {
          emitJson(result);
          return;
        }
        const lines = [
          ui.success(`archive ${result.id} → ${displayPath(result.path)}`),
        ];
        if (result.tasks.length > 1) {
          lines.push(`  with ${result.tasks.slice(1).join(", ")}`);
        }
        if (result.left_blocked.length > 0) {
          lines.push(
            `  ${ui.warn(`left blocked: ${result.left_blocked.join(", ")}`)}`,
          );
        }
        writeOut(lines.join("\n"));
      },
    );
}

interface ArchiveCommandOptions {
  force?: boolean;
  json?: boolean;
  /** `true` without a value: the configured threshold. */
  resolvedBefore?: string | true;
  allResolved?: boolean;
}

/** The batch form: refuse what cannot combine with it, then run it. */
async function archiveBatch(
  arg: string | undefined,
  options: ArchiveCommandOptions,
  command: Command,
): Promise<void> {
  if (arg !== undefined) {
    throw TaskError.usage(
      "archive takes either a task or --resolved-before / --all-resolved, not both.",
      { argument: arg },
    );
  }
  if (options.resolvedBefore !== undefined && options.allResolved === true) {
    throw TaskError.usage(
      "--resolved-before and --all-resolved exclude each other.",
    );
  }
  if (options.force === true) {
    throw TaskError.usage(
      "--force does not combine with --resolved-before or --all-resolved: a root that open tasks reference is skipped and listed; archive it on its own with --force.",
    );
  }
  const context = await openContext(command);
  const before =
    options.allResolved === true
      ? null
      : thresholdOf(context, options.resolvedBefore ?? true);
  const result = await archiveResolved(context, before);
  if (context.json) {
    emitJson(result);
    return;
  }
  writeOut(renderResolvedArchive(result));
}

/** `--resolved-before`'s threshold: its value, else the configured days. */
function thresholdOf(context: CommandContext, when: string | true): string {
  const now = new Date();
  if (when !== true) return parseSince(when, now, "--resolved-before");
  const days = context.tree.config.archiveResolvedAfterDays;
  if (days === null) {
    throw TaskError.usage(
      "--resolved-before needs a value (30d, 2w, a date or a timestamp), or archive_resolved_after_days set in config.yml.",
      { key: "archive_resolved_after_days" },
    );
  }
  return daysBefore(days, now);
}

function renderResolvedArchive(result: ResolvedArchiveJson): string {
  const roots = result.archived.length;
  const count = result.archived.reduce(
    (sum, entry) => sum + entry.tasks.length,
    0,
  );
  const lines =
    roots === 0
      ? [ui.info("Nothing archived.")]
      : [
          ui.success(
            `archive ${roots} resolved ${roots === 1 ? "subtree" : "subtrees"} (${count} ${count === 1 ? "task" : "tasks"})${result.before === null ? "" : ` resolved before ${result.before}`}`,
          ),
        ];
  for (const entry of result.archived) {
    const rest = entry.tasks.slice(1);
    lines.push(
      `  ${entry.id}${rest.length === 0 ? "" : ui.dim(` with ${rest.join(", ")}`)}`,
    );
  }
  for (const entry of result.skipped) {
    lines.push(`  ${ui.warn(`skipped ${entry.id}: ${skipText(entry)}`)}`);
  }
  return lines.join("\n");
}

function skipText(entry: SkippedResolvedJson): string {
  const named = (key: string): string | null => {
    const value = entry[key];
    return Array.isArray(value) ? value.join(", ") : null;
  };
  switch (entry.reason) {
    case "dependents":
      return `referenced by ${named("dependents") ?? "open tasks"}`;
    case "open-descendants":
      return `open descendants ${named("open_descendants") ?? ""}`.trimEnd();
    default:
      return entry.reason;
  }
}

export function restoreCommand(): Command {
  return new Command("restore")
    .summary("move an archived task and its subtree back to the live tree")
    .description(
      "move an archived task and its archived subtree back to the live tree;\n" +
        "never under a resolved parent, never onto a live task",
    )
    .argument(
      "<path>",
      "the task's full path under .archive/ (no suffixes); alias:path for a listed project",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(async (arg: string, _options: JsonOptions, command: Command) => {
      const context = await openContext(command);
      const { load, path: archivePath } = await addressTree(
        context,
        arg,
        "path",
      );
      const result = await restoreTask(context, load, archivePath);
      const json = await derivedTaskJson(context, load, result.id);

      if (context.json) {
        emitJson(json);
        return;
      }
      const lines = [
        renderTransitionResult(json, { command: "restore" }),
        `  ${ui.dim(`${json.status} · ${displayPath(json.path)}`)}`,
      ];
      if (result.tasks.length > 1) {
        lines.push(`  with ${result.tasks.slice(1).join(", ")}`);
      }
      writeOut(lines.join("\n"));
    });
}

export function purgeCommand(): Command {
  return new Command("purge")
    .summary(
      "delete an archive entry for good and release the path it reserves",
    )
    .description(
      "delete an archive entry for good and release the path it reserves;\n" +
        "names the live tasks whose references would reach a task recreated there",
    )
    .argument(
      "<path>",
      "the entry's full path under .archive/ (no suffixes); alias:path for a listed project",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(async (arg: string, _options: JsonOptions, command: Command) => {
      const context = await openContext(command);
      const { load, path: archivePath } = await addressTree(
        context,
        arg,
        "path",
      );
      const result = await purgeArchive(context, load, archivePath);

      if (context.json) {
        emitJson(result);
        return;
      }
      const removed =
        result.removed.length === 0
          ? "no archived task"
          : result.removed.join(", ");
      const lines = [ui.success(`purge ${result.id}: removed ${removed}`)];
      if (result.referenced_by.length > 0) {
        lines.push(
          `  ${ui.warn(`still referenced by ${result.referenced_by.join(", ")}; a task created at the path satisfies them`)}`,
        );
      }
      writeOut(lines.join("\n"));
    });
}

export function deleteCommand(): Command {
  return new Command("delete")
    .summary("remove a never-worked task without archiving it")
    .description(
      "remove a never-worked task without archiving it: only its creation in\n" +
        "the log, no state.md, nothing beneath it, no live task referencing it",
    )
    .argument("<task>", "the task to delete")
    .option(
      "--force",
      "override authorization only (a claim, an assignee); the conditions stand",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(async (arg: string, options: ForceOptions, command: Command) => {
      const context = await openContext(command);
      const { load, path: rest } = await addressTree(context, arg);
      const result = await deleteTask(context, load, rest, {
        force: options.force,
      });

      if (context.json) {
        emitJson(result);
        return;
      }
      writeOut(ui.success(`delete ${result.id}`));
    });
}
