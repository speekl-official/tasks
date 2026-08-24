import { Command } from "commander";

import { openTree } from "../context.js";
import { DependencyResolver, wouldCreateCycle } from "../core/deps.js";
import { mutateTask } from "../core/mutate.js";
import { parseRef } from "../core/refs.js";
import { findTask } from "../core/repo.js";
import { TaskError } from "../errors.js";
import { emitJson, renderDependencyList, taskToJson, ui, writeOut } from "../output.js";

export function depCommand(): Command {
  const dep = new Command("dep").description("manage a task's dependencies");

  dep
    .command("add")
    .description("add one or more dependencies to a task")
    .argument("<id>", "task id")
    .argument("<ref...>", "dependency refs: <id> or <relative-path>:<id>")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, refs: string[], options: { json?: boolean }) => {
      const tree = await openTree();
      const parsed = refs.map((raw) => parseRef(raw));

      for (const ref of parsed) {
        if (ref.kind === "local") {
          if (ref.id === id) {
            throw TaskError.usage(`Task "${id}" cannot depend on itself.`, { id });
          }
          // Fail loudly on a typo rather than writing a permanently blocking ref.
          findTask(tree, ref.id);
        }
      }

      const localIds = parsed.filter((r) => r.kind === "local").map((r) => r.id);
      if (localIds.length > 0 && wouldCreateCycle(tree.tasks, id, localIds)) {
        throw TaskError.conflict(
          `Adding ${localIds.join(", ")} to "${id}" would create a dependency cycle.`,
          { id, refs: localIds },
        );
      }

      const task = await mutateTask(tree, id, (fresh) => {
        const merged = [...fresh.depends_on];
        for (const ref of parsed) {
          if (!merged.includes(ref.raw)) merged.push(ref.raw);
        }
        return { ...fresh, depends_on: merged };
      });

      if (options.json) {
        emitJson(taskToJson(task));
        return;
      }
      writeOut(ui.success(`${ui.bold(id)} now depends on: ${task.depends_on.join(", ")}`));
    });

  dep
    .command("rm")
    .description("remove one or more dependencies from a task")
    .argument("<id>", "task id")
    .argument("<ref...>", "dependency refs to remove")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, refs: string[], options: { json?: boolean }) => {
      const tree = await openTree();
      const targets = new Set(refs.map((r) => r.trim()));

      const task = await mutateTask(tree, id, (fresh) => {
        const missing = [...targets].filter((t) => !fresh.depends_on.includes(t));
        if (missing.length > 0) {
          throw TaskError.notFound(
            `Task "${id}" does not depend on: ${missing.join(", ")}.`,
            { id, refs: missing },
          );
        }
        return { ...fresh, depends_on: fresh.depends_on.filter((d) => !targets.has(d)) };
      });

      if (options.json) {
        emitJson(taskToJson(task));
        return;
      }
      writeOut(
        ui.success(
          `${ui.bold(id)} now depends on: ${task.depends_on.length ? task.depends_on.join(", ") : "nothing"}`,
        ),
      );
    });

  dep
    .command("list")
    .description("show a task's dependencies and whether each is satisfied")
    .argument("<id>", "task id")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const tree = await openTree();
      const task = findTask(tree, id);
      const deps = await new DependencyResolver(tree).resolveAll(task.depends_on);

      if (options.json) {
        emitJson({
          id: task.id,
          count: deps.length,
          blocked: deps.some((d) => !d.satisfied),
          dependencies: deps.map((d) => ({
            ref: d.raw,
            satisfied: d.satisfied,
            status: d.status ?? null,
            reason: d.reason ?? null,
          })),
        });
        return;
      }

      if (deps.length === 0) {
        writeOut(ui.dim(`${id} has no dependencies.`));
        return;
      }
      writeOut(renderDependencyList(deps));
    });

  return dep;
}
