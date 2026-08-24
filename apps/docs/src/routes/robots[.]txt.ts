import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/shared";

/**
 * Everything is public, so the only rule is the sitemap pointer. `/api/` is
 * excluded because the search index is a build artifact, not a page.
 */
const body = `User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${siteUrl}/sitemap.xml
`;

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET() {
        return new Response(body, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    },
  },
});
