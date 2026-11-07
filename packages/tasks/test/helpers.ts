import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { run } from "../src/cli.js";
import type { Project } from "../src/core/discovery.js";
import type { Tree } from "../src/core/tree.js";
import { loadTree } from "../src/core/tree.js";
import {
  ACTOR_ENV,
  CONFIG_FILENAME,
  GITIGNORE_FILENAME,
  SESSION_ENV,
  TASKS_DIRNAME,
} from "../src/core/types.js";
import type { TreeSpec } from "./fixtures.js";
import { FIXTURE_ACTOR, addProjectAlias, writeTree } from "./fixtures.js";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: <T = unknown>() => T;
}

export interface RunOptions {
  /** Variables for this call only; `undefined` removes one. */
  env?: Record<string, string | undefined>;
  /** Working directory: relative to the project root, or absolute. */
  cwd?: string;
}

export type Runner = (...argv: string[]) => Promise<CliResult>;

export interface Sandbox {
  /** The temporary directory holding the project and any sibling project. */
  root: string;
  /** The local project root, where commands run by default. */
  dir: string;
  /** `<dir>/.tasks`. */
  tasksDir: string;
  /** The local project, for calling core functions directly. */
  local: Project;
  /** Run the CLI in-process as `tester`, with no session in the environment. */
  run: Runner;
  runWith: (options: RunOptions, ...argv: string[]) => Promise<CliResult>;
  /** A runner that appends `--session <token>` to every call. */
  session: (token: string) => Runner;
  /** Lay out a v2 tree in the project (additive; rewrites `config.yml`). */
  tree: (spec?: TreeSpec) => Promise<void>;
  /**
   * Create a project root at `relPath` (resolved from `dir`, kept inside the
   * sandbox) with its own tree, and list it as `alias` in the local tree.
   * Returns the absolute project root.
   */
  project: (alias: string, relPath: string, spec?: TreeSpec) => Promise<string>;
  /** The minimal valid v2 tree: `config.yml` and `.gitignore`. */
  initV2: () => Promise<void>;
  /** Back-date a file's mtime (and atime) by `minutes`. */
  age: (relative: string, minutes: number) => Promise<void>;
  /** A fresh snapshot of the local tree. */
  loadTree: () => Promise<Tree>;
  read: (relative: string) => Promise<string>;
  write: (relative: string, contents: string) => Promise<void>;
  exists: (relative: string) => Promise<boolean>;
  cleanup: () => Promise<void>;
}

/**
 * What every call sees unless the test overrides it: a fixed actor, so no
 * test depends on the machine's git identity, and no session leaking in
 * from the environment the suite runs in.
 */
const DEFAULT_ENV: Record<string, string | undefined> = {
  [ACTOR_ENV]: FIXTURE_ACTOR,
  [SESSION_ENV]: undefined,
};

function applyEnv(
  env: Record<string, string | undefined>,
): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] !== ".."
  );
}

export async function makeSandbox(): Promise<Sandbox> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tasks-"));
  // macOS temp dirs are symlinked via /private; resolve so paths compare.
  const root = await fs.realpath(temp);
  const dir = path.join(root, "repo");
  await fs.mkdir(dir);
  const tasksDir = path.join(dir, TASKS_DIRNAME);
  const previousCwd = process.cwd();

  const runWith = async (
    options: RunOptions,
    ...argv: string[]
  ): Promise<CliResult> => {
    let stdout = "";
    let stderr = "";

    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stdout += String(chunk);
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stderr += String(chunk);
        return true;
      });

    const saved = applyEnv({ ...DEFAULT_ENV, ...options.env });
    process.chdir(path.resolve(dir, options.cwd ?? "."));
    process.exitCode = 0;

    try {
      const code = await run(argv);
      return {
        code,
        stdout,
        stderr,
        json: <T>() => JSON.parse(stdout || stderr) as T,
      };
    } finally {
      process.exitCode = 0;
      process.chdir(previousCwd);
      restoreEnv(saved);
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  };

  const sandbox: Sandbox = {
    root,
    dir,
    tasksDir,
    local: { root: dir, tasksDir },

    run: (...argv) => runWith({}, ...argv),
    runWith,
    session:
      (token) =>
      (...argv) =>
        runWith({}, ...argv, "--session", token),

    tree: (spec = {}) => writeTree(tasksDir, spec),

    async project(alias, relPath, spec = {}) {
      const projectRoot = path.resolve(dir, relPath);
      if (!isInside(projectRoot, root)) {
        throw new Error(`Sibling project "${relPath}" leaves the sandbox.`);
      }
      await writeTree(path.join(projectRoot, TASKS_DIRNAME), spec);
      await addProjectAlias(tasksDir, alias, relPath);
      return projectRoot;
    },

    async initV2() {
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(path.join(tasksDir, CONFIG_FILENAME), "version: 2\n");
      await fs.writeFile(path.join(tasksDir, GITIGNORE_FILENAME), ".locks/\n");
    },

    async age(relative, minutes) {
      const past = new Date(Date.now() - minutes * 60_000);
      await fs.utimes(path.resolve(dir, relative), past, past);
    },

    loadTree: () => loadTree({ root: dir, tasksDir }),

    read: (relative) => fs.readFile(path.resolve(dir, relative), "utf8"),

    async write(relative, contents) {
      const file = path.resolve(dir, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents, "utf8");
    },

    async exists(relative) {
      try {
        await fs.stat(path.resolve(dir, relative));
        return true;
      } catch {
        return false;
      }
    },

    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };

  return sandbox;
}

/** A sandbox whose project already holds the tree `spec` describes. */
export async function treeSandbox(spec: TreeSpec = {}): Promise<Sandbox> {
  const sandbox = await makeSandbox();
  await sandbox.tree(spec);
  return sandbox;
}
