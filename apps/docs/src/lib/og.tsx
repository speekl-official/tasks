import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { appName, siteUrl } from "./shared";

/**
 * Social cards, rendered from the same palette as the site: satori lays the
 * card out as SVG, resvg rasterizes it. Server-only — both are native/heavy and
 * must never reach the client bundle.
 *
 * Every card is prerendered to a file (see the `/og` entries in
 * vite.config.ts), so this runs at build time, not per request.
 */

/** Dark-theme tokens from `styles/app.css`, resolved to hex. */
const BG = "#191615";
const FG = "#EDEAE6";
const MUTED = "#A69E96";
const AMBER = "#F6AE31";
const BORDER = "#322E2B";

const WIDTH = 1200;
const HEIGHT = 630;

const require = createRequire(import.meta.url);

/** Fonts are read once per build, not once per card. */
let fontsPromise: Promise<Font[]> | undefined;

type Font = {
  name: string;
  data: Buffer;
  weight: 400 | 600 | 700;
  style: "normal";
};

function loadFonts(): Promise<Font[]> {
  // satori reads font bytes directly, and supports woff but not woff2.
  const files = [
    ["Inter", "@fontsource/inter/files/inter-latin-400-normal.woff", 400],
    ["Inter", "@fontsource/inter/files/inter-latin-600-normal.woff", 600],
    [
      "JetBrains Mono",
      "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff",
      700,
    ],
  ] as const;

  fontsPromise ??= Promise.all(
    files.map(async ([name, spec, weight]) => ({
      name,
      data: await readFile(require.resolve(spec)),
      weight,
      style: "normal" as const,
    })),
  );

  return fontsPromise;
}

export type OgCard = {
  title: string;
  description?: string;
  /** The section a docs page belongs to — "Spec", "Guide", "Reference". */
  kind?: string;
};

function Card({ title, description, kind }: OgCard) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: 72,
        backgroundColor: BG,
        fontFamily: "Inter",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: HEIGHT,
          display: "flex",
          backgroundImage:
            "linear-gradient(200deg, rgba(246,174,49,0.16) 0%, rgba(25,22,21,0) 45%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 14,
          display: "flex",
          backgroundColor: AMBER,
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: "JetBrains Mono",
            fontSize: 34,
          }}
        >
          <span style={{ color: AMBER, marginRight: 12 }}>$</span>
          <span style={{ color: FG, fontWeight: 700 }}>{appName}</span>
        </div>
        {kind ? (
          <div
            style={{
              display: "flex",
              padding: "10px 24px",
              border: `1px solid ${BORDER}`,
              borderRadius: 999,
              color: MUTED,
              fontSize: 24,
              letterSpacing: 3,
              textTransform: "uppercase",
            }}
          >
            {kind}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            color: FG,
            fontSize: 76,
            fontWeight: 600,
            letterSpacing: -2,
            lineHeight: 1.15,
          }}
        >
          {title}
        </div>
        {description ? (
          <div
            style={{
              display: "flex",
              marginTop: 28,
              color: MUTED,
              fontSize: 32,
              lineHeight: 1.45,
            }}
          >
            {description}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          fontFamily: "JetBrains Mono",
          fontSize: 26,
          color: MUTED,
        }}
      >
        {siteUrl.replace("https://", "")}
      </div>
    </div>
  );
}

/** A long description makes satori shrink the card's other rows; clamp it. */
function clamp(text: string | undefined, max: number) {
  if (!text) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export async function renderOgImage(card: OgCard): Promise<ArrayBuffer> {
  const svg = await satori(
    <Card
      title={clamp(card.title, 70) ?? ""}
      description={clamp(card.description, 150)}
      kind={card.kind}
    />,
    { width: WIDTH, height: HEIGHT, fonts: await loadFonts() },
  );

  const png = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } })
    .render()
    .asPng();

  // resvg hands back a Buffer, whose `ArrayBufferLike` backing does not satisfy
  // `BodyInit`; copying into a plain Uint8Array gives a `Response` body.
  return new Uint8Array(png).buffer;
}
