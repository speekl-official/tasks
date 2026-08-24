import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  plugins: [
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        // The shell is rendered from `maskPath`, which defaults to "/" — and
        // that render wins, leaving the landing page with no index.html of its
        // own. `src/routes/spa-shell.tsx` exists to take its place.
        maskPath: "/spa-shell",
        prerender: {
          enabled: true,
          crawlLinks: true,
          // Emit the shell as `404.html` — the filename static hosts serve for
          // an unknown path, with a 404 status. As a catch-all rewrite it hid
          // every prerendered page behind an empty shell instead.
          outputPath: "/404",
        },
      },

      // Social cards are not listed here on purpose: `/og/*.png` is rendered
      // by the server on request, not written to the build output.
      pages: [
        // The landing page has to be prerendered like the rest: served from the
        // SPA shell it reaches a crawler as an empty <div>.
        {
          path: "/",
        },
        {
          path: "/docs",
        },
        {
          path: "/api/search",
        },
        {
          path: "/robots.txt",
        },
        {
          path: "/sitemap.xml",
        },
        {
          path: "llms-full.txt",
        },
        {
          path: "llms.txt",
        },
      ],
    }),
    react(),
    // please see https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nitro for guides on hosting
    nitro({
      // Satori embeds an emscripten build of harfbuzz that reads `__dirname`
      // to find its wasm. Bundled into an ESM chunk there is no `__dirname`,
      // so it throws on the first card; left external it loads from
      // node_modules as published, the way it does under vite dev.
      rollupConfig: {
        external: [/^satori$/, /^@resvg\/resvg-js$/],
      },
    }),
  ],
  // `src/lib/og.tsx` is server-only, but the client's dependency scanner still
  // walks the route module that imports it and tries to prebundle what it
  // finds. resvg is a native addon — the optimizer cannot parse the `.node`
  // binary its loader reads, and the failure takes down `vite dev`.
  optimizeDeps: {
    exclude: ["@resvg/resvg-js", "satori"],
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      tslib: "tslib/tslib.es6.js",
    },
  },
});
