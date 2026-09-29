/**
 * Avatar preset library.
 *
 * Presets are DiceBear styles rather than bundled bitmaps. A curated set of
 * raster or hand-drawn SVGs would have to be drawn, licensed, and versioned
 * alongside the app, and would still not cover skin tone or presentation
 * breadth. DiceBear's `lorelei`/`micah`/`notionists` families already do that
 * work, ship as vector so they stay crisp at 32px and 512px alike, and are
 * addressable from a stable URL -- which means a preset is just a string we
 * persist, not an asset we deploy.
 *
 * Why the URL is stored rather than an id: `ProfileData.avatar` predates this
 * module, is a required `string`, and is consumed as `<img src>` in five places.
 * Storing the resolved URL keeps every one of those call sites working
 * untouched. The id is stored *alongside* it, because a picker needs to show
 * which preset is currently selected and a "restore the default" needs to be
 * able to recognise one.
 *
 * Pure module, no React: the test environment is `node` and the test glob only
 * matches `.ts`, so anything worth asserting on has to live here.
 */

export type AvatarCategory = "female" | "male" | "neutral";

export interface AvatarPreset {
  /** Stable identifier, persisted so a selection can be re-highlighted. */
  id: string;
  /** Human label. Not decorative: it is the accessible name of the tile. */
  label: string;
  category: AvatarCategory;
  /** Fully resolved image URL, safe to hand to `<img src>`. */
  url: string;
}

export const CATEGORY_LABELS: Record<AvatarCategory, string> = {
  female: "Female",
  male: "Male",
  neutral: "Neutral & abstract",
};

/**
 * Category order. Deliberately not alphabetical: a picker reads left to right,
 * and people look first for a face they recognise.
 */
export const CATEGORY_ORDER: readonly AvatarCategory[] = [
  "neutral",
  "female",
  "male",
];

/**
 * DiceBear styles per category.
 *
 * The `-neutral` variants exist upstream and are used for the neutral column
 * where a style would otherwise default to presenting as male. `identicon` and
 * `shapes` are the abstract end of the range: no face at all, for viewers who
 * would rather not be depicted.
 */
const CATEGORY_STYLES: Record<AvatarCategory, readonly string[]> = {
  female: ["lorelei", "michelle", "adventurer", "personas"],
  male: ["micah", "avataaars", "big-ears", "miniavs"],
  neutral: [
    "notionists",
    "notionists-neutral",
    "adventurer-neutral",
    "bottts",
    "shapes",
    "thumbs",
    "pixel-art",
    "identicon",
  ],
};

/**
 * Backgrounds behind the artwork.
 *
 * Without one DiceBear's SVGs are transparent, and a transparent avatar inside
 * a white-ish circular fallback flashes badly on the dark chrome. These are
 * desaturated enough to sit behind the artwork without competing with it, and
 * every one is a step or two away from its neighbours so adjacent tiles in the
 * grid stay distinguishable at a glance.
 */
const BACKGROUNDS: readonly string[] = [
  "b6e3f4",
  "c0aede",
  "ffd5dc",
  "ffdfbf",
  "d1f4d9",
  "c1f4f5",
  "e2e2e2",
  "f4f4f4",
];

/** Two presets per style keeps the grid to eight tiles per category. */
const PRESETS_PER_STYLE = 2;

/**
 * Build a DiceBear URL.
 *
 * The `seed` is what makes a given style deterministic, so it is derived from
 * the preset id rather than random: regenerating this module must not change
 * which face a saved profile shows.
 */
export function dicebearUrl(
  style: string,
  seed: string,
  backgroundColor?: string,
): string {
  const params = new URLSearchParams({ seed, scale: "80" });
  if (backgroundColor) params.set("backgroundColor", backgroundColor);
  return `https://api.dicebear.com/7.x/${encodeURIComponent(style)}/svg?${params.toString()}`;
}

/**
 * Flatten the style list into presets.
 *
 * Built at module load and frozen: the picker maps over it on every render, and
 * a stable array identity means it cannot be mutated by a consumer into a
 * subtly different library partway through a session.
 */
export const AVATAR_PRESETS: readonly AvatarPreset[] = Object.freeze(
  CATEGORY_ORDER.flatMap((category) => {
    const styles = CATEGORY_STYLES[category];
    return styles.flatMap((style, styleIndex) =>
      Array.from({ length: PRESETS_PER_STYLE }, (_, variant) => {
        const id = `${category}-${style}-${variant}`;
        return Object.freeze({
          id,
          label: `${CATEGORY_LABELS[category]} ${styleIndex * PRESETS_PER_STYLE + variant + 1}`,
          category,
          url: dicebearUrl(
            style,
            id,
            BACKGROUNDS[(styleIndex * PRESETS_PER_STYLE + variant) % BACKGROUNDS.length],
          ),
        });
      }),
    );
  }),
);

const PRESETS_BY_ID = new Map(AVATAR_PRESETS.map((p) => [p.id, p]));

/** Presets belonging to one category, in library order. */
export function presetsForCategory(category: AvatarCategory): AvatarPreset[] {
  return AVATAR_PRESETS.filter((preset) => preset.category === category);
}

/** Look up a preset by id, or `null` for an unknown or cleared id. */
export function presetById(id: string | null | undefined): AvatarPreset | null {
  if (!id) return null;
  return PRESETS_BY_ID.get(id) ?? null;
}

/**
 * Styles used for a profile that never chose a preset.
 *
 * Kids profiles get their own set. This is a real change, not a tidy-up: the
 * previous generator hard-coded `avataaars` for everyone, so a kids profile was
 * depicted as a cartoon adult.
 */
const DEFAULT_STYLE: Record<"adult" | "kids", string> = {
  adult: "notionists",
  kids: "big-smile",
};

const DEFAULT_PRESET_ID: Record<"adult" | "kids", string> = {
  adult: "neutral-notionists-0",
  kids: "neutral-big-smile-1",
};

/**
 * Deterministic avatar for a profile that has no preset.
 *
 * Seeded from the name so the same person keeps the same face across devices
 * without any server round-trip, and rehashing an unrecognised or renamed
 * profile is a visible bug rather than a silent identity swap.
 */
export function defaultAvatarUrl(
  name: string,
  isKids = false,
): string {
  const trimmed = name.trim();
  // An empty name still needs a stable seed; an all-whitespace name otherwise
  // collapses to one shared face for every such profile.
  const seed = trimmed || "profile";
  const bucket = isKids ? "kids" : "adult";
  return dicebearUrl(DEFAULT_STYLE[bucket], seed, BACKGROUNDS[
    hashName(seed) % BACKGROUNDS.length
  ]);
}

/**
 * The preset id matching `defaultAvatarUrl`, for the case where a profile is
 * reset back to its generated avatar.
 */
export function defaultAvatarId(isKids = false): string {
  return isKids ? DEFAULT_PRESET_ID.kids : DEFAULT_PRESET_ID.adult;
}

/**
 * The avatar to render for a profile-like record.
 *
 * Prefers an explicitly chosen preset so a later library change cannot alter a
 * profile that was picked on purpose, and falls back to the generated URL when
 * the stored value is missing or unusable. The last case matters: `avatar` is a
 * required field in the type but nothing validates what is actually in storage,
 * and a profile written by an older build can be missing it entirely.
 */
export function resolveAvatarUrl(input: {
  avatarId?: string | null;
  avatar?: string | null;
  name?: string | null;
  isKids?: boolean;
}): string {
  const preset = presetById(input.avatarId);
  if (preset) return preset.url;
  if (typeof input.avatar === "string" && input.avatar.trim()) {
    return input.avatar;
  }
  return defaultAvatarUrl(input.name ?? "", input.isKids ?? false);
}

/**
 * Small, stable string hash for background selection.
 *
 * `glow.ts` has a private one of these already, but that module is about genre
 * palettes; reaching across feature boundaries for a one-line hash would couple
 * avatar backgrounds to hero lighting for no benefit.
 */
export function hashName(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
