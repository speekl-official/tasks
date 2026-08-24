import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { run } from "../src/cli.js";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: <T = unknown>() => T;
}

export interface Sandbox {
  dir: string;
  run: (...argv: string[]) => Promise<CliResult>;
  read: (relative: string) => Promise<string>;
  write: (relative: string, contents: string) => Promise<void>;
  exists: (relative: string) => Promise<boolean>;
  cleanup: () => Promise<void>;
}

export async function makeSandbox(): Promise<Sandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tasks-"));
  // macOS temp dirs are symlinked via /private; resolve so path comparisons hold.
  const real = await fs.realpath(dir);
  const previousCwd = process.cwd();

  return {
    dir: real,

    async run(...argv: string[]): Promise<CliResult> {
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

      process.chdir(real);
      process.exitCode = 0;

      try {
        const code = await run(argv);
        return {
          code,
          stdout,
          stderr,
          json: <T,>() => JSON.parse(stdout || stderr) as T,
        };
      } finally {
        process.exitCode = 0;
        outSpy.mockRestore();
        errSpy.mockRestore();
        process.chdir(previousCwd);
      }
    },

    read: (relative) => fs.readFile(path.join(real, relative), "utf8"),

    write: async (relative, contents) => {
      const file = path.join(real, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents, "utf8");
    },

    exists: async (relative) => {
      try {
        await fs.stat(path.join(real, relative));
        return true;
      } catch {
        return false;
      }
    },

    cleanup: async () => {
      await fs.rm(real, { recursive: true, force: true });
    },
  };
}

/** A sandbox with `.tasks/` already initialized. */
export async function initializedSandbox(): Promise<Sandbox> {
  const sandbox = await makeSandbox();
  await sandbox.run("init");
  return sandbox;
}
