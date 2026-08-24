export const appName = "tasks";
export const packageName = "@speekl/tasks";
export const tagline = "An open format for agent task state.";

/** Canonical origin the site is served from, for absolute URLs in metadata. */
export const siteUrl = "https://agenttasks.dev";

/** The standard, as distinct from the CLI that implements it. */
export const standardName = ".tasks";
export const specVersion = "v1";
export const docsRoute = "/docs";
export const ogRoute = "/og";

/**
 * The social card for a page, by the page's own URL. `/docs/quickstart` becomes
 * `/og/docs/quickstart.png`; the landing page has no slug of its own, so it
 * takes `home`.
 */
export function ogImageUrl(pageUrl = "/") {
  const slug = pageUrl === "/" ? "home" : pageUrl.replace(/^\//, "");
  return `${ogRoute}/${slug}.png`;
}

/** @returns page slugs, or `null` for the landing page's card */
export function decodeOgUrl(splat: string): string[] | null {
  if (splat === "home") return null;

  const segments = splat.split("/");
  if (segments[0] === docsRoute.slice(1)) segments.shift();
  return segments;
}

export const gitConfig = {
  user: "speekl-official",
  repo: "tasks",
  branch: "main",
};

/** Path from the repo root to the MDX sources, for "edit this page" links. */
export const docsContentDir = "apps/docs/content/docs";

export function encodeMarkdownUrl(slugs: string[], locale?: string) {
  const segments = [...slugs];
  if (segments.length === 0) {
    segments.push("index.md");
  } else {
    segments[segments.length - 1] += ".md";
  }

  return (
    "/" +
    [locale, ...docsRoute.split("/"), ...segments].filter(Boolean).join("/")
  );
}

/** @returns page slugs */
export function decodeMarkdownUrl(segments: string[]) {
  if (segments.length === 0) return [];

  const out = [...segments];
  out[out.length - 1] = out[out.length - 1].replace(/\.md$/, "");
  if (out.length === 1 && out[0] === "index") out.pop();
  return out;
}
