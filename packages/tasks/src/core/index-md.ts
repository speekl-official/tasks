import fs from "node:fs/promises";
import path from "node:path";

import type { DerivedTask } from "./derive.js";
import { priorityLabel, progressText, situationText } from "./derive.js";
import { errnoCode, writeFileAtomic } from "./fs-utils.js";
import { ancestorPaths, compareIds, parentOf } from "./ids.js";
import type { Tree } from "./tree.js";
import { indexTemplate } from "./templates.js";
import { INDEX_FILENAME, isResolved } from "./types.js";

/**
 * `index.md` is a derived view, committed with the tree and never read to
 * answer a query. Its rendering depends on nothing but the files: no
 * liveness, no timestamps, nothing that depends on who asks. That is what
 * makes a byte comparison a meaningful staleness check, and what keeps the
 * committed file from changing while the tree does not.
 */

type NodeKind = "task" | "malformed" | "group";

interface IndexNode {
  path: string;
  kind: NodeKind;
  children: IndexNode[];
}

function kindOf(tree: Tree, id: string): NodeKind {
  if (tree.byId.has(id)) return "task";
  if (tree.malformedById.has(id)) return "malformed";
  return "group";
}

/**
 * The directory structure that holds live tasks: every task, plus each
 * group or malformed task above one. Groups that hold no task are workspace
 * content and stay out.
 */
function buildForest(tree: Tree): IndexNode[] {
  const nodes = new Map<string, IndexNode>();
  const ids = [
    ...tree.tasks.map((task) => task.id),
    ...tree.malformed.map((entry) => entry.id).filter((id) => id !== ""),
  ];
  for (const id of ids) {
    for (const candidate of [id, ...ancestorPaths(id)]) {
      if (!nodes.has(candidate)) {
        nodes.set(candidate, {
          path: candidate,
          kind: kindOf(tree, candidate),
          children: [],
        });
      }
    }
  }

  const roots: IndexNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node.path);
    if (parent === null) roots.push(node);
    else nodes.get(parent)!.children.push(node);
  }
  const sort = (list: IndexNode[]) => {
    list.sort((a, b) => compareIds(a.path, b.path));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

function taskLine(tree: Tree, id: string, d: DerivedTask | undefined): string {
  const task = tree.byId.get(id)!;
  const parts = [`[${id}](${id}/) — ${task.title}`];
  if (d !== undefined) {
    parts.push(situationText(d));
    const priority = priorityLabel(d);
    // Priority orders work still to do; on a resolved task it is noise.
    if (priority !== null && !isResolved(d.json.status)) parts.push(priority);
    const { children } = d.derived;
    if (
      d.derived.situation !== "open" &&
      children.open + children.resolved > 0
    ) {
      parts.push(progressText(children));
    }
  }
  return parts.join(" · ");
}

function renderNodes(
  tree: Tree,
  derived: Map<string, DerivedTask>,
  nodes: IndexNode[],
  depth: number,
  lines: string[],
): void {
  const indent = "  ".repeat(depth);
  for (const node of nodes) {
    switch (node.kind) {
      case "task":
        lines.push(
          `${indent}- ${taskLine(tree, node.path, derived.get(node.path))}`,
        );
        break;
      case "malformed":
        lines.push(
          `${indent}- [${node.path}](${node.path}/) — malformed task.md, see below`,
        );
        break;
      case "group":
        lines.push(`${indent}- ${node.path}/`);
        break;
    }
    renderNodes(tree, derived, node.children, depth + 1, lines);
  }
}

/** A path relative to `.tasks/`, posix-style: the same in every clone. */
function relativeToTree(tree: Tree, target: string): string {
  return path.relative(tree.project.tasksDir, target).split(path.sep).join("/");
}

/**
 * The tree nested by containment, one line per task: a link to its
 * directory, its title, its situation, its effective priority when not
 * normal, and progress for a parent. Groups that hold tasks appear as their
 * path; malformed manifests are also listed in a final section. Nothing
 * read here depends on the actor, so any actor's derivation renders alike;
 * a Writer naturally derives with a null actor.
 */
export function renderIndex(
  tree: Tree,
  derived: Map<string, DerivedTask>,
): string {
  const lines: string[] = [];
  renderNodes(tree, derived, buildForest(tree), 0, lines);
  if (lines.length === 0 && tree.malformed.length === 0) {
    return indexTemplate("_No tasks yet._");
  }

  if (tree.malformed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("## Malformed", "");
    for (const entry of tree.malformed) {
      const file = relativeToTree(tree, entry.path);
      lines.push(`- [${file}](${file}): ${entry.message}`);
    }
  }
  return indexTemplate(lines.join("\n"));
}

export function indexPath(tree: Tree): string {
  return path.join(tree.project.tasksDir, INDEX_FILENAME);
}

export async function writeIndex(
  tree: Tree,
  derived: Map<string, DerivedTask>,
): Promise<string> {
  const file = indexPath(tree);
  await writeFileAtomic(file, renderIndex(tree, derived));
  return file;
}

export async function indexExists(tree: Tree): Promise<boolean> {
  try {
    return (await fs.stat(indexPath(tree))).isFile();
  } catch (err) {
    if (errnoCode(err) === "ENOENT" || errnoCode(err) === "ENOTDIR") {
      return false;
    }
    throw err;
  }
}

async function readIndex(tree: Tree): Promise<string | null> {
  try {
    return await fs.readFile(indexPath(tree), "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT" || errnoCode(err) === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

/** Line endings follow git's checkout settings; only the content counts. */
function normalize(contents: string): string {
  return contents.replace(/\r\n/g, "\n");
}

/**
 * True when `index.md` exists and differs from a fresh rendering. A missing
 * file is not stale: the index is optional, and a tree without one is valid.
 */
export async function isIndexStale(
  tree: Tree,
  derived: Map<string, DerivedTask>,
): Promise<boolean> {
  const current = await readIndex(tree);
  if (current === null) return false;
  return normalize(current) !== renderIndex(tree, derived);
}

/**
 * What a Writer does after every mutation: regenerate `index.md` when it
 * exists, and never create it. Returns whether it wrote; a file that is
 * already current is left untouched.
 */
export async function refreshIndex(
  tree: Tree,
  derived: Map<string, DerivedTask>,
): Promise<boolean> {
  if (!(await indexExists(tree))) return false;
  const current = await readIndex(tree);
  const fresh = renderIndex(tree, derived);
  if (current !== null && normalize(current) === fresh) return false;
  await writeFileAtomic(indexPath(tree), fresh);
  return true;
}
