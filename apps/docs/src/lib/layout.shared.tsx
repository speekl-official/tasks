import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, gitConfig, packageName } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Wordmark />,
      transparentMode: "top",
    },
    links: [
      // `on: "nav"` keeps these in the home page header only. The docs sidebar
      // renders menu items above the page tree, where "Docs" and "Spec" would
      // just duplicate the tree sitting directly beneath them.
      //
      // `active: "none"` because /docs/spec is nested under /docs — any
      // url-based rule marks both as current at once.
      { text: "Docs", url: "/docs", active: "none", on: "nav" },
      { text: "Spec", url: "/docs/spec", active: "none", on: "nav" },
      {
        text: "npm",
        url: `https://www.npmjs.com/package/${packageName}`,
        external: true,
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}

/**
 * A shell prompt rather than a logo: the product is a command, so the mark is
 * the thing you actually type.
 */
function Wordmark() {
  return (
    <span className="inline-flex items-baseline gap-1.5 font-mono text-[15px] tracking-tight">
      <span className="text-fd-primary select-none" aria-hidden>
        $
      </span>
      <span className="font-semibold text-fd-foreground">{appName}</span>
    </span>
  );
}
