import { createFileRoute } from "@tanstack/react-router";
import { source } from "@/lib/source";
import { siteUrl } from "@/lib/shared";

/**
 * Every canonical URL on the site: the landing page plus one entry per docs
 * page. The `.md` variants are deliberately absent — they are the same content
 * under a second URL, which is exactly what a sitemap should not advertise.
 */
function render() {
  const urls = ["/", ...source.getPages().map((page) => page.url)];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${siteUrl}${url}</loc></url>`).join("\n")}
</urlset>
`;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET() {
        return new Response(render(), {
          headers: { "content-type": "application/xml; charset=utf-8" },
        });
      },
    },
  },
});
