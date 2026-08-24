# syntax=docker/dockerfile:1

# The docs site, built and served by its own Nitro node-server.
#
# Build context is the REPO ROOT, not this directory — pnpm needs the lockfile
# and every workspace manifest to install with `--frozen-lockfile`:
#
#   docker build -f apps/docs/Dockerfile -t agenttasks-docs .
#   docker run --rm -p 3000:3000 agenttasks-docs
#
# `pnpm start` serves only the prerendered `.output/public`; this image runs the
# server entry instead, so `/og/*.png` (rendered per request, never written to
# the build output) works too.

# Matches the version CI builds on. The floor is the root `engines.node`.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Manifests only, so an edit to the docs content does not invalidate the
# install layer. `packages/tasks` is here because a frozen install reads every
# workspace manifest, even a filtered one.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/docs/package.json apps/docs/
COPY packages/tasks/package.json packages/tasks/

FROM manifests AS deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter docs...

FROM deps AS build
# Prerendering drives a Vite preview server over `http://localhost:3000`. In a
# container `localhost` resolves to ::1 first, so the server binds IPv6 while
# `fetch` connects to 127.0.0.1 — every page fails with ECONNREFUSED and the
# build still exits 0, leaving an empty `.output/public`. Pinning IPv4 makes
# the two agree.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
COPY apps/docs apps/docs
RUN pnpm --filter docs build

# The server bundle leaves `satori` and `@resvg/resvg-js` external (see the
# `rollupConfig` note in vite.config.ts), so the runtime needs a real
# node_modules — production deps of `docs` alone, resolved from the lockfile.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter docs --prod

# Built from `prod-deps` on purpose: pnpm's node_modules is a tree of relative
# symlinks into the virtual store at /repo/node_modules/.pnpm, and keeping the
# layout in place is what makes those resolve.
FROM prod-deps AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
COPY --from=build /repo/apps/docs/.output apps/docs/.output
WORKDIR /repo/apps/docs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch(\`http://127.0.0.1:\${process.env.PORT}/\`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
