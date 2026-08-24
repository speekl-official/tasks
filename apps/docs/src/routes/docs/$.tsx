import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { createServerFn } from "@tanstack/react-start";
import { docs, source } from "@/lib/source";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { baseOptions } from "@/lib/layout.shared";
import {
  docsContentDir,
  encodeMarkdownUrl,
  gitConfig,
  ogImageUrl,
  siteUrl,
  standardName,
} from "@/lib/shared";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { Suspense, use } from "react";
import { useMDXComponents } from "@/components/mdx";

export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/") ?? [];
    const data = await loader({ data: slugs });
    await docs.getPage(data.path)?.preload();
    return data;
  },
  // Without this every docs page inherits the root title and description, so
  // all of them look like the same document to a crawler. The frontmatter is
  // already the right copy for both.
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { title, description, url } = loaderData;
    const canonical = `${siteUrl}${url}`;
    const fullTitle = `${title} — ${standardName}`;

    return {
      meta: [
        { title: fullTitle },
        { name: "description", content: description },
        { property: "og:type", content: "article" },
        { property: "og:title", content: fullTitle },
        { property: "og:description", content: description },
        { property: "og:url", content: canonical },
        { property: "og:image", content: `${siteUrl}${ogImageUrl(url)}` },
      ],
      links: [{ rel: "canonical", href: canonical }],
    };
  },
});

// No `staticFunctionMiddleware` here on purpose. It answers this loader from a
// prebuilt `/__tsr/staticServerFnCache/*.json`, which only a static host can
// serve: nitro's node server resolves public assets from a manifest baked
// before prerendering writes those files, so it 404s them and the client parses
// the HTML shell as JSON. The site is served by that node server, so the
// function runs live instead.
const loader = createServerFn({
  method: "GET",
})
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      path: page.path,
      // Carried in the loader payload rather than read from the MDX module, so
      // `head` can run without waiting on the page body to load.
      title: page.data.title,
      description: page.data.description ?? "",
      url: page.url,
      markdownUrl: encodeMarkdownUrl(page.slugs, page.locale),
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  });

function Content({ path, markdownUrl }: { path: string; markdownUrl: string }) {
  const page = docs.getPage(path);
  if (!page) throw new Error(`unknown page: ${path}`);

  const { toc } = use(page.load());
  const MDX = page.body;

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b -mt-4 pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${docsContentDir}/${path}`}
        />
      </div>
      <DocsBody>
        <MDX components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

function Page() {
  const { pageTree, path, markdownUrl } = useFumadocsLoader(
    Route.useLoaderData(),
  );

  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      <Link to={markdownUrl} hidden />
      <Suspense>
        <Content path={path} markdownUrl={markdownUrl} />
      </Suspense>
    </DocsLayout>
  );
}
