import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import {
  assertV2Tree,
  globalOptions,
  resolveCommandIdentity,
  startDirectory,
} from "../context.js";
import { isDirectory, pathExists, writeFileAtomic } from "../core/fs-utils.js";
import { assertActor, touchSession } from "../core/sessions.js";
import type { SkillInstallResult } from "../core/skill.js";
import {
  SKILLS_RELATIVE_DIR,
  SKILL_NAME,
  installSkill,
} from "../core/skill.js";
import {
  configTemplate,
  defaultRoster,
  gitignoreTemplate,
  readmeTemplate,
} from "../core/templates.js";
import type { Identity } from "../core/types.js";
import {
  AGENT_ACTOR,
  AGENT_DESCRIPTION,
  CONFIG_FILENAME,
  GITIGNORE_FILENAME,
  LOCKS_DIRNAME,
  README_FILENAME,
  TASKS_DIRNAME,
} from "../core/types.js";
import { TaskError } from "../errors.js";
import { emitJson, ui, writeOut } from "../output.js";

interface InitOptions {
  force?: boolean;
  /** `--no-skill` sets it to false. */
  skill?: boolean;
  /** `--actors`: `true` for the proposed roster, else the names given. */
  actors?: string | true;
  json?: boolean;
}

type Roster = Record<string, string | null>;

/** What `init --json` prints. */
export interface InitJson {
  actor: string;
  via: string | null;
  /** The roster `--actors` wrote, in order; `null` when it stays commented. */
  actors: string[] | null;
  tasksDir: string;
  /** Absolute paths of the files and directories this run created. */
  created: string[];
  skill: Pick<SkillInstallResult, "installed" | "dir" | "files"> | null;
}

/**
 * Decide what an existing `.tasks/` allows. A v1 or unsupported tree is
 * refused before anything else, `--force` or not: every command but
 * `migrate` refuses a v1 tree, and completing its scaffold would hide its
 * tasks from `migrate`. A directory without `config.yml` is a v1 tree by the
 * convention's rule once it holds a directory other than `.locks/` (a phase,
 * an archive); one holding only files is an interrupted `init` or a bare
 * `mkdir`, which `--force` completes.
 */
async function checkExisting(
  root: string,
  tasksDir: string,
  force: boolean,
): Promise<void> {
  if (!(await isDirectory(tasksDir))) {
    throw TaskError.conflict(
      `${tasksDir} exists and is not a directory; move it aside first.`,
      { path: tasksDir },
    );
  }
  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const unfinished =
    !entries.some((entry) => entry.name === CONFIG_FILENAME) &&
    entries.every(
      (entry) => !entry.isDirectory() || entry.name === LOCKS_DIRNAME,
    );
  if (!unfinished) await assertV2Tree({ root, tasksDir });
  if (!force) {
    throw TaskError.conflict(
      `${TASKS_DIRNAME}/ already exists at ${tasksDir}. Use --force to add the scaffold files it lacks; existing files are kept.`,
      { path: tasksDir },
    );
  }
}

/** Write `contents` to `file` unless it exists; true when written. */
async function writeIfAbsent(file: string, contents: string): Promise<boolean> {
  // Under --force an edited config.yml (or README) must survive.
  if (await pathExists(file)) return false;
  await writeFileAtomic(file, contents);
  return true;
}

function actorLine(identity: Identity): string {
  const via = identity.via === null ? "" : ` via ${identity.via}`;
  return `  actor: ${ui.bold(identity.actor)}${via} ${ui.dim("(heads every log entry you write; TASKS_ACTOR or --as changes it)")}`;
}

function actorsLine(roster: Roster | null): string {
  if (roster === null) {
    return `  actors: ${ui.dim(`none listed; uncomment actors: in ${CONFIG_FILENAME} to keep a roster`)}`;
  }
  return `  actors: ${ui.bold(Object.keys(roster).join(", "))} ${ui.dim(`(listed in ${CONFIG_FILENAME}; other names are refused until added there)`)}`;
}

/**
 * The roster `--actors` asks for: the proposed one (the resolved actor and
 * `agent`) without a value, else the names given, comma-separated. Checked
 * before anything is written.
 */
function rosterFrom(
  value: string | true | undefined,
  actor: string,
): Roster | null {
  if (value === undefined) return null;
  if (value === true) {
    // The agent setting up a tree for a person: the proposed roster would
    // name the agent alone, and the person would never be assignable.
    if (actor === AGENT_ACTOR) {
      throw TaskError.usage(
        `--actors without names lists the resolved actor and ${AGENT_ACTOR}, which here are one and the same; name the people too: --actors <person>,${AGENT_ACTOR}.`,
        { option: "--actors", actor },
      );
    }
    return defaultRoster(actor);
  }
  const roster = Object.create(null) as Roster;
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name === "") continue;
    assertActor(name, "--actors");
    roster[name] = name === AGENT_ACTOR ? AGENT_DESCRIPTION : null;
  }
  if (Object.keys(roster).length === 0) {
    throw TaskError.usage(
      `--actors needs a comma-separated list of actors, or no value for the resolved actor and ${AGENT_ACTOR}.`,
      { option: "--actors", value },
    );
  }
  return roster;
}

export function initCommand(): Command {
  return new Command("init")
    .description(
      `scaffold a ${TASKS_DIRNAME}/ tree in the current directory (or -C <dir>), print the actor it resolved, and install the agent skill`,
    )
    .option(
      "--force",
      "add the scaffold files an existing tree lacks; never overwrites a file",
    )
    .option(
      "--no-skill",
      `skip installing the agent skill into ${SKILLS_RELATIVE_DIR}/`,
    )
    .option(
      "--actors [names]",
      `write the roster of actors tasks may be assigned to, on from the start: the resolved actor and ${AGENT_ACTOR}, or a comma-separated list`,
    )
    .option("--json", "emit machine-readable JSON")
    .action(async (options: InitOptions, command: Command) => {
      const global = globalOptions(command);
      const root = startDirectory(global);
      if (!(await isDirectory(root))) {
        throw TaskError.notFound(`"${root}" is not a directory.`, {
          cwd: root,
        });
      }
      // Resolved before anything is written: an invalid --as, TASKS_ACTOR or
      // --session fails the command with nothing on disk.
      const identity = await resolveCommandIdentity(global, root);
      const roster = rosterFrom(options.actors, identity.actor);

      const tasksDir = path.join(root, TASKS_DIRNAME);
      if (await pathExists(tasksDir)) {
        await checkExisting(root, tasksDir, options.force === true);
      }
      // The roster goes into a config.yml this run writes; an existing one
      // is never rewritten, so the names belong in it by hand.
      const configFile = path.join(tasksDir, CONFIG_FILENAME);
      if (roster !== null && (await pathExists(configFile))) {
        throw TaskError.usage(
          `${configFile} exists; list the actors under actors: there instead of passing --actors.`,
          { file: configFile, option: "--actors" },
        );
      }

      const created: string[] = [];
      await fs.mkdir(tasksDir, { recursive: true });
      const files: ReadonlyArray<readonly [string, string]> = [
        [
          CONFIG_FILENAME,
          configTemplate({
            actors: roster ?? defaultRoster(identity.actor),
            live: roster !== null,
          }),
        ],
        [README_FILENAME, readmeTemplate()],
        [GITIGNORE_FILENAME, gitignoreTemplate()],
      ];
      for (const [name, contents] of files) {
        const file = path.join(tasksDir, name);
        if (await writeIfAbsent(file, contents)) created.push(file);
      }
      const locks = path.join(tasksDir, LOCKS_DIRNAME);
      if ((await fs.mkdir(locks, { recursive: true })) !== undefined) {
        created.push(locks);
      }
      // Every command that knows a session touches the registry of the tree
      // it runs in; the tree exists from this point on.
      if (identity.session) await touchSession(tasksDir, identity.session);

      // The skill is what makes an agent reach for the CLI unprompted, so it
      // ships with the scaffold. An existing install is left alone, as the
      // config is; refreshing it is `tasks skill install --force`.
      const skill = options.skill === false ? null : await installSkill(root);

      if (options.json) {
        const result: InitJson = {
          actor: identity.actor,
          via: identity.via,
          actors: roster === null ? null : Object.keys(roster),
          tasksDir,
          created,
          skill: skill && {
            installed: skill.installed,
            dir: skill.dir,
            files: skill.files,
          },
        };
        emitJson(result);
        return;
      }

      const shown = (target: string) =>
        path.relative(process.cwd(), target) +
        (target === locks ? path.sep : "");
      writeOut(
        created.length === 0
          ? ui.info(
              `${TASKS_DIRNAME}/ at ${tasksDir} is complete; nothing to create`,
            )
          : ui.success(
              `Initialized ${ui.bold(`${TASKS_DIRNAME}/`)} at ${tasksDir}`,
            ),
      );
      writeOut(actorLine(identity));
      if (created.includes(configFile)) writeOut(actorsLine(roster));
      for (const target of created) writeOut(`  ${ui.dim(shown(target))}`);
      if (skill?.installed) {
        for (const file of skill.files) writeOut(`  ${ui.dim(shown(file))}`);
      }
      writeOut("");
      if (skill?.installed) {
        writeOut(
          ui.info(
            `Installed the ${ui.bold(SKILL_NAME)} skill so agents in this repo find the CLI.`,
          ),
        );
      } else if (skill !== null) {
        writeOut(
          ui.info(
            `The ${ui.bold(SKILL_NAME)} skill is already installed at ${shown(skill.dir)}; refresh it with ${ui.bold("tasks skill install --force")}.`,
          ),
        );
      }
      writeOut(
        ui.info(
          `Create your first task: ${ui.bold("tasks new <path> <title…>")}`,
        ),
      );
    });
}
