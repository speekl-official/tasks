import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./fs-utils.js";
import { INDEX_FILENAME, type TaskTree } from "./repo.js";
import type { Task } from "./task.js";
import { taskTitle } from "./task.js";
import { indexTemplate } from "./templates.js";

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function phaseSection(phase: string, tasks: Task[]): string {
  const rows = tasks
    .map((task) => {
      const deps = task.depends_on.length ? task.depends_on.join(", ") : "—";
      const link = `[${escapeCell(task.id)}](${encodeURI(`${phase}/${task.id}.md`)})`;
      return `| ${link} | ${escapeCell(task.status)} | ${escapeCell(taskTitle(task))} | ${escapeCell(deps)} |`;
    })
    .join("\n");

  return [
    `## ${phase}`,
    "",
    "| Task | Status | Title | Depends on |",
    "| --- | --- | --- | --- |",
    rows,
    "",
  ].join("\n");
}

export function renderIndex(tree: TaskTree): string {
  if (tree.tasks.length === 0) {
    return indexTemplate("_No tasks yet._\n");
  }

  const byPhase = new Map<string, Task[]>();
  for (const task of tree.tasks) {
    const bucket = byPhase.get(task.phase);
    if (bucket) bucket.push(task);
    else byPhase.set(task.phase, [task]);
  }

  const sections = [...byPhase.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([phase, tasks]) =>
      phaseSection(
        phase,
        [...tasks].sort((a, b) => a.id.localeCompare(b.id)),
      ),
    )
    .join("\n");

  return indexTemplate(sections);
}

export function indexPath(tree: TaskTree): string {
  return path.join(tree.project.tasksDir, INDEX_FILENAME);
}

export async function writeIndex(tree: TaskTree): Promise<string> {
  const file = indexPath(tree);
  await writeFileAtomic(file, renderIndex(tree));
  return file;
}

/** Line endings vary with git's checkout settings; only content matters here. */
function normalize(contents: string): string {
  return contents.replace(/\r\n/g, "\n");
}

/**
 * True when `_index.md` exists and no longer matches the tree it describes. A
 * missing index is not stale: regeneration is explicit, so a tree that has
 * never been reindexed is a valid state.
 */
export async function isIndexStale(tree: TaskTree): Promise<boolean> {
  let current: string;
  try {
    current = await fs.readFile(indexPath(tree), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  return normalize(current) !== normalize(renderIndex(tree));
}
