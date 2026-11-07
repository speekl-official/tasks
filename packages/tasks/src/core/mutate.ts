import type { CommandContext } from "../context.js";
import type { LockPayload } from "./lock.js";
import { holderText, isLockBusy, withTreeLock } from "./lock.js";
import type { LoadedTree } from "./projects.js";
import { refreshIndexFor, snapshotFromContext } from "./snapshot.js";
import { nowIso } from "./time.js";
import type { Tree } from "./tree.js";

/** What a mutation sees inside the lock: the tree as it is right now. */
export interface Fresh {
  load: LoadedTree;
  tree: Tree;
  /** One timestamp for everything the mutation stamps and logs. */
  now: string;
}

export interface MutationOptions {
  /** Regenerate `index.md` afterwards when it exists; on by default. */
  refreshIndex?: boolean;
}

/**
 * Run a write against one tree. The tree's lock is taken, the tree is
 * re-read inside it before `fn` decides anything (whatever the command read
 * earlier may be stale), and after the write the tree is re-read again so
 * every later lookup sees the result and `index.md` follows it. A command
 * that writes several trees calls this once per tree: there are no
 * cross-tree transactions.
 */
export async function withMutation<T>(
  context: CommandContext,
  load: LoadedTree,
  fn: (fresh: Fresh) => Promise<T>,
  options: MutationOptions = {},
): Promise<T> {
  const result = await withTreeLock(load.project.tasksDir, async () => {
    const before = await context.projects.reload(load);
    context.gates.invalidate();

    const value = await fn({ load: before, tree: before.tree, now: nowIso() });

    const after = await context.projects.reload(before);
    context.gates.invalidate();
    if (options.refreshIndex !== false) {
      await refreshIndexFor(snapshotFromContext(context), after);
    }
    return value;
  });

  // A write into a listed tree can change what the local overview says
  // (`blocked by backend:x` comes and goes with that task), so the local
  // index follows it too, under its own lock, once the foreign one is free.
  if (options.refreshIndex !== false && !load.local) {
    await refreshLocalIndex(context, load);
  }
  return result;
}

/**
 * The write is done by now, so a local lock that stays busy fails nothing:
 * it only leaves `index.md` behind, which `validate` reports and the next
 * local write or `reindex` regenerates. Anything else is still an error.
 */
async function refreshLocalIndex(
  context: CommandContext,
  written: LoadedTree,
): Promise<void> {
  const local = context.projects.local;
  try {
    await withTreeLock(local.project.tasksDir, async () => {
      await context.projects.reload(local);
      context.gates.invalidate();
      await refreshIndexFor(
        snapshotFromContext(context),
        context.projects.local,
      );
    });
  } catch (err) {
    if (!isLockBusy(err)) throw err;
    const holder = holderText(
      (err.details?.holder as LockPayload | null | undefined) ?? null,
    );
    context.diagnose(
      `${context.projects.qualifier(written) ?? written.project.root} was written, but this tree's index.md was not refreshed: the tree is locked${holder}. Run \`tasks reindex\` once it is free.`,
    );
  }
}
