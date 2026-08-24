import path from "node:path";

import { TaskError } from "../errors.js";

/** A dependency on a task in the same `.tasks/` tree. */
export interface LocalRef {
  kind: "local";
  id: string;
  raw: string;
}

/** A dependency on a task in another project's `.tasks/` tree. */
export interface ExternalRef {
  kind: "external";
  /** Relative path to the other project root, anchored at *this* tree's root. */
  projectPath: string;
  id: string;
  raw: string;
}

export type DependencyRef = LocalRef | ExternalRef;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * Parse a `depends_on` entry.
 *
 * `some-task`                     -> local
 * `../other-repo:some-other-task` -> external
 *
 * Split on the *last* colon. Absolute paths are rejected: they don't survive a
 * clone on another machine, and banning them also removes the Windows
 * drive-letter ambiguity (`C:\repo:task-id`) from the split rule.
 */
export function parseRef(raw: string): DependencyRef {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw TaskError.usage("Dependency reference is empty.");
  }

  const sep = trimmed.lastIndexOf(":");
  if (sep === -1) {
    if (!isValidId(trimmed)) {
      throw TaskError.usage(
        `Invalid task id "${trimmed}". Ids are lowercase kebab-case (letters, digits, hyphens).`,
        { ref: raw },
      );
    }
    return { kind: "local", id: trimmed, raw: trimmed };
  }

  const projectPath = trimmed.slice(0, sep);
  const id = trimmed.slice(sep + 1);

  if (projectPath.length === 0) {
    throw TaskError.usage(`Invalid dependency reference "${raw}": missing project path.`, {
      ref: raw,
    });
  }
  if (!isValidId(id)) {
    throw TaskError.usage(
      `Invalid dependency reference "${raw}": "${id}" is not a valid task id.`,
      { ref: raw },
    );
  }
  if (path.isAbsolute(projectPath) || /^[A-Za-z]:[\\/]/.test(projectPath)) {
    throw TaskError.usage(
      `Invalid dependency reference "${raw}": absolute paths are not allowed, because frontmatter is committed and must resolve on any machine. Use a path relative to the project root.`,
      { ref: raw },
    );
  }

  return { kind: "external", projectPath, id, raw: trimmed };
}

export function formatRef(ref: DependencyRef): string {
  return ref.kind === "local" ? ref.id : `${ref.projectPath}:${ref.id}`;
}
