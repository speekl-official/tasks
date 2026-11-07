import path from "node:path";

import { nameOf, qualifyId } from "./ids.js";
import type { ExtraKeys, Frontmatter, TaskJson } from "./types.js";
import { TASK_FILENAME, isOpen, isResolved } from "./types.js";

/** Which of the workspace vocabulary files exist beside `task.md`. */
export interface WorkspacePresence {
  state: boolean;
  design: boolean;
  plan: boolean;
  log: boolean;
}

export interface Task {
  /** Posix path relative to `.tasks/`, or to `.tasks/.archive/` if archived. */
  id: string;
  /** The last segment of the id. */
  name: string;
  /** The nearest ancestor task (a malformed one included), or `null`. */
  parent: string | null;
  /** Absolute native path of the task directory. */
  dir: string;
  /** Absolute native path of `task.md`. */
  file: string;
  archived: boolean;
  frontmatter: Frontmatter;
  /** Unknown frontmatter keys, preserved in read order on every write. */
  extra: ExtraKeys;
  /** The body as it is written: leading blank lines and trailing space trimmed. */
  body: string;
  /** The first level-one ATX heading of the body, else the name. */
  title: string;
  workspace: WorkspacePresence;
}

export const NO_WORKSPACE: WorkspacePresence = {
  state: false,
  design: false,
  plan: false,
  log: false,
};

export interface TaskInit {
  id: string;
  dir: string;
  archived: boolean;
  parent: string | null;
  frontmatter: Frontmatter;
  extra?: ExtraKeys;
  body: string;
  workspace?: Partial<WorkspacePresence>;
}

/** Assemble a task, deriving name, file and title from the rest. */
export function makeTask(init: TaskInit): Task {
  const name = nameOf(init.id);
  return {
    id: init.id,
    name,
    parent: init.parent,
    dir: init.dir,
    file: path.join(init.dir, TASK_FILENAME),
    archived: init.archived,
    frontmatter: init.frontmatter,
    extra: init.extra ?? [],
    body: init.body,
    title: titleOf(init.body, name),
    workspace: { ...NO_WORKSPACE, ...init.workspace },
  };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_H1 = /^ {0,3}#(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * The text of the first level-one ATX heading, outside fenced code (a shell
 * comment in an example is not a title), or `fallback` when there is none or
 * the heading is empty.
 */
export function titleOf(body: string, fallback: string): string {
  let fence: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const opener = FENCE.exec(line);
    if (fence !== null) {
      // A fence closes on a run of the same character at least as long,
      // with nothing after it but whitespace.
      if (
        opener &&
        opener[1]![0] === fence[0] &&
        opener[1]!.length >= fence.length &&
        opener[2]!.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (opener && !(opener[1]![0] === "`" && opener[2]!.includes("`"))) {
      fence = opener[1]!;
      continue;
    }
    const heading = ATX_H1.exec(line);
    if (heading) {
      // An optional closing run of `#`, preceded by a space, is not content.
      const text = (heading[1] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
      return text.length > 0 ? text : fallback;
    }
  }
  return fallback;
}

export function isClaimed(task: Task): boolean {
  return task.frontmatter.claimed_by !== null;
}

export function isAssigned(task: Task): boolean {
  return task.frontmatter.assignee !== null;
}

export function isOpenTask(task: Task): boolean {
  return isOpen(task.frontmatter.status);
}

export function isResolvedTask(task: Task): boolean {
  return isResolved(task.frontmatter.status);
}

export function hasState(task: Task): boolean {
  return task.workspace.state;
}

/**
 * The task object of the CLI contract. With a project alias, the id and the
 * parent are qualified `alias:path`, so foreign tasks nest among themselves
 * in aggregated output; stored references stay as stored.
 */
export function toTaskJson(
  task: Task,
  project: string | null = null,
): TaskJson {
  const fm = task.frontmatter;
  return {
    id: qualifyId(project, task.id),
    name: task.name,
    parent: task.parent === null ? null : qualifyId(project, task.parent),
    project,
    title: task.title,
    status: fm.status,
    priority: fm.priority,
    depends_on: [...fm.depends_on],
    finishes_after: [...fm.finishes_after],
    assignee: fm.assignee,
    claimed_by: fm.claimed_by,
    claimed_at: fm.claimed_at,
    claimed_session: fm.claimed_session,
    created: fm.created,
    updated: fm.updated,
    path: task.dir,
  };
}
