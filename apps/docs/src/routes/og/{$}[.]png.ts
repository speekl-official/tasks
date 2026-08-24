import { createFileRoute } from "@tanstack/react-router";
import { source } from "@/lib/source";
import { decodeOgUrl, standardName } from "@/lib/shared";
import { renderOgImage, type OgCard } from "@/lib/og";

/** The section badge on a card, from the first slug of the page. */
const KINDS: Record<string, string> = {
  spec: "Spec",
  guides: "Guide",
  reference: "Reference",
};

const HOME_CARD: OgCard = {
  title: "A task format for AI agents",
  description: `${standardName} is an open format for tracking work that outlives a single session. No server, no account, no network.`,
};

function card(splat: string): OgCard | null {
  const slugs = decodeOgUrl(splat);
  if (!slugs) return HOME_CARD;

  const page = source.getPage(slugs);
  if (!page) return null;

  return {
    title: page.data.title,
    description: page.data.description,
    kind: slugs.length > 1 ? KINDS[slugs[0]] : undefined,
  };
}

export const Route = createFileRoute("/og/{$}.png")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const found = card(params._splat ?? "");
        // A router `notFound()` would answer an <img> request with a 200 and a
        // JSON body; a scraper needs the status.
        if (!found) return new Response("Not found", { status: 404 });

        return new Response(await renderOgImage(found), {
          headers: {
            "Content-Type": "image/png",
            // Prerendered to a file; the header only matters if a host ever
            // serves this route live.
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      },
    },
  },
});
