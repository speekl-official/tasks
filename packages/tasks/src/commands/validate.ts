import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { openTree } from "../context.js";
import {
  DependencyResolver,
  describeUnsatisfied,
  findCycles,
} from "../core/deps.js";
import { writeFileAtomic } from "../core/fs-utils.js";
import { renderTaskFile } from "../core/frontmatter.js";
import { indexPath, isIndexStale, writeIndex } from "../core/index-md.js";
import { parseRef } from "../core/refs.js";
import {
  INDEX_FILENAME,
  taskFilePath,
  toFrontmatter,
  type TaskTree,
} from "../core/repo.js";
import type { Task } from "../core/task.js";
import { emitJson, ui, writeOut } from "../output.js";
import { ExitCode } from "../errors.js";

type Severity = "error" | "warning";

interface Finding {
  severity: Severity;
  kind: string;
  message: string;
  taskId?: string;
  file?: string;
  /** Whether `--fix` can repair this mechanically. */
  fixable: boolean;
}

function collect(tree: TaskTree): Finding[] {
  const findings: Finding[] = [];

  for (const bad of tree.malformed) {
    findings.push({
      severity: "error",
      kind: "malformed",
      message: `${path.relative(tree.project.root, bad.filePath)}: ${bad.reason}`,
      file: bad.filePath,
      fixable: false,
    });
  }

  const seen = new Map<string, Task>();
  for (const task of tree.tasks) {
    const duplicate = seen.get(task.id);
    if (duplicate) {
      findings.push({
        severity: "error",
        kind: "duplicate-id",
        taskId: task.id,
        message: `Duplicate id "${task.id}" in ${path.relative(tree.project.root, duplicate.filePath)} and ${path.relative(tree.project.root, task.filePath)}.`,
        file: task.filePath,
        fixable: false,
      });
    } else {
      seen.set(task.id, task);
    }

    if (task.filenameId !== task.id) {
      findings.push({
        severity: "error",
        kind: "filename-mismatch",
        taskId: task.id,
        message: `File is named "${task.filenameId}.md" but declares id "${task.id}".`,
        file: task.filePath,
        fixable: true,
      });
    }

    if (task.frontmatterPhase !== task.phase) {
      findings.push({
        severity: "error",
        kind: "phase-drift",
        taskId: task.id,
        message: `Frontmatter says phase "${task.frontmatterPhase}" but the file lives in "${task.phase}". The directory wins.`,
        file: task.filePath,
        fixable: true,
      });
    }

    if (!tree.config.isValidStatus(task.status)) {
      findings.push({
        severity: "error",
        kind: "unknown-status",
        taskId: task.id,
        message: `Status "${task.status}" is not in the configured statuses [${tree.config.statuses.join(", ")}].`,
        file: task.filePath,
        fixable: false,
      });
    }

    for (const raw of task.depends_on) {
      try {
        parseRef(raw);
      } catch (err) {
        findings.push({
          severity: "error",
          kind: "malformed-ref",
          taskId: task.id,
          message: `Dependency "${raw}" is invalid: ${(err as Error).message}`,
          file: task.filePath,
          fixable: false,
        });
      }
    }
  }

  for (const cycle of findCycles(tree.tasks)) {
    findings.push({
      severity: "error",
      kind: "cycle",
      message: `Dependency cycle: ${cycle.join(" → ")}`,
      fixable: false,
    });
  }

  return findings;
}

async function collectUnresolved(tree: TaskTree): Promise<Finding[]> {
  const resolver = new DependencyResolver(tree);
  const findings: Finding[] = [];

  for (const task of tree.tasks) {
    const deps = await resolver.resolveAll(task.depends_on);
    for (const dep of deps) {
      if (dep.satisfied || dep.reason === "not-done") continue;
      findings.push({
        // Blocking-but-unresolvable is a warning: it's fail-safe by design, but
        // almost always signals a typo or a deleted task.
        severity: "warning",
        kind: `dependency-${dep.reason}`,
        taskId: task.id,
        message: `Dependency ${describeUnsatisfied(dep)} will never be satisfied, so "${task.id}" can never become ready.`,
        file: task.filePath,
        fixable: false,
      });
    }
  }

  return findings;
}

/**
 * `_index.md` is generated and no command reads it, so drift is cosmetic — but
 * it is committed, so a stale one misleads reviewers in a diff.
 */
async function collectStaleIndex(tree: TaskTree): Promise<Finding[]> {
  if (!(await isIndexStale(tree))) return [];

  return [
    {
      // A warning, never an error: the index is explicitly not a source of
      // truth, so CI must not fail on it.
      severity: "warning",
      kind: "stale-index",
      message: `${INDEX_FILENAME} no longer matches the tasks on disk. Regenerate it with \`tasks reindex\`.`,
      file: indexPath(tree),
      fixable: true,
    },
  ];
}

async function applyFixes(
  tree: TaskTree,
  findings: Finding[],
): Promise<string[]> {
  const applied: string[] = [];

  for (const task of tree.tasks) {
    const relevant = findings.filter(
      (f) => f.fixable && f.taskId === task.id && f.file === task.filePath,
    );
    if (relevant.length === 0) continue;

    // The directory is authoritative for phase, and `id` for the filename.
    const repaired = { ...task, phase: task.phase };
    const destination = taskFilePath(tree.project, task.phase, task.id);

    await writeFileAtomic(
      destination,
      renderTaskFile(toFrontmatter(repaired), repaired.body),
    );
    if (destination !== task.filePath) {
      await fs.rm(task.filePath, { force: true });
    }

    for (const finding of relevant) {
      applied.push(`${finding.kind}: ${task.id}`);
    }
  }

  // Last, so the regenerated index reflects any task repairs made above.
  if (findings.some((f) => f.kind === "stale-index" && f.fixable)) {
    await writeIndex(tree);
    applied.push(`stale-index: ${INDEX_FILENAME}`);
  }

  return applied;
}

export function validateCommand(): Command {
  return new Command("validate")
    .description("check tree integrity and report anything that has drifted")
    .option("--fix", "repair the mechanically safe findings")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { fix?: boolean; json?: boolean }) => {
      const tree = await openTree();

      const structural = collect(tree);
      const unresolved = await collectUnresolved(tree);
      const staleIndex = await collectStaleIndex(tree);
      const findings = [...structural, ...unresolved, ...staleIndex];

      const applied = options.fix ? await applyFixes(tree, findings) : [];
      const remaining = options.fix
        ? findings.filter((f) => !f.fixable)
        : findings;

      const errors = remaining.filter((f) => f.severity === "error");
      const warnings = remaining.filter((f) => f.severity === "warning");

      if (options.json) {
        emitJson({
          ok: errors.length === 0,
          checked: tree.tasks.length,
          fixed: applied,
          findings: remaining.map((f) => ({
            severity: f.severity,
            kind: f.kind,
            message: f.message,
            task: f.taskId ?? null,
            file: f.file ?? null,
          })),
        });
      } else {
        for (const fix of applied) writeOut(ui.success(`fixed ${fix}`));
        for (const finding of errors) writeOut(ui.error(finding.message));
        for (const finding of warnings) writeOut(ui.warn(finding.message));

        if (remaining.length === 0 && applied.length === 0) {
          writeOut(
            ui.success(
              `No problems found (${tree.tasks.length} task(s) checked).`,
            ),
          );
        } else {
          writeOut("");
          writeOut(
            ui.dim(
              `${errors.length} error(s), ${warnings.length} warning(s), ${applied.length} fixed`,
            ),
          );
        }
      }

      // Errors mean the tree is inconsistent — a nonzero exit lets CI gate on it.
      if (errors.length > 0) process.exitCode = ExitCode.Conflict;
    });
}
