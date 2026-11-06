import { useEffect, useState } from "react";
import { MOVIE_API_BASE_URL } from "@/services/api";
import { tmdbImage } from "@/lib/tmdbImages";

/** Emitted when nothing can be sampled -- a missing backdrop, a tainted canvas,
 *  or a frame with no saturated colour in it. */
export const FALLBACK_ACCENT = "#c23b2e";

/**
 * Accents are per-backdrop and never change, so a viewer who has seen a hero
 * once should never pay to sample it again. The memo is deliberately both in
 * memory (instant within a session) and in localStorage (across visits), and
 * bounded so a catalogue that rotates through thousands of backdrops cannot
 * grow an unbounded record in a viewer's storage.
 */
const ACCENT_CACHE_KEY = "freestream-accents-v1";
const ACCENT_CACHE_MAX = 120;
const accentMemo = new Map<string, string>();

function readAccentCache(): void {
  if (typeof window === "undefined" || accentMemo.size > 0) return;
  try {
    const raw = window.localStorage.getItem(ACCENT_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
        accentMemo.set(key, value);
      }
    }
  } catch {
    // A corrupt or unavailable cache is simply an empty one.
  }
}

function writeAccentCache(): void {
  if (typeof window === "undefined") return;
  try {
    const entries = Array.from(accentMemo.entries()).slice(-ACCENT_CACHE_MAX);
    window.localStorage.setItem(
      ACCENT_CACHE_KEY,
      JSON.stringify(Object.fromEntries(entries))
    );
  } catch {
    // Storage full or disabled: the in-memory memo still works for this visit.
  }
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Average the frame's saturated pixels into one colour, then clamp it into the
 * band the accent is allowed to occupy: lightness 45-65% and saturation at least
 * 50%. The clamp is what stops a near-black backdrop turning the accent into an
 * invisible smudge or a near-white one turning it into a highlighter -- the
 * sampled hue survives, the extremes do not.
 */
function sampleAccent(image: HTMLImageElement): string | null {
  const canvas = document.createElement("canvas");
  // 64x36, not a thumbnail: at 32x18 a moody backdrop can leave only a handful
  // of pixels past the saturation gate, the accumulated weight never reaches 1,
  // and a perfectly samplable piece of art falls back to the default. Four times
  // the area clears that floor without turning the average into mush.
  canvas.width = 64;
  canvas.height = 36;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    // The canvas is tainted: the image was served without CORS headers.
    return null;
  }

  let weight = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 128) continue;
    const pr = data[i];
    const pg = data[i + 1];
    const pb = data[i + 2];
    const { s, l } = rgbToHsl(pr, pg, pb);
    if (s < 0.35 || l < 0.15 || l > 0.85) continue;
    // Weight by saturation so the most colourful region wins over a large flat
    // area that only just qualifies.
    const w = s * s;
    weight += w;
    r += pr * w;
    g += pg * w;
    b += pb * w;
  }
  if (weight < 1) return null;

  const hsl = rgbToHsl(r / weight, g / weight, b / weight);
  return hslToHex({
    h: hsl.h,
    s: Math.max(hsl.s, 0.5),
    l: Math.min(0.65, Math.max(0.45, hsl.l)),
  });
}

/**
 * The accent colour for a featured backdrop.
 *
 * Sampling runs in a throwaway canvas rather than pulling in a colour library:
 * the page only needs the dominant hue, and a dependency on the critical path of
 * the first paint is not worth it. The artwork is fetched through the same-origin
 * `/api/image` relay, because TMDB's CDN sends no CORS headers and a direct
 * canvas read of a cross-origin image taints the canvas and throws. Every failure
 * path -- no artwork, a relay error, a tainted canvas, a frame with no saturated
 * pixels -- lands on `FALLBACK_ACCENT`, so the accent is always a real colour.
 */
export function useHeroAccent(url: string | null | undefined): string {
  const [accent, setAccent] = useState(() => {
    readAccentCache();
    return (url && accentMemo.get(url)) || FALLBACK_ACCENT;
  });

  useEffect(() => {
    if (!url) {
      setAccent(FALLBACK_ACCENT);
      return;
    }

    readAccentCache();
    const cached = accentMemo.get(url);
    if (cached) {
      setAccent(cached);
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    /*
     * Sample a thumbnail, not the hero rendition itself.
     *
     * The canvas is 64x36, so a w185 JPEG carries every pixel the sampler can
     * read. Fetching the `original` artwork through the relay meant each hero
     * rotation pulled a multi-megabyte file through the API process purely to
     * average it down to 2304 pixels -- by far the most expensive thing on the
     * home page, and the one nobody could see.
     */
    const sampleUrl = tmdbImage(url, "w185") || url;
    image.onload = () => {
      if (cancelled) return;
      try {
        const sampled = sampleAccent(image) ?? FALLBACK_ACCENT;
        accentMemo.set(url, sampled);
        writeAccentCache();
        setAccent(sampled);
      } catch {
        setAccent(FALLBACK_ACCENT);
      }
    };
    image.onerror = () => {
      if (!cancelled) setAccent(FALLBACK_ACCENT);
    };
    image.src = `${MOVIE_API_BASE_URL}/api/image?url=${encodeURIComponent(sampleUrl)}`;
    return () => {
      cancelled = true;
    };
  }, [url]);

  return accent;
}
