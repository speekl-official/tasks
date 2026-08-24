import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "@/components/not-found";
import { standardName } from "@/lib/shared";

/**
 * Nothing links here. The build renders the SPA fallback shell from this path
 * (`spa.maskPath` in vite.config.ts) and writes it to `_shell.html`, which the
 * static host serves for URLs that have no prerendered page.
 *
 * It needs its own route because whichever path the shell renders from loses
 * its own HTML file — with the default of "/", the landing page reached
 * crawlers as an empty shell — and because a path with no route 404s during
 * prerender, which leaves no shell at all.
 */
export const Route = createFileRoute("/spa-shell")({
  component: NotFound,
  // What a crawler sees on a dead URL. The 404 status does the real work; the
  // `noindex` covers hosts that serve their error page with a 200.
  head: () => ({
    meta: [
      { title: `Page not found — ${standardName}` },
      { name: "robots", content: "noindex" },
    ],
  }),
});
