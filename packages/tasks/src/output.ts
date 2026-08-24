import Table from "cli-table3";
import pc from "picocolors";

import type { Config } from "./core/config.js";
import type { DependencyStatus } from "./core/deps.js";
import { describeUnsatisfied } from "./core/deps.js";
import type { Task } from "./core/task.js";

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

export function colorStatus(status: string, config: Config): string {
  if (status === config.roles.done) return pc.green(status);
  if (status === config.roles.claimed) return pc.yellow(status);
  if (status === config.roles.ready) return pc.cyan(status);
  return pc.dim(status);
}

function table(head: string[]): Table.Table {
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

export function taskToJson(task: Task, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: task.id,
    phase: task.phase,
    status: task.status,
    depends_on: task.depends_on,
    created: task.created,
    updated: task.updated,
    claimed_by: task.claimed_by,
    claimed_at: task.claimed_at,
    path: task.filePath,
    ...extra,
  };
}

export function renderTaskTable(tasks: Task[], config: Config, showPhase = true): string {
  const head = showPhase
    ? ["ID", "STATUS", "PHASE", "DEPENDS ON", "UPDATED"]
    : ["ID", "STATUS", "DEPENDS ON", "UPDATED"];
  const t = table(head);

  for (const task of tasks) {
    const deps = task.depends_on.length ? task.depends_on.join(", ") : pc.dim("—");
    const updated = pc.dim(task.updated.replace("T", " ").replace("Z", ""));
    t.push(
      showPhase
        ? [task.id, colorStatus(task.status, config), task.phase, deps, updated]
        : [task.id, colorStatus(task.status, config), deps, updated],
    );
  }

  return t.toString();
}

export function renderDependencyList(deps: DependencyStatus[]): string {
  const t = table(["DEPENDENCY", "SATISFIED", "DETAIL"]);
  for (const dep of deps) {
    t.push([
      dep.raw,
      dep.satisfied ? pc.green("yes") : pc.red("no"),
      dep.satisfied ? pc.dim(dep.status ?? "") : pc.dim(describeUnsatisfied(dep)),
    ]);
  }
  return t.toString();
}

export const ui = {
  success: (msg: string): string => `${pc.green("✓")} ${msg}`,
  info: (msg: string): string => `${pc.cyan("•")} ${msg}`,
  warn: (msg: string): string => `${pc.yellow("!")} ${msg}`,
  error: (msg: string): string => `${pc.red("✗")} ${msg}`,
  dim: (msg: string): string => pc.dim(msg),
  bold: (msg: string): string => pc.bold(msg),
};
