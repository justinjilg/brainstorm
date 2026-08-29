/**
 * The places registry — the flagship's whole navigable surface, replacing the
 * former 5×5 entity×verb grid (deleted). Four places, one calm home.
 *
 * Per the owner's direction (concept A's organism architecture, concept C's
 * restraint): **Talk is the calm default canvas; Pulse is an openable feed
 * (a slide-over), not a central dashboard.** So Pulse's `presentation` is
 * `"drawer"` — it overlays whatever canvas place is active (via the rail-heart
 * or ⌘0) instead of being a place you leave your work to visit. Council and
 * Growth are canvas places.
 *
 * The guardrail against re-cluttering (Phase 4 CI): `PLACES.length === 4`. New
 * capability attaches inside a place or the Settings drawer — never a 5th place.
 */

export type PlaceId = "talk" | "pulse" | "council" | "growth";
export type PlacePresentation = "canvas" | "drawer";

export interface PlaceDef {
  id: PlaceId;
  label: string;
  /** Rail glyph — a quiet monospace mark, not an icon set. */
  glyph: string;
  presentation: PlacePresentation;
  /** ⌘<hotkey> — canvas places 1..3; Pulse the drawer is ⌘0. */
  hotkey: string;
  /** One-line purpose, shown as the rail tooltip. */
  blurb: string;
}

export const PLACES: readonly PlaceDef[] = [
  {
    id: "talk",
    label: "Talk",
    glyph: "▣",
    presentation: "canvas",
    hotkey: "1",
    blurb: "Your work — chat, threads, projects.",
  },
  {
    id: "pulse",
    label: "Pulse",
    glyph: "◉",
    presentation: "drawer",
    hotkey: "0",
    blurb: "The organism, live — activity, vitals, the mesh.",
  },
  {
    id: "council",
    label: "Council",
    glyph: "⬡",
    presentation: "canvas",
    hotkey: "2",
    blurb: "Models talking to models — deliberations you can watch.",
  },
  {
    id: "growth",
    label: "Growth",
    glyph: "◇",
    presentation: "canvas",
    hotkey: "3",
    blurb: "What it has learned — memory, skills, self-heal history.",
  },
] as const;

/** The canvas places, in rail order (Pulse is a drawer, excluded). */
export const CANVAS_PLACES: readonly PlaceDef[] = PLACES.filter(
  (p) => p.presentation === "canvas",
);

/** The calm home — the app opens here, never on Pulse. */
export const DEFAULT_PLACE: PlaceId = "talk";

export function placeById(id: PlaceId): PlaceDef {
  const p = PLACES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown place: ${id}`);
  return p;
}
