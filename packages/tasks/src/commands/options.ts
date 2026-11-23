/**
 * `--fields <list>`: declared on every command whose JSON is a task object
 * or a collection of them, so the flag reads the same everywhere and a
 * command whose document is neither refuses it as an unknown option.
 */
export const FIELDS_FLAG = "--fields <list>";
export const FIELDS_HELP =
  "with --json: keep only these keys of each task object, comma-separated (id, situation, yours, …)";
