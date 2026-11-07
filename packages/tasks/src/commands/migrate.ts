import { Command } from "commander";

import type { CommandContext } from "../context.js";
import {
  globalOptions,
  openContext,
  resolveCommandIdentity,
  startDirectory,
} from "../context.js";
import type { Project } from "../core/discovery.js";
import { findProject, requireProject } from "../core/discovery.js";
import type { MigrateJson, Migration } from "../core/migrate/migrate.js";
import {
  migrateJson,
  migrateTree,
  parsePhaseMappings,
  parseStatusMappings,
  rewriteReferencesInto,
} from "../core/migrate/migrate.js";
import { CONVENTION_VERSION, STATUSES } from "../core/types.js";
import { TaskError } from "../errors.js";
import { emitJson, ui, writeOut } from "../output.js";

interface MigrateCommandOptions {
  /** Absent until the option is given once; no default, so help shows none. */
  map?: string[];
  mapPhase?: string[];
  json?: boolean;
}

/** A repeatable option: every occurrence, in order. */
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The v1 tree a listed alias names. Every other answer is refused the way
 * addressing `alias:task` refuses it, except that a v2 tree has nothing to
 * migrate.
 */
async function listedV1Project(
  context: CommandContext,
  alias: string,
): Promise<Project> {
  const target = await context.projects.byAlias(alias);
  switch (target.kind) {
    case "ok":
      throw TaskError.usage(
        `Project ${alias} (${target.project.tasksDir}) is already a .tasks v${CONVENTION_VERSION} tree; there is nothing to migrate.`,
        {
          alias,
          tasksDir: target.project.tasksDir,
          version: CONVENTION_VERSION,
        },
      );
    case "not-checked-out":
      throw TaskError.notFound(
        `Project ${alias} (${target.relPath}) is not checked out: ${target.dir} does not exist.`,
        { alias, path: target.relPath, reason: "not-checked-out" },
      );
    case "unresolved":
      if (target.cause !== null) throw target.cause;
      throw TaskError.notFound(
        `Project ${alias} (${target.relPath}) has no .tasks/ tree at ${target.dir}.`,
        { alias, path: target.relPath, reason: "unresolved-project" },
      );
    case "unsupported-version": {
      if (target.version !== 1) {
        throw TaskError.usage(
          `Project ${alias} declares .tasks version ${target.version}, which is not supported; migrate upgrades a v1 tree to v${CONVENTION_VERSION}.`,
          { alias, path: target.relPath, version: target.version },
        );
      }
      const found = await findProject(target.dir);
      if (found === null) {
        throw TaskError.notFound(
          `Project ${alias} (${target.relPath}) has no .tasks/ tree at ${target.dir}.`,
          { alias, path: target.relPath, reason: "unresolved-project" },
        );
      }
      return found;
    }
  }
}

function renderMigration(result: MigrateJson, migration: Migration): string {
  const name =
    migration.qualifier === null
      ? result.tree
      : `${migration.qualifier} (${result.tree})`;
  const counts = [plural(result.tasks, "task")];
  if (result.archived > 0)
    counts.push(plural(result.archived, "archived task"));

  const phases = Object.entries(result.phases).map(([from, to]) =>
    from === to ? from : `${from} → ${to}`,
  );
  const statuses = Object.entries(result.statuses).map(
    ([from, to]) => `${from} → ${to}`,
  );
  const readme = {
    replaced: "replaced with the v2 scaffold",
    kept: "kept: it was edited",
    absent: "none",
  }[result.readme];
  const rows: Array<[string, string]> = [
    ["phases", phases.join(", ") || "none"],
    ["statuses", statuses.join(", ") || "none"],
    ["scope", result.scope ?? "none"],
    [
      "references",
      `${result.rewritten.length} rewritten, ${result.unrewritten.length} kept as written`,
    ],
    ["README.md", readme],
    [
      "index.md",
      migration.legacyIndex ? "generated; _index.md removed" : "generated",
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  return [
    ui.success(
      `Migrated ${name} to .tasks v${CONVENTION_VERSION}: ${counts.join(", ")}`,
    ),
    ...rows.map(
      ([label, value]) => `  ${ui.dim(label.padEnd(width))}  ${value}`,
    ),
    ...result.consequences.map((line) => ui.warn(line)),
  ].join("\n");
}

export function migrateCommand(): Command {
  return new Command("migrate")
    .summary(
      "upgrade a .tasks v1 tree to v2, once: this tree or a project it lists",
    )
    .description(
      "upgrade a .tasks v1 tree to v2, once: this tree, or a project it lists;\n" +
        "every task moves to <phase>/<id>/task.md, ids in depends_on become paths,\n" +
        "and nothing is written unless the whole tree can be migrated",
    )
    .argument(
      "[alias]",
      "a project this tree lists under projects:, whose v1 tree to upgrade from here",
    )
    .option(
      "--map <OLD=NEW>",
      `the v2 status of a v1 status outside the roles (one of ${STATUSES.join(", ")}); repeatable`,
      collect,
    )
    .option(
      "--map-phase <OLD=NEW>",
      "the v2 directory name of a v1 phase, needed when its name has a . or _; repeatable",
      collect,
    )
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        alias: string | undefined,
        options: MigrateCommandOptions,
        command: Command,
      ) => {
        // A malformed mapping is refused before any tree is read.
        const mappings = {
          statusMap: parseStatusMappings(options.map ?? []),
          phaseMap: parsePhaseMappings(options.mapPhase ?? []),
        };

        let migration: Migration;
        if (alias === undefined) {
          // The local tree is v1, which `openContext` refuses: discovery and
          // identity are done here, the identity before anything is written,
          // so an invalid --as, TASKS_ACTOR or --session fails as anywhere.
          const global = globalOptions(command);
          const project = await requireProject(startDirectory(global));
          await resolveCommandIdentity(global, project.root);
          migration = await migrateTree(project, {
            ...mappings,
            qualifier: null,
          });
        } else {
          const context = await openContext(command);
          const project = await listedV1Project(context, alias);
          migration = await migrateTree(project, {
            ...mappings,
            qualifier: alias,
          });
        }

        // Opened afresh now that the tree is v2: it records the session's
        // heartbeat there too, and sees the migrated tree as v2 when it
        // repairs the references other trees hold into it.
        const context = await openContext(command);
        const into = await rewriteReferencesInto(context, migration);
        const result = migrateJson(migration, into);

        if (options.json) emitJson(result);
        else writeOut(renderMigration(result, migration));
      },
    );
}
