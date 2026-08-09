/** The class icons that ship with the application.
 *
 *  Baked in rather than read from a folder: a picker that is empty because a
 *  directory moved is worse than a picker that needs a release to gain a class,
 *  and the whole set is 800 KB of text inside an 11 MB binary.
 *
 *  `?raw` with `eager` so Vite inlines the markup at build time — no fetch, no
 *  asset path to get wrong once the frontend is bundled into the exe. */
const files = import.meta.glob("../../class-icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** "…/Class Icon Dark Knight.svg" → "Dark Knight". The prefix says what the
 *  folder already said; the class is the part anyone is looking for. */
const nameOf = (path: string) =>
  (path.split("/").pop() ?? "")
    .replace(/\.svg$/i, "")
    .replace(/^Class Icon /i, "")
    .trim();

const markup: Record<string, string> = {};
for (const [path, text] of Object.entries(files)) markup[nameOf(path)] = text;

/** The mark for "not decided yet". A layer has to name some class to exist, and
 *  on a wall the class is the tile's business, not the Layout's — so the layer
 *  is made with this one and each portrait says what it really is. Drawn here
 *  rather than taken from the game, since no class owns it. */
export const PLACEHOLDER_ICON = "Placeholder";

/** Every class, in the order the picker shows them: the placeholder first,
 *  because it is where a per-tile icon starts, then the classes by name. */
export const ICON_NAMES = Object.keys(markup).sort((a, b) =>
  a === PLACEHOLDER_ICON ? -1 : b === PLACEHOLDER_ICON ? 1 : a.localeCompare(b),
);

/** One filled outline of an icon. `opacity` carries the shading the artwork
 *  does with fill-opacity — several icons are drawn as a bright silhouette with
 *  fainter pieces on top, and a flat cut-out of them loses the modelling. */
export type IconPath = { d: string; opacity: number };
export type IconArt = { paths: IconPath[]; w: number; h: number };

const parsed = new Map<string, IconArt | null>();

/** An icon as plain path data, parsed once and kept.
 *
 *  These files are a flat list of `<path>` inside plain `<g>` wrappers with no
 *  transforms — checked across the whole set — so the geometry needs nothing
 *  but the `d` and the box it was drawn in. Anything else in a future file is
 *  ignored rather than half-drawn, and `null` marks a name that yielded no
 *  paths at all so it is not parsed again on every render. */
export function iconArt(name: string): IconArt | null {
  const seen = parsed.get(name);
  if (seen !== undefined) return seen;

  const text = markup[name];
  let art: IconArt | null = null;
  if (text) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.querySelector("svg");
    const paths = [...doc.querySelectorAll("path")]
      .map((p) => ({
        d: p.getAttribute("d") ?? "",
        opacity: Number(p.getAttribute("fill-opacity") ?? 1),
      }))
      .filter((p) => p.d);
    if (svg && paths.length) {
      /* One icon in the set is drawn at 2048 with a viewBox and the rest at
       * 1024 without one, so both have to be read — otherwise that one lands at
       * half the size of every other class. */
      const view = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
      const w = view?.length === 4 ? view[2] : parseFloat(svg.getAttribute("width") ?? "0");
      const h = view?.length === 4 ? view[3] : parseFloat(svg.getAttribute("height") ?? "0");
      if (w > 0 && h > 0) art = { paths, w, h };
    }
  }
  parsed.set(name, art);
  return art;
}
