import { TaskError } from "../errors.js";
import { TASK_OBJECT_KEYS } from "./types.js";

/**
 * Keys a document adds around a task object: `show` and `resume` their
 * files and relations, a transition what it cascaded, `show --archived` its
 * marker. Named so a caller may ask for them without knowing this run.
 */
const EXTRA_FIELD_NAMES: readonly string[] = [
  "body",
  "workspace",
  "referenced_by",
  "archived",
  "ancestors",
  "child_tasks",
  "state",
  "docs",
  "cascaded",
  "dependents",
  "holds",
];

const FIELD_NAMES: ReadonlySet<string> = new Set([
  ...TASK_OBJECT_KEYS,
  ...EXTRA_FIELD_NAMES,
]);

/**
 * `--fields <list>`: the keys a caller wants of each task object, comma-
 * separated, in the order given. Checked before the command does anything,
 * so a typo never follows a write: a name no document has is a usage error,
 * and so is a list that names nothing.
 */
export function parseFields(value: string): string[] {
  const fields: string[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (name === "" || fields.includes(name)) continue;
    if (!FIELD_NAMES.has(name)) {
      throw TaskError.usage(
        `Unknown field "${name}" for --fields; a task object has ${TASK_OBJECT_KEYS.join(", ")}, and show, resume and the transitions add ${EXTRA_FIELD_NAMES.join(", ")}.`,
        { field: name, allowed: [...FIELD_NAMES] },
      );
    }
    fields.push(name);
  }
  if (fields.length === 0) {
    throw TaskError.usage(
      `--fields needs at least one key of the task object, comma-separated: ${TASK_OBJECT_KEYS.join(", ")}.`,
      { fields: value },
    );
  }
  return fields;
}

/**
 * The document trimmed to `fields`, in that order; a key this document has
 * not got (a transition that cascaded nothing, a row of a collection asked
 * for `body`) is left out rather than invented.
 */
export function pickFields(
  document: object,
  fields: readonly string[],
): Record<string, unknown> {
  const source = document as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
  }
  return out;
}
