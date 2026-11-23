/**
 * The people behind the project. Data only — the icons and copy that go with
 * each link live in `components/author.tsx`, so metadata (which is plain
 * strings) and the rendered cards cannot drift apart. `author` is the site's
 * author in its metadata; `coauthor` designed the v2 revision and wrote the
 * CLI, and has no site and no GitHub link by choice.
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

export const coauthor = {
  name: "Kirill Omelyanov",
  x: "https://x.com/java_nomad",
  linkedin: "https://www.linkedin.com/in/kirill-omelyanov/",
  photo: "/kirill.jpg",
} as const;

export const coauthorHandle = "@java_nomad";
