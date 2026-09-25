/**
 * Ambient glow palette for the featured title.
 *
 * The hero's aura is derived from genre so it reads as intentional: a horror
 * title sits in cold violet, a western in warm amber, and the shift as the
 * spotlight rotates is legible rather than arbitrary. Genres TMDB returns that
 * aren't in the table fall back to a hash of the title, which keeps every title
 * visually distinct and stable across renders and reloads.
 */

/** Hue in degrees, keyed on the lowercase genre name. */
const GENRE_HUES: Record<string, number> = {
  action: 8,
  adventure: 28,
  animation: 48,
  comedy: 52,
  crime: 348,
  documentary: 196,
  drama: 264,
  family: 318,
  fantasy: 276,
  history: 30,
  horror: 286,
  music: 314,
  mystery: 248,
  romance: 336,
  "science fiction": 190,
  scifi: 190,
  thriller: 214,
  war: 24,
  western: 36,
};

/** Offset applied for the second blob so the pair never reads as one flat wash. */
const SECONDARY_HUE_OFFSET = 42;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function hueFor(genre: string): number | null {
  return GENRE_HUES[genre.trim().toLowerCase()] ?? null;
}

export interface GlowPalette {
  primary: string;
  secondary: string;
}

function hsl(hue: number, alpha: number): string {
  return `hsl(${hue} 82% 56% / ${alpha})`;
}

/**
 * Build the two aura colours for a title. The first known genre sets the hue;
 * the second blob is offset from it, or seeded from the title hash when the
 * genre is unknown, so the aura still varies per title.
 */
export function glowPalette(
  genres: readonly string[] | undefined,
  seed: string | number
): GlowPalette {
  const seedText = String(seed);
  const names = (genres ?? []).filter(
    (genre): genre is string => typeof genre === "string" && genre.trim() !== ""
  );

  const primaryHue = names.length > 0 ? hueFor(names[0]) : null;

  if (primaryHue === null) {
    // Unknown genre: spread the fallback across the wheel, skipping the muddy
    // 60-80deg band where yellow and green meet at high saturation.
    const base = hashString(seedText || "spotlight") % 320;
    const hue = base >= 60 && base < 90 ? base + 40 : base;
    return { primary: hsl(hue, 0.55), secondary: hsl(hue + SECONDARY_HUE_OFFSET, 0.45) };
  }

  const secondaryHue =
    names.length > 1 ? (hueFor(names[1]) ?? primaryHue + SECONDARY_HUE_OFFSET) : primaryHue + SECONDARY_HUE_OFFSET;

  return { primary: hsl(primaryHue, 0.55), secondary: hsl(secondaryHue, 0.45) };
}

/**
 * The two-stop radial aura used behind the featured card. Kept here so the
 * gradient shape is described once and the colours are the only variable.
 */
export function glowBackground({ primary, secondary }: GlowPalette): string {
  return (
    `radial-gradient(circle at 30% 30%, ${primary}, transparent 70%), ` +
    `radial-gradient(circle at 70% 60%, ${secondary}, transparent 70%)`
  );
}
