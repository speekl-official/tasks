import { stripVTControlCharacters } from "node:util";

import pc from "picocolors";
import stringWidth from "string-width";

import type { DerivedTask } from "./core/derive.js";
import { pickFields } from "./core/fields.js";
import {
  labels,
  priorityLabel,
  referenceText,
  situationText,
} from "./core/derive.js";
import { ancestorPaths, compareIds, qualifyId } from "./core/ids.js";
import type { UnavailableTree } from "./core/projects.js";
import { compactAge } from "./core/time.js";
import type {
  ActorsJson,
  BlockedByJson,
  CollectionJson,
  DocsLocationJson,
  FindingJson,
  LastEntryJson,
  LogEntryJson,
  ResolvedRef,
  SessionCheckJson,
  SessionEndJson,
  Situation,
  Status,
  TaskWithDerivedJson,
  ValidationJson,
} from "./core/types.js";

export interface OutputOptions {
  json: boolean;
}

/** Successful output goes to stdout; diagnostics and errors go to stderr. */
export function writeOut(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function writeErr(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function emitJson(value: unknown): void {
  writeOut(JSON.stringify(value, null, 2));
}

/** Whose `--fields` the emitters honour. */
interface Fielded {
  fields: readonly string[] | null;
}

/** A task object under `--json`, trimmed to `--fields` when given. */
export function emitTaskJson(context: Fielded, document: object): void {
  emitJson(
    context.fields === null ? document : pickFields(document, context.fields),
  );
}

/** A collection under `--json`: rows trimmed to `--fields`, its own keys kept. */
export function emitCollectionJson(
  context: Fielded,
  collection: CollectionJson,
): void {
  const { fields } = context;
  if (fields === null) {
    emitJson(collection);
    return;
  }
  emitJson({
    ...collection,
    tasks: collection.tasks.map((task) => pickFields(task, fields)),
  });
}

/** A borderless table; the renderers build on it. */
/** The width of the terminal on stdout, or `null` when stdout is not one. */
export function terminalWidth(): number | null {
  return process.stdout.isTTY ? (process.stdout.columns ?? null) : null;
}

export const ui = {
  success: (msg: string): string => `${pc.green("✓")} ${msg}`,
  info: (msg: string): string => `${pc.cyan("•")} ${msg}`,
  warn: (msg: string): string => `${pc.yellow("!")} ${msg}`,
  error: (msg: string): string => `${pc.red("✗")} ${msg}`,
  dim: (msg: string): string => pc.dim(msg),
  bold: (msg: string): string => pc.bold(msg),
};

/* ------------------------------------------------------------------------ */
/* Renderers                                                                */
/*                                                                          */
/* Human output is not contract: these return text for a command to print, */
/* and nothing parses it. Overviews speak situation and never print the    */
/* stored status; show and resume carry both.                               */
/* ------------------------------------------------------------------------ */

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const ESC = String.fromCharCode(27);
/** Every SGR sequence, the colon-separated forms (`38:2::r:g:b`) included. */
const SGR_ALL = new RegExp(`${ESC}\\[[0-9;:]*m`, "g");

/**
 * Display width of a cell in terminal columns, colour codes excluded: a
 * wide character counts two, a combining mark none, so a title in CJK or
 * emoji is measured as the terminal lays it out.
 */
function visibleWidth(text: string): number {
  return stringWidth(stripVTControlCharacters(text.replace(SGR_ALL, "")));
}

/** Cuts fall between graphemes, never inside a surrogate pair or a sequence. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** How a grid is fitted into a width: which columns give way, down to what. */
interface Fit {
  width: number;
  /** In the order they shrink; a column is never cut below its floor. */
  shrink: ReadonlyArray<{ column: number; floor: number }>;
}

/** Narrow the columns that may give way until the rows fit, or stop at the floors. */
function fitWidths(widths: number[], fit: Fit): void {
  const gaps = 2 * Math.max(0, widths.length - 1);
  let excess = widths.reduce((sum, width) => sum + width, 0) + gaps - fit.width;
  for (const { column, floor } of fit.shrink) {
    if (excess <= 0) return;
    const current = widths[column] ?? 0;
    const take = Math.min(excess, Math.max(0, current - floor));
    widths[column] = current - take;
    excess -= take;
  }
}

/** Splits text into visible runs and the colour codes between them. */
const ANSI_SPLIT = new RegExp(`(${ESC}\\[[0-9;:]*m)`);

/**
 * `text` cut to `width` visible characters with an ellipsis, colour codes
 * kept: the ones before the cut stay in place and the ones after it (the
 * closers) follow the ellipsis, so a coloured cell closes as it did.
 */
function cutVisible(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const keep = Math.max(0, width - 1);
  let kept = "";
  let closers = "";
  let seen = 0;
  for (const token of text.split(ANSI_SPLIT)) {
    if (token.startsWith(`${ESC}[`)) {
      if (seen < keep) kept += token;
      else closers += token;
    } else if (seen < keep) {
      for (const { segment } of GRAPHEMES.segment(token)) {
        const width = stringWidth(segment);
        // A wide character that does not fit the last cell stays out; the
        // cell ends a column early rather than a column late.
        if (seen + width > keep) {
          seen = keep;
          break;
        }
        kept += segment;
        seen += width;
      }
    }
  }
  return `${kept}…${closers}`;
}

/**
 * Rows aligned into columns two spaces apart. A plain string is a free line,
 * printed as it is without widening any column, so a long note under one
 * row cannot push every other row apart the way a table cell would. With a
 * `fit`, the columns it names give way until the rows fit its width, their
 * cells cut with an ellipsis; without one nothing is cut.
 */
function aligned(
  input: ReadonlyArray<readonly string[] | string>,
  fit?: Fit,
): string {
  // A tab in a cell would reach the next tab stop of the terminal, past any
  // width this arithmetic knows; it shows as one space.
  const rows = input.map((row) =>
    typeof row === "string" ? row : row.map((cell) => cell.replace(/\t/g, " ")),
  );
  const widths: number[] = [];
  for (const row of rows) {
    if (typeof row === "string") continue;
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, visibleWidth(cell));
    });
  }
  if (fit !== undefined) fitWidths(widths, fit);
  return rows
    .map((row) => {
      if (typeof row === "string") return row.trimEnd();
      return row
        .map((cell, index) => {
          const shown = cutVisible(cell, widths[index]!);
          return index === row.length - 1
            ? shown
            : shown + " ".repeat(widths[index]! - visibleWidth(shown) + 2);
        })
        .join("")
        .trimEnd();
    })
    .join("\n");
}

function indentLines(text: string, indent: string): string[] {
  return text.split("\n").map((line) => `${indent}${line}`.trimEnd());
}

function colorSituation(situation: Situation, text: string): string {
  switch (situation) {
    case "done":
      return pc.green(text);
    case "cancelled":
      return pc.dim(text);
    case "working":
      return pc.yellow(text);
    case "ready":
      return pc.cyan(text);
    case "blocked":
      return pc.red(text);
    default:
      return text;
  }
}

function situationCell(d: DerivedTask): string {
  return colorSituation(d.derived.situation, situationText(d));
}

/** The situation followed by its secondary labels, as one line reads. */
function situationLine(d: DerivedTask): string {
  return [situationCell(d), ...labels(d)].join(" · ");
}

/** Qualified in aggregated output, so ids of two trees cannot collide. */
function shownId(d: DerivedTask, qualified: boolean | undefined): string {
  return qualified ? d.json.id : d.snapshot.task.id;
}

/** The heading of a log entry, in the grammar `log.md` uses. */
/**
 * The heading of a listed entry: when and who. The session token stays in
 * the file and in the JSON; a person reading a listing never needs it.
 */
function entryHeading(entry: LastEntryJson): string {
  const via = entry.via === null ? "" : ` via ${entry.via}`;
  return `${entry.time} ${entry.actor}${via}`;
}

function blockedDetail(blocked: BlockedByJson): string {
  return blocked.status === null
    ? blocked.reason
    : `${blocked.reason} (${blocked.status})`;
}

export interface OverviewOptions {
  /** Aggregated output: ids of listed projects carry their alias. */
  project?: boolean;
  /** Printed instead of an empty table. */
  empty?: string;
  /** The instant the ages count from (default: the clock). */
  now?: Date;
  /** Add the CREATED column before UPDATED. */
  created?: boolean;
  /** `tree`: the order of siblings (default: by id). */
  order?: (a: DerivedTask, b: DerivedTask) => number;
  /** The width to fit, a terminal's; `null` or absent cuts nothing. */
  width?: number | null;
}

/**
 * The columns an overview lets give way, in order, and their floors. The
 * title is free text and goes first; the situation and the labels are words
 * that lose their meaning when cut, so only an extreme one (a `blocked by`
 * naming several long ids) is touched, and never the ids, ages or priority.
 */
const GIVES_WAY: ReadonlyArray<readonly [string, number]> = [
  ["TITLE", 12],
  ["SITUATION", 40],
  ["LABELS", 40],
];

/** The fit for an overview with these headings, or none outside a terminal. */
function fitFor(
  head: readonly string[],
  options: OverviewOptions,
): Fit | undefined {
  if (options.width === undefined || options.width === null) return undefined;
  return {
    width: options.width,
    shrink: GIVES_WAY.flatMap(([name, floor]) => {
      const column = head.indexOf(name);
      return column === -1 ? [] : [{ column, floor }];
    }),
  };
}

/** The heading row of an overview, in bold. */
function headingRow(head: readonly string[]): string[] {
  return head.map((name) => pc.bold(name));
}

/** The time columns: UPDATED always, CREATED before it on request. */
function timeHeads(options: OverviewOptions): string[] {
  return options.created ? ["CREATED", "UPDATED"] : ["UPDATED"];
}

/** The ages of a row's time columns, as `timeHeads` orders them. */
function timeCells(d: DerivedTask, options: OverviewOptions): string[] {
  const { created, updated } = d.snapshot.task.frontmatter;
  const now = options.now ?? new Date();
  const age = (timestamp: string) => pc.dim(compactAge(timestamp, now));
  return options.created ? [age(created), age(updated)] : [age(updated)];
}

/** The PRIORITY column: a level other than `normal`, marked when inherited. */
function priorityCell(d: DerivedTask): string {
  return priorityLabel(d) ?? "";
}

/** The overview of `ready` and `list`: one row per task, by situation. */
export function renderOverview(
  rows: DerivedTask[],
  options: OverviewOptions = {},
): string {
  if (rows.length === 0) return ui.dim(options.empty ?? "No tasks.");
  const now = options.now ?? new Date();
  const head = [
    "ID",
    "SITUATION",
    ...timeHeads(options),
    "PRIORITY",
    "LABELS",
    "TITLE",
  ];
  const lines: Array<string[] | string> = [headingRow(head)];
  for (const d of rows) {
    lines.push([
      shownId(d, options.project),
      situationCell(d),
      ...timeCells(d, options),
      priorityCell(d),
      labels(d, now).join(" · "),
      d.snapshot.task.title,
    ]);
  }
  return aligned(lines, fitFor(head, options));
}

interface TreeNode {
  d: DerivedTask;
  /** The path below the nearest shown ancestor, or the id at the top. */
  name: string;
  children: TreeNode[];
}

/** The `↳ after` lines of a task: its finish-gate joins, tagged when foreign. */
function finishesAfterLines(d: DerivedTask, indent: string): string[] {
  const resolved = new Map(d.snapshot.finish.refs.map((ref) => [ref.ref, ref]));
  return d.snapshot.task.frontmatter.finishes_after.map((raw) => {
    const ref = resolved.get(raw) ?? null;
    const shown = referenceText(ref, raw, d.snapshot.project);
    const state =
      ref === null
        ? ""
        : ref.satisfied
          ? ` (${ref.status?.toLowerCase() ?? "resolved"})`
          : ` (${ref.reason ?? "missing"})`;
    return `${indent}${pc.dim("↳")} after ${shown}${state}`;
  });
}

/**
 * `tree`: the rows nested by containment. A task nests under its nearest
 * ancestor that is itself among the rows and is named by the path below it,
 * so a filtered or scoped tree still reads correctly; `finishes_after`
 * entries follow their task.
 */
/**
 * The rows nested by containment, in display order: the local tree first,
 * projects as the rows first name them, siblings by `order` (ids by default)
 * at every level.
 */
function nestRows(rows: DerivedTask[], options: OverviewOptions): TreeNode[] {
  const shown = new Map(rows.map((d) => [d.json.id, d]));
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const firstSeen = new Map<string | null, number>();
  for (const d of rows) {
    if (!firstSeen.has(d.snapshot.project)) {
      firstSeen.set(d.snapshot.project, firstSeen.size);
    }
    nodes.set(d.json.id, {
      d,
      name: shownId(d, options.project),
      children: [],
    });
  }
  for (const d of rows) {
    const node = nodes.get(d.json.id)!;
    const { project, task } = d.snapshot;
    const above = ancestorPaths(task.id).find((path) =>
      shown.has(qualifyId(project, path)),
    );
    if (above === undefined) {
      roots.push(node);
    } else {
      node.name = task.id.slice(above.length + 1);
      nodes.get(qualifyId(project, above))!.children.push(node);
    }
  }

  // The local tree first, then projects as the rows first name them.
  const projectRank = (node: TreeNode) =>
    node.d.snapshot.project === null
      ? -1
      : firstSeen.get(node.d.snapshot.project)!;
  const order =
    options.order ??
    ((a: DerivedTask, b: DerivedTask) =>
      compareIds(a.snapshot.task.id, b.snapshot.task.id));
  const bySiblings = (a: TreeNode, b: TreeNode) => order(a.d, b.d);
  roots.sort((a, b) => projectRank(a) - projectRank(b) || bySiblings(a, b));
  const sortBeneath = (node: TreeNode) => {
    node.children.sort(bySiblings);
    node.children.forEach(sortBeneath);
  };
  roots.forEach(sortBeneath);
  return roots;
}

/**
 * The rows in the order `renderTree` lists them: depth first, siblings as
 * `order` has them. `tree --json` emits this sequence, so the flat list and
 * the nesting agree under `--sort`.
 */
export function treeSequence(
  rows: DerivedTask[],
  options: OverviewOptions = {},
): DerivedTask[] {
  const out: DerivedTask[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(node.d);
      walk(node.children);
    }
  };
  walk(nestRows(rows, options));
  return out;
}

export function renderTree(
  rows: DerivedTask[],
  options: OverviewOptions = {},
): string {
  if (rows.length === 0) return ui.dim(options.empty ?? "No tasks.");
  const roots = nestRows(rows, options);
  const now = options.now ?? new Date();
  const head = [
    "TASK",
    "SITUATION",
    ...timeHeads(options),
    "PRIORITY",
    "LABELS",
    "TITLE",
  ];
  const lines: Array<string[] | string> = [headingRow(head)];
  const walk = (list: TreeNode[], depth: number) => {
    const indent = "  ".repeat(depth);
    for (const node of list) {
      lines.push([
        `${indent}${node.name}`,
        situationCell(node.d),
        ...timeCells(node.d, options),
        priorityCell(node.d),
        labels(node.d, now).join(" · "),
        node.d.snapshot.task.title,
      ]);
      lines.push(...finishesAfterLines(node.d, `${indent}  `));
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return aligned(lines, fitFor(head, options));
}

/**
 * A task's last log entry beneath its row: what happened, then who and how
 * long ago, dimmed; the entry's further lines follow as written. The
 * heading's timestamp and session token stay in the JSON and in `log`.
 */
function entryLines(
  entry: LastEntryJson,
  now: Date,
  indent = "    ",
): string[] {
  const [first = "", ...rest] = entry.text.split("\n");
  const who =
    entry.via === null ? entry.actor : `${entry.actor} via ${entry.via}`;
  const stamp = pc.dim(`(${who}, ${compactAge(entry.time, now)})`);
  return [
    `${indent}${first === "" ? stamp : `${first}  ${stamp}`}`,
    ...(rest.length === 0 ? [] : indentLines(rest.join("\n"), indent)),
  ];
}

/**
 * `mine`: the overview with each task's last log entry beneath it, in full,
 * because a handoff's closing note is written there for the next reader.
 */
export function renderMine(
  rows: DerivedTask[],
  options: OverviewOptions = {},
): string {
  if (rows.length === 0) {
    return ui.dim(options.empty ?? "Nothing claimed by or assigned to you.");
  }
  const now = options.now ?? new Date();
  const head = [
    "ID",
    "SITUATION",
    ...timeHeads(options),
    "PRIORITY",
    "LABELS",
    "TITLE",
  ];
  const lines: Array<string[] | string> = [headingRow(head)];
  for (const d of rows) {
    lines.push([
      shownId(d, options.project),
      situationCell(d),
      ...timeCells(d, options),
      priorityCell(d),
      labels(d, now).join(" · "),
      d.snapshot.task.title,
    ]);
    const entry = d.derived.last_entry;
    if (entry !== null) lines.push(...entryLines(entry, now));
  }
  return aligned(lines, fitFor(head, options));
}

/**
 * The roster with its counts: listed actors first, in their order, then
 * the names open tasks carry that the roster lacks, which read as something
 * to fix. The caller is marked, and the footer says whether any name is
 * constrained at all.
 */
export function renderActors(result: ActorsJson): string {
  const lines: Array<string[] | string> = [
    ["ACTOR", "TYPE", "DESCRIPTION", "OPEN"].map((head) => pc.bold(head)),
  ];
  for (const row of result.actors) {
    const name =
      row.actor === result.actor
        ? `${row.actor} ${pc.dim("(you)")}`
        : row.actor;
    const description = row.listed
      ? (row.description ?? "")
      : pc.yellow("not listed in this tree's config.yml");
    const open = [
      ...(row.claimed > 0 ? [`${row.claimed} claimed`] : []),
      ...(row.assigned > 0 ? [`${row.assigned} assigned`] : []),
    ];
    lines.push([
      name,
      row.type,
      description,
      open.length === 0 ? pc.dim("—") : open.join(" · "),
    ]);
  }
  const listed = result.actors.filter((row) => row.listed).length;
  const parts = [
    listed === 0
      ? "config.yml lists no actors: any name may be assigned"
      : plural(listed, "listed actor"),
  ];
  if (result.projects.length > 0) {
    parts.push(`projects ${result.projects.join(", ")}`);
  }
  lines.push("", pc.dim(parts.join(" · ")));
  return aligned(lines);
}

function fieldLines(fields: ReadonlyArray<readonly [string, string | null]>) {
  const present = fields.filter(
    (field): field is readonly [string, string] => field[1] !== null,
  );
  const width = Math.max(...present.map(([label]) => label.length));
  return present.map(
    ([label, value]) => `  ${pc.dim(label.padEnd(width))}  ${value}`,
  );
}

function listOrNull(values: readonly string[]): string | null {
  return values.length === 0 ? null : values.join(", ");
}

/** A gate's stored references, each as the command line takes it. */
function referenceList(
  d: DerivedTask,
  raws: readonly string[],
  refs: readonly ResolvedRef[],
): string | null {
  const byRef = new Map(refs.map((ref) => [ref.ref, ref]));
  return listOrNull(
    raws.map((raw) =>
      referenceText(byRef.get(raw) ?? null, raw, d.snapshot.project),
    ),
  );
}

function headerLine(d: DerivedTask): string {
  return `${pc.bold(d.snapshot.task.title)}  ${pc.dim(d.json.id)}`;
}

function priorityField(d: DerivedTask): string {
  const own = d.json.priority;
  const effective = d.derived.effective_priority;
  return own === effective ? own : `${own} (effective ${effective})`;
}

function claimField(d: DerivedTask): string | null {
  const { json } = d;
  if (json.claimed_by === null) return null;
  const parts = [`${json.claimed_by} since ${json.claimed_at ?? "?"}`];
  if (json.claimed_session !== null) {
    parts.push(`session ${json.claimed_session}`);
  }
  if (d.derived.liveness === "orphaned" && d.derived.last_seen !== null) {
    parts.push(`orphaned since ${d.derived.last_seen}`);
  } else if (d.derived.liveness !== null) {
    parts.push(d.derived.liveness);
  }
  return parts.join(" · ");
}

function childrenField(d: DerivedTask): string | null {
  const { open, resolved } = d.derived.children;
  return open + resolved === 0 ? null : `${open} open, ${resolved} resolved`;
}

function blockedSection(d: DerivedTask): string[] {
  if (d.derived.blocked_by.length === 0) return [];
  const byRef = new Map(d.snapshot.start.refs.map((ref) => [ref.ref, ref]));
  return [
    "",
    pc.bold("Blocked by"),
    aligned(
      d.derived.blocked_by.map((blocked) => [
        `  ${referenceText(byRef.get(blocked.ref) ?? null, blocked.ref, d.snapshot.project)}`,
        blockedDetail(blocked),
      ]),
    ),
  ];
}

export interface ShowExtras {
  body: string;
  workspace: string[];
  referenced_by: string[];
  /** Read from `.archive/` with `--archived`. */
  archived?: boolean;
}

/** `show`: the stored fields and the situation, then the body. */
export function renderShow(d: DerivedTask, extras: ShowExtras): string {
  const { json } = d;
  const lines = [
    headerLine(d),
    ...fieldLines([
      ["status", json.status],
      ["situation", situationLine(d)],
      ["priority", priorityField(d)],
      ["assignee", json.assignee],
      ["claimed by", claimField(d)],
      ["depends on", referenceList(d, json.depends_on, d.snapshot.start.refs)],
      [
        "finishes after",
        referenceList(d, json.finishes_after, d.snapshot.finish.refs),
      ],
      ["children", childrenField(d)],
      ["referenced by", listOrNull(extras.referenced_by)],
      ["workspace", listOrNull(extras.workspace)],
      ["created", json.created],
      ["updated", json.updated],
      ["path", json.path],
      [
        "archived",
        extras.archived === true
          ? `yes; tasks restore ${json.id} brings it back`
          : null,
      ],
    ]),
    ...blockedSection(d),
  ];
  const body = extras.body.trim();
  if (body.length > 0) lines.push("", body);
  return lines.join("\n");
}

export interface ResumeAncestor {
  id: string;
  title: string;
  status: Status;
  workspace: string[];
}

export interface ResumeExtras {
  ancestors: ResumeAncestor[];
  children: DerivedTask[];
  workspace: string[];
  state: string | null;
  referenced_by: string[];
  /** The configured documentation locations; nothing is shown for none. */
  docs: DocsLocationJson[];
}

/**
 * `resume`: everything the next session reads to continue, in reading
 * order: the task, its ancestors (in the order given), its children,
 * the workspace, where the project's documentation lives, `state.md` in
 * full, and the last log entry.
 */
export function renderResume(d: DerivedTask, extras: ResumeExtras): string {
  const { json } = d;
  const sections: string[] = [
    [
      headerLine(d),
      ...fieldLines([
        ["status", json.status],
        ["situation", situationLine(d)],
        ["priority", priorityField(d)],
        ["assignee", json.assignee],
        ["claimed by", claimField(d)],
        [
          "depends on",
          referenceList(d, json.depends_on, d.snapshot.start.refs),
        ],
        [
          "finishes after",
          referenceList(d, json.finishes_after, d.snapshot.finish.refs),
        ],
        ["referenced by", listOrNull(extras.referenced_by)],
        ["path", json.path],
      ]),
      ...blockedSection(d),
    ].join("\n"),
  ];

  if (extras.ancestors.length > 0) {
    sections.push(
      [
        pc.bold("Ancestors"),
        aligned(
          extras.ancestors.map((ancestor) => [
            `  ${ancestor.id}`,
            ancestor.status,
            ancestor.title,
            // Colour codes around nothing would survive the trailing trim.
            ancestor.workspace.length === 0
              ? ""
              : pc.dim(ancestor.workspace.join(", ")),
          ]),
        ),
      ].join("\n"),
    );
  }

  if (extras.children.length > 0) {
    sections.push(
      [
        pc.bold("Children"),
        aligned(
          extras.children.map((child) => [
            `  ${child.json.id}`,
            child.json.status,
            situationLine(child),
            child.snapshot.task.title,
          ]),
        ),
      ].join("\n"),
    );
  }

  sections.push(
    [
      pc.bold("Workspace"),
      `  ${listOrNull(extras.workspace) ?? pc.dim("task.md only")}`,
    ].join("\n"),
  );

  if (extras.docs.length > 0) {
    sections.push(
      [
        pc.bold("Docs"),
        aligned(
          extras.docs.map((location) => [
            `  ${location.name}`,
            location.path,
            location.present ? "" : pc.dim("absent here"),
          ]),
        ),
      ].join("\n"),
    );
  }

  sections.push(
    [
      pc.bold("state.md"),
      extras.state === null
        ? pc.dim("  No state.md yet: nothing to resume from.")
        : extras.state.trimEnd(),
    ].join("\n"),
  );

  const entry = d.derived.last_entry;
  if (entry !== null) {
    sections.push(
      [pc.bold("Last entry"), ...entryLines(entry, new Date(), "  ")].join(
        "\n",
      ),
    );
  }
  return sections.join("\n\n");
}

/** Log entries, oldest first as given, each under its heading. */
/**
 * Log entries for a person, oldest first; a task read from the archive is
 * marked, since its id looks like a live one.
 */
export function renderLogEntries(
  entries: LogEntryJson[],
  archived: ReadonlySet<string> = new Set(),
): string {
  if (entries.length === 0) return ui.dim("No log entries.");
  return entries
    .map((entry) =>
      [
        `${pc.dim(entryHeading(entry))}  ${pc.bold(entry.task)}${archived.has(entry.task) ? pc.dim(" (archived)") : ""}`,
        ...indentLines(entry.text, "  "),
      ].join("\n"),
    )
    .join("\n\n");
}

function findingText(finding: FindingJson): string {
  const subject = finding.task === null ? "" : `${finding.task}: `;
  return `${subject}${finding.message} ${pc.dim(`[${finding.kind}]`)}`;
}

/** `validate`: what was fixed, then errors, then warnings, then a count. */
export function renderValidation(result: ValidationJson): string {
  const errors = result.findings.filter((f) => f.severity === "error");
  const warnings = result.findings.filter((f) => f.severity === "warning");
  const checked = `${plural(result.checked, "task")} checked`;

  const lines = result.fixed.map((file) => ui.success(`fixed ${file}`));
  lines.push(...errors.map((finding) => ui.error(findingText(finding))));
  lines.push(...warnings.map((finding) => ui.warn(findingText(finding))));
  if (errors.length + warnings.length === 0) {
    lines.push(ui.success(`no findings · ${checked}`));
  } else {
    lines.push(
      "",
      ui.dim(
        `${plural(errors.length, "error")}, ${plural(warnings.length, "warning")} · ${checked}`,
      ),
    );
  }
  return lines.join("\n");
}

/** `session-check`: the exit invariant, violations first. */
export function renderSessionCheck(result: SessionCheckJson): string {
  const who =
    result.session === null
      ? "claims without a session"
      : `session ${result.session}`;
  const lines = result.violations.map((violation) =>
    ui.error(
      `${violation.id}: claimed without a state.md; write one with \`tasks state ${violation.id}\``,
    ),
  );
  lines.push(
    ...result.warnings.map((warning) =>
      ui.warn(
        warning.message.startsWith(`${warning.id}:`)
          ? warning.message
          : `${warning.id}: ${warning.message}`,
      ),
    ),
  );
  lines.push(
    result.ok
      ? ui.success(`${who}: every claimed task has a state.md`)
      : ui.error(
          `${who}: ${plural(result.violations.length, "claimed task")} without a state.md`,
        ),
  );
  return lines.join("\n");
}

/** `session-end`: the session and the claims it orphaned. */
export function renderSessionEnd(result: SessionEndJson): string {
  const head = ui.success(`session ${result.session} ended at ${result.ended}`);
  return result.claims.length === 0
    ? `${head}\n  ${ui.dim("it held no claims")}`
    : `${head}\n  orphaned claims: ${result.claims.join(", ")}`;
}

/**
 * `dep list` and `after list`: each reference, named as the command line
 * takes it, and whether it is satisfied.
 */
export function renderDepList(refs: ResolvedRef[]): string {
  if (refs.length === 0) return ui.dim("No references.");
  const lines: Array<string[] | string> = [
    headingRow(["REFERENCE", "SATISFIED", "DETAIL"]),
  ];
  for (const ref of refs) {
    lines.push([
      qualifyId(ref.project, ref.id),
      ref.satisfied ? pc.green("yes") : pc.red("no"),
      ref.satisfied
        ? pc.dim(ref.status ?? "")
        : blockedDetail({
            ref: ref.ref,
            task: ref.task,
            reason: ref.reason ?? "missing",
            status: ref.status,
          }),
    ]);
  }
  return aligned(lines);
}

/** The rows that came from listed projects: those whose `project` is an alias. */
function foreignRows(tasks: readonly unknown[]): number {
  return tasks.filter(
    (task) =>
      typeof task === "object" &&
      task !== null &&
      typeof (task as { project?: unknown }).project === "string",
  ).length;
}

/** Why a listed project is left out, in a word or two; `validate` says the rest. */
function unavailableWord(load: UnavailableTree): string {
  switch (load.kind) {
    case "not-checked-out":
      return "not checked out";
    case "unsupported-version":
      return load.version === 1 ? "v1" : `v${load.version} unsupported`;
    case "unresolved":
      return load.cause === null ? "no tree" : "unreadable";
  }
}

/**
 * The line under an overview: the count, the scope, the depth and, when
 * projects were spanned, how many rows came from them and which listed
 * projects could not be shown, each with the reason in a word (the full
 * sentence, with the remedy, is `validate`'s `project-unavailable`); then
 * malformed.
 */
export function renderCollectionFooter(
  collection: CollectionJson<unknown>,
  depth: number | null = null,
  unavailable: readonly UnavailableTree[] = [],
): string {
  const parts = [plural(collection.count, "task")];
  if (collection.scope !== null) parts.push(`scope ${collection.scope}`);
  if (depth !== null) parts.push(`depth ${depth}`);
  if (collection.projects.length > 0) {
    parts.push(
      `${foreignRows(collection.tasks)} from projects ${collection.projects.join(", ")}`,
    );
  }
  if (unavailable.length > 0) {
    parts.push(
      `not shown: ${unavailable
        .map(
          (load) => `${load.alias ?? load.relPath} (${unavailableWord(load)})`,
        )
        .join(", ")}`,
    );
  }
  return [
    ui.dim(parts.join(" · ")),
    ...collection.malformed.map((entry) =>
      ui.warn(`malformed ${entry.path}: ${entry.message}`),
    ),
  ].join("\n");
}

export interface TransitionInfo {
  /** The command as typed: `claim`, `handoff`, `assign`, … */
  command: string;
  from?: Status;
  to?: Status;
  /** Ids the cascade reached. */
  cascaded?: string[];
  /** Live tasks whose `depends_on` names a task the command cancelled. */
  dependents?: string[];
  /** How many tasks beneath the task it now holds. */
  holds?: number;
  /** The status stayed and the claimant changed: an orphaned claim taken. */
  takeover?: boolean;
}

function transitionHead(json: TaskWithDerivedJson, info: TransitionInfo) {
  const subject = `${info.command} ${json.id}`;
  if (info.from !== undefined && info.to !== undefined) {
    if (info.takeover === true) {
      return `${subject}: took over the claim (${info.to})`;
    }
    const target =
      info.command === "handoff" && json.assignee !== null
        ? ` to ${json.assignee}`
        : "";
    return `${subject}${target}: ${info.from} → ${info.to}`;
  }
  switch (info.command) {
    case "assign":
      return `${subject}: ${json.assignee ?? "nobody"}`;
    case "priority":
      return `${subject}: ${json.priority}`;
    default:
      return subject;
  }
}

/** One `✓` line for a transition, then what else it did. */
export function renderTransitionResult(
  json: TaskWithDerivedJson,
  info: TransitionInfo,
): string {
  const lines = [ui.success(transitionHead(json, info))];
  if (info.cascaded !== undefined && info.cascaded.length > 0) {
    lines.push(`  cascaded to ${info.cascaded.join(", ")}`);
  }
  if (info.dependents !== undefined && info.dependents.length > 0) {
    lines.push(
      `  ${ui.warn(`stranded dependents: ${info.dependents.join(", ")}`)}`,
    );
  }
  if (info.holds !== undefined && info.holds > 0) {
    lines.push(`  now holds ${plural(info.holds, "task")}`);
  }
  return lines.join("\n");
}
