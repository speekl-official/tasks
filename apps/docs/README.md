# docs

The documentation site for [`@speekl/tasks`](../../packages/tasks). Built with
[Fumadocs](https://fumadocs.dev) on [TanStack Start](https://tanstack.com/start), and
prerendered to static files.

```sh
pnpm dev            # http://localhost:3000
pnpm build          # prerender to .output/public
pnpm start          # serve the built output
pnpm check-types    # tsc --noEmit
pnpm lint           # oxlint
```

From the repo root, `turbo` fans these out with everything else.

## Docker

`Dockerfile` builds the site and runs its Nitro server. The build context is the repo
root — pnpm installs from the lockfile, which lives there:

```sh
docker build -f apps/docs/Dockerfile -t agenttasks-docs .
docker run --rm -p 3000:3000 agenttasks-docs
```

Unlike `pnpm start`, which serves only the prerendered `.output/public`, the image runs
`.output/server/index.mjs`, so `/og/*.png` — rendered per request rather than written to
the build output — works too. `PORT` (default 3000) and `HOST` are read at startup.

## Layout

```
content/docs/         MDX pages; meta.json controls sidebar order
  spec/               NORMATIVE — the .tasks convention v1
  guides/             explanatory
  reference/          the @speekl/tasks CLI
src/routes/index.tsx  the landing page
src/lib/shared.ts     site name, repo links, docs route
src/styles/app.css    theme tokens — amber accent on a warm neutral base
src/components/
  home/               landing-page-only components (terminal, install command)
  mdx.tsx             MDX components available to every page
```

## Writing a page

Add an `.mdx` file under `content/docs/` with `title`, `description`, and an optional
[lucide](https://lucide.dev) `icon` in frontmatter, then list its slug in the containing
`meta.json`. `Cards`, `Callout`, `Steps`, `Tabs`, `Files`, `Accordions`, and `TypeTable`
are registered globally in `src/components/mdx.tsx` — no per-page imports.

## Spec vs. reference

`content/docs/spec/` is **normative**: it defines the `.tasks` convention independently
of any implementation, using RFC 2119 keywords. `content/docs/reference/` describes the
`@speekl/tasks` CLI, and every page there carries a callout pointing at its normative
counterpart.

When the two disagree, that is a bug. A change to `.tasks/` conventions, JSON shapes, or
exit codes belongs in `spec/` first, and the reference page follows.

The docs describe real behavior, so treat `packages/tasks/src/` as the source of truth
for what the reference implementation actually does — see the root `CLAUDE.md` for the
definition of done on a user-facing change.
