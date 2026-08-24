/**
 * The person behind the project. Data only — the icons and copy that go with
 * each link live in `components/author.tsx`, so metadata (which is plain
 * strings) and the rendered card cannot drift apart.
 */
export const author = {
  name: "Dan Zabrotski",
  site: "https://danzabrotski.com/",
  github: "https://github.com/dan-speekl",
  x: "https://x.com/dantechceo",
  linkedin: "https://www.linkedin.com/in/dantechceo/",
  /** Served from `public/`, so the path is the URL. */
  photo: "/dan.png",
} as const;

/** The handle as it is written, not as it is linked. */
export const authorHandle = "@dantechceo";
