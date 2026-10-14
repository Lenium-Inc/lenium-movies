/**
 * The one genre → colour map.
 *
 * Every place a genre is named -- the hero's chips, the filter bar's dots, the
 * details sheet's line -- reads from here, so a genre can never be one colour in
 * the chips and another in the filter row. Keys are normalised to lower case
 * because TMDB is inconsistent about "Sci-Fi" and "Sci-Fi"/"Science Fiction",
 * and a lookup that missed by punctuation would silently fall back to neutral.
 */
const GENRE_COLORS: Record<string, string> = {
  action: "#ff6b4a",
  adventure: "#f2a15a",
  comedy: "#ffd24a",
  crime: "#6fa0ff",
  drama: "#f07aa0",
  fantasy: "#7dd3a8",
  mystery: "#5ec8e5",
  romance: "#ff8fb1",
  "sci-fi": "#4fd1c5",
  scifi: "#4fd1c5",
  "science fiction": "#4fd1c5",
  thriller: "#b39bff",
  family: "#9be15d",
};

/** The genre's colour, or null when it is not one of the mapped families. */
export function genreColor(name: string | null | undefined): string | null {
  if (!name) return null;
  return GENRE_COLORS[name.trim().toLowerCase()] ?? null;
}

/** `#rrggbb` -> `rgba(r, g, b, alpha)`. Non-hex input is returned untouched. */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
