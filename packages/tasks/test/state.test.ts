import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { STATE_SKELETON, readStdin } from "../src/commands/state.js";
import type { TreeSpec } from "./fixtures.js";
import type { CliResult, Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface StateJson {
  id: string;
  path: string;
  bytes: number;
}

function errorOf(result: CliResult): ErrorJson["error"] {
  return result.json<ErrorJson>().error;
}

async function box(spec: TreeSpec): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

/** What the command reads as standard input for the rest of the test. */
function feedStdin(...chunks: string[]): void {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from(
      chunks.map((chunk) => Buffer.from(chunk, "utf8")),
    ) as unknown as typeof process.stdin,
  );
}

/**
 * A stand-in editor: it copies what it was given next to itself, then
 * replaces the file with `content`, or exits with `code` untouched. The
 * variable is a command line with an argument, as `code --wait` would be;
 * running the script through `sh` also spares macOS vetting a fresh binary.
 */
async function fakeEditor(
  s: Sandbox,
  options: { content?: string; code?: number },
): Promise<string> {
  const script = path.join(s.root, "editor.sh");
  const body =
    options.code !== undefined
      ? `exit ${options.code}`
      : `printf '%s' '${options.content ?? ""}' > "$1"`;
  await fs.writeFile(
    script,
    `#!/bin/sh\ncp "$1" "$(dirname "$0")/seen.md"\n${body}\n`,
    { mode: 0o755 },
  );
  return `sh ${script}`;
}

describe("readStdin", () => {
  it("reads a whole stream as UTF-8, across chunk boundaries", async () => {
    const bytes = Buffer.from("## Done\n\nnaïve café ✓\n", "utf8");
    // Split inside a multi-byte character.
    const stream = Readable.from([bytes.subarray(0, 14), bytes.subarray(14)]);
    expect(await readStdin(stream)).toBe("## Done\n\nnaïve café ✓\n");
  });
});

describe("state <task> from standard input", () => {
  it("writes exactly the content and nothing else", async () => {
    const s = await box({ tasks: { "x/a": {} } });
    const manifest = await s.read(".tasks/x/a/task.md");
    feedStdin("## Done\n\nwired ", "the parser\n\n## Next\n\ntests");

    const result = await s.run("state", "a", "--json");
    expect(result.code).toBe(0);
    const content = "## Done\n\nwired the parser\n\n## Next\n\ntests";
    expect(result.json<StateJson>()).toEqual({
      id: "x/a",
      path: path.join(s.tasksDir, "x", "a", "state.md"),
      bytes: Buffer.byteLength(content, "utf8"),
    });
    expect(await s.read(".tasks/x/a/state.md")).toBe(content);
    // No transition, no log entry, no manifest change.
    expect(await s.read(".tasks/x/a/task.md")).toBe(manifest);
    expect(await s.exists(".tasks/x/a/log.md")).toBe(false);
  });

  it("replaces an existing state.md and prints one line", async () => {
    const s = await box({ tasks: { a: { state: "old\n" } } });
    feedStdin("new\n");
    const result = await s.run("state", "a");
    expect(result.code).toBe(0);
    expect(stripVTControlCharacters(result.stdout)).toMatch(
      /^✓ state a: wrote 4 bytes to /,
    );
    expect(await s.read(".tasks/a/state.md")).toBe("new\n");
  });

  it("refuses empty input as usage and writes nothing", async () => {
    const s = await box({ tasks: { a: { state: "keep\n" } } });
    feedStdin("  \n\t\n");
    const result = await s.run("state", "a", "--json");
    expect(result.code).toBe(2);
    expect(errorOf(result).message).toContain("empty state.md");
    expect(await s.read(".tasks/a/state.md")).toBe("keep\n");
  });

  it("refuses a session whose claim was taken over", async () => {
    const s = await box({
      tasks: {
        w: { status: "IN_PROGRESS", claimed_session: "s2", state: "theirs\n" },
      },
    });
    await s.write(".tasks/.locks/sessions/s2", "");
    feedStdin("mine\n");

    const result = await s.session("s1")("state", "w", "--json");
    expect(result.code).toBe(4);
    expect(errorOf(result).details).toEqual({
      kind: "authorization",
      id: "w",
      claimed_by: "tester",
      claimed_session: "s2",
      assignee: null,
      liveness: "live",
    });
    expect(await s.read(".tasks/w/state.md")).toBe("theirs\n");
  });

  it("admits the claimant's own session", async () => {
    const s = await box({
      tasks: { w: { status: "IN_PROGRESS", claimed_session: "s2" } },
    });
    feedStdin("progress\n");
    const result = await s.session("s2")("state", "w");
    expect(result.code).toBe(0);
    expect(await s.read(".tasks/w/state.md")).toBe("progress\n");
  });

  it("follows the assignee rule, and --force overrides it", async () => {
    const s = await box({ tasks: { a: { assignee: "alice" } } });
    feedStdin("not mine\n");
    const refused = await s.run("state", "a", "--json");
    expect(refused.code).toBe(4);
    expect(errorOf(refused).details).toMatchObject({ assignee: "alice" });
    expect(await s.exists(".tasks/a/state.md")).toBe(false);

    feedStdin("forced\n");
    expect((await s.run("state", "a", "--force")).code).toBe(0);
    expect(await s.read(".tasks/a/state.md")).toBe("forced\n");
    // Still nothing logged: state never writes the log.
    expect(await s.exists(".tasks/a/log.md")).toBe(false);
  });

  it("writes the state.md of a task in a listed project", async () => {
    const s = await box({});
    const backend = await s.project("backend", "../backend", {
      tasks: { "kernel/x": {} },
    });
    feedStdin("remote\n");
    const result = await s.run("state", "backend:x", "--json");
    expect(result.code).toBe(0);
    expect(result.json<StateJson>().id).toBe("backend:kernel/x");
    expect(
      await fs.readFile(
        path.join(backend, ".tasks", "kernel", "x", "state.md"),
        "utf8",
      ),
    ).toBe("remote\n");
  });

  it("refreshes index.md, which shows whether a backlog task was started", async () => {
    const s = await box({ tasks: { idea: { status: "BACKLOG" } } });
    expect((await s.run("new", "other", "Other")).code).toBe(0);
    await s.write(".tasks/index.md", "stale\n");
    feedStdin("began\n");
    expect((await s.run("state", "idea")).code).toBe(0);
    expect(await s.read(".tasks/index.md")).toContain("parked");
  });
});

describe("state --edit", () => {
  it("is a usage error when neither VISUAL nor EDITOR is set", async () => {
    const s = await box({ tasks: { a: {} } });
    const result = await s.runWith(
      { env: { VISUAL: undefined, EDITOR: undefined } },
      "state",
      "a",
      "--edit",
      "--json",
    );
    expect(result.code).toBe(2);
    expect(errorOf(result).message).toContain("VISUAL");
    expect(await s.exists(".tasks/a/state.md")).toBe(false);
  });

  it("opens the current state.md and writes what the editor saved", async () => {
    const s = await box({ tasks: { a: { state: "## Done\n\nbefore\n" } } });
    const editor = await fakeEditor(s, { content: "## Done\n\nafter" });
    const result = await s.runWith(
      { env: { VISUAL: editor, EDITOR: undefined } },
      "state",
      "a",
      "--edit",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.json<StateJson>().bytes).toBe(
      Buffer.byteLength("## Done\n\nafter"),
    );
    expect(await fs.readFile(path.join(s.root, "seen.md"), "utf8")).toBe(
      "## Done\n\nbefore\n",
    );
    expect(await s.read(".tasks/a/state.md")).toBe("## Done\n\nafter");
  });

  it("starts from the four-section skeleton when there is no state.md, via EDITOR", async () => {
    const s = await box({ tasks: { a: {} } });
    const editor = await fakeEditor(s, { content: "first resume point" });
    const result = await s.runWith(
      { env: { VISUAL: undefined, EDITOR: editor } },
      "state",
      "a",
      "--edit",
    );
    expect(result.code).toBe(0);
    expect(await fs.readFile(path.join(s.root, "seen.md"), "utf8")).toBe(
      STATE_SKELETON,
    );
    expect(await s.read(".tasks/a/state.md")).toBe("first resume point");
  });

  it("writes nothing when the editor fails", async () => {
    const s = await box({ tasks: { a: { state: "keep\n" } } });
    const editor = await fakeEditor(s, { code: 3 });
    const result = await s.runWith(
      { env: { VISUAL: editor } },
      "state",
      "a",
      "--edit",
      "--json",
    );
    expect(result.code).toBe(4);
    expect(errorOf(result).message).toContain("exited with code 3");
    expect(await s.read(".tasks/a/state.md")).toBe("keep\n");
  });

  it("refuses an empty save", async () => {
    const s = await box({ tasks: { a: { state: "keep\n" } } });
    const editor = await fakeEditor(s, { content: "" });
    const result = await s.runWith(
      { env: { VISUAL: editor } },
      "state",
      "a",
      "--edit",
    );
    expect(result.code).toBe(2);
    expect(await s.read(".tasks/a/state.md")).toBe("keep\n");
  });

  it("refuses when state.md changed during the edit, keeping the edited text", async () => {
    const s = await box({ tasks: { a: { state: "before\n" } } });
    const live = path.join(s.tasksDir, "a", "state.md");
    const racer = path.join(s.root, "racer.sh");
    // Saves its own text, while another writer replaces the real file.
    await fs.writeFile(
      racer,
      `#!/bin/sh\nprintf 'mine' > "$1"\nprintf 'theirs' > '${live}'\n`,
    );
    const result = await s.runWith(
      { env: { VISUAL: `sh ${racer}` } },
      "state",
      "a",
      "--edit",
      "--json",
    );
    expect(result.code).toBe(4);
    const error = errorOf(result);
    expect(error.details).toMatchObject({ id: "a", kind: "state-changed" });
    const kept = String(error.details?.kept);
    expect(error.message).toContain(kept);
    expect(await fs.readFile(kept, "utf8")).toBe("mine");
    expect(await s.read(".tasks/a/state.md")).toBe("theirs");
    await fs.rm(path.dirname(kept), { recursive: true, force: true });
  });

  it("refuses before opening the editor when the write would be refused", async () => {
    const s = await box({
      tasks: { w: { status: "IN_PROGRESS", claimed_session: "s2" } },
    });
    await s.write(".tasks/.locks/sessions/s2", "");
    const editor = await fakeEditor(s, { content: "x" });
    const result = await s.runWith(
      { env: { VISUAL: editor } },
      "state",
      "w",
      "--edit",
      "--session",
      "s1",
    );
    expect(result.code).toBe(4);
    expect(await s.exists("../seen.md")).toBe(false);
  });
});
