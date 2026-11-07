import { stripVTControlCharacters } from "node:util";

import Table from "cli-table3";
import pc from "picocolors";

import type { DerivedTask } from "./core/derive.js";
import { labels, referenceText, situationText } from "./core/derive.js";
import { ancestorPaths, compareIds, qualifyId } from "./core/ids.js";
import type {
  ActorsJson,
  BlockedByJson,
  CollectionJson,
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

/** A borderless table; the renderers build on it. */
export function table(head: string[]): Table.Table {
  return new Table({
    head: head.map((h) => pc.bold(h)),
    style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
    chars: {
      top: "",
      "top-mid": "",
      "top-left": "",
      "top-right": "",
      bottom: "",
      "bottom-mid": "",
      "bottom-left": "",
      "bottom-right": "",
      left: "",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "",
      "right-mid": "",
      middle: " ",
    },
  });
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

/** Display width of a cell, colour codes excluded. */
function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length;
}

/**
 * Rows aligned into columns two spaces apart. A plain string is a free line,
 * printed as it is without widening any column, so a long note under one
 * row cannot push every other row apart the way a table cell would.
 */
function aligned(rows: ReadonlyArray<readonly string[] | string>): string {
  const widths: number[] = [];
  for (const row of rows) {
    if (typeof row === "string") continue;
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, visibleWidth(cell));
    });
  }
  return rows
    .map((row) => {
      if (typeof row === "string") return row.trimEnd();
      return row
        .map((cell, index) =>
          index === row.length - 1
            ? cell
            : cell + " ".repeat(widths[index]! - visibleWidth(cell) + 2),
        )
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
function entryHeading(entry: LastEntryJson): string {
  const via = entry.via === null ? "" : ` via ${entry.via}`;
  const session = entry.session === null ? "" : ` s:${entry.session}`;
  return `${entry.time} ${entry.actor}${via}${session}`;
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
}

/** The overview of `ready` and `list`: one row per task, by situation. */
export function renderOverview(
  rows: DerivedTask[],
  options: OverviewOptions = {},
): string {
  if (rows.length === 0) return ui.dim(options.empty ?? "No tasks.");
  const out = table(["ID", "SITUATION", "LABELS", "TITLE"]);
  for (const d of rows) {
    out.push([
      shownId(d, options.project),
      situationCell(d),
      labels(d).join(" · "),
      d.snapshot.task.title,
    ]);
  }
  return out.toString();
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
export function renderTree(
  rows: DerivedTask[],
  options: OverviewOptions = {},
): string {
  if (rows.length === 0) return ui.dim(options.empty ?? "No tasks.");

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
  const byId = (a: TreeNode, b: TreeNode) =>
    compareIds(a.d.snapshot.task.id, b.d.snapshot.task.id);
  roots.sort((a, b) => projectRank(a) - projectRank(b) || byId(a, b));

  const lines: Array<string[] | string> = [
    ["TASK", "SITUATION", "LABELS", "TITLE"].map((head) => pc.bold(head)),
  ];
  const walk = (list: TreeNode[], depth: number) => {
    const indent = "  ".repeat(depth);
    for (const node of list) {
      lines.push([
        `${indent}${node.name}`,
        situationCell(node.d),
        labels(node.d).join(" · "),
        node.d.snapshot.task.title,
      ]);
      lines.push(...finishesAfterLines(node.d, `${indent}  `));
      walk(node.children.sort(byId), depth + 1);
    }
  };
  walk(roots, 0);
  return aligned(lines);
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
  const lines: Array<string[] | string> = [
    ["ID", "SITUATION", "LABELS", "TITLE"].map((head) => pc.bold(head)),
  ];
  for (const d of rows) {
    lines.push([
      shownId(d, options.project),
      situationCell(d),
      labels(d).join(" · "),
      d.snapshot.task.title,
    ]);
    const entry = d.derived.last_entry;
    if (entry !== null) {
      lines.push(`    ${pc.dim(entryHeading(entry))}`);
      lines.push(...indentLines(entry.text, "    "));
    }
  }
  return aligned(lines);
}

/**
 * The roster with its counts: listed actors first, in their order, then
 * the names open tasks carry that the roster lacks, which read as something
 * to fix. The caller is marked, and the footer says whether any name is
 * constrained at all.
 */
export function renderActors(result: ActorsJson): string {
  const lines: Array<string[] | string> = [
    ["ACTOR", "DESCRIPTION", "OPEN"].map((head) => pc.bold(head)),
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
      ["depends on", listOrNull(json.depends_on)],
      ["finishes after", listOrNull(json.finishes_after)],
      ["children", childrenField(d)],
      ["referenced by", listOrNull(extras.referenced_by)],
      ["workspace", listOrNull(extras.workspace)],
      ["created", json.created],
      ["updated", json.updated],
      ["path", json.path],
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
}

/**
 * `resume`: everything the next session reads to continue, in reading
 * order: the task, its ancestors (in the order given), its children,
 * the workspace, `state.md` in full, and the last log entry.
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
        ["depends on", listOrNull(json.depends_on)],
        ["finishes after", listOrNull(json.finishes_after)],
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
      [
        pc.bold("Last entry"),
        `  ${pc.dim(entryHeading(entry))}`,
        ...indentLines(entry.text, "  "),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/** Log entries, oldest first as given, each under its heading. */
export function renderLogEntries(entries: LogEntryJson[]): string {
  if (entries.length === 0) return ui.dim("No log entries.");
  return entries
    .map((entry) =>
      [
        `${pc.dim(entryHeading(entry))}  ${pc.bold(entry.task)}`,
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

/** `dep list` and `after list`: each reference and whether it is satisfied. */
export function renderDepList(refs: ResolvedRef[]): string {
  if (refs.length === 0) return ui.dim("No references.");
  const out = table(["REFERENCE", "SATISFIED", "DETAIL"]);
  for (const ref of refs) {
    out.push([
      ref.ref,
      ref.satisfied ? pc.green("yes") : pc.red("no"),
      ref.satisfied
        ? pc.dim(ref.status ?? "")
        : blockedDetail({
            ref: ref.ref,
            reason: ref.reason ?? "missing",
            status: ref.status,
          }),
    ]);
  }
  return out.toString();
}

/** The line under an overview: the count, scope and projects; malformed. */
export function renderCollectionFooter(
  collection: CollectionJson<unknown>,
): string {
  const parts = [plural(collection.count, "task")];
  if (collection.scope !== null) parts.push(`scope ${collection.scope}`);
  if (collection.projects.length > 0) {
    parts.push(`projects ${collection.projects.join(", ")}`);
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
}

function transitionHead(json: TaskWithDerivedJson, info: TransitionInfo) {
  const subject = `${info.command} ${json.id}`;
  if (info.from !== undefined && info.to !== undefined) {
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
