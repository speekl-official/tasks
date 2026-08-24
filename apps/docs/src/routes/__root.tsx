import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import * as React from "react";
import appCss from "@/styles/app.css?url";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import SearchDialog from "@/components/search";
import { ogImageUrl, packageName, siteUrl, tagline } from "@/lib/shared";
import { author, authorHandle } from "@/lib/author";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: `${packageName} — ${tagline}`,
      },
      {
        name: "description",
        content:
          "A local, git-versioned task manager for AI coding agents. Tasks live in .tasks/ as markdown with YAML frontmatter. No server, no account, no network.",
      },
      { name: "author", content: author.name },
      { name: "twitter:creator", content: authorHandle },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:site_name", content: packageName },
      { property: "og:type", content: "website" },
      { property: "og:url", content: siteUrl },
      { property: "og:title", content: `${packageName} — ${tagline}` },
      // The landing page's card, and the fallback for anything without one.
      { property: "og:image", content: `${siteUrl}${ogImageUrl()}` },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider search={{ SearchDialog }}>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
