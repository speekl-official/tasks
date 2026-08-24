# Changesets

This folder holds [changesets](https://github.com/changesets/changesets): one
markdown file per user-facing change, recording which package changed, how the
version should bump, and the line that belongs in the changelog.

Add one with `pnpm changeset` in the same PR as the change itself. The release
process consumes them — see the contributing notes in the root `README.md`.
