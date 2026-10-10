/**
 * Stream provider registry.
 *
 * Every entry here is a *pure URL builder* keyed on an exact TMDB id. Nothing
 * in this file searches by title, guesses a slug, or scrapes a provider's
 * catalogue page — a search string sent to an embed host reliably resolves to
 * whatever the provider thinks you meant, which is how a viewer ends up
 * watching the wrong film on a source that reported success. The title-based
 * guessing that used to sit here is gone; `tmdbId` is the only key.
 *
 * The manifest is duplicated in `movie-backend/stream_providers.py`, which is
 * the authority for which provider actually served a title (it walks the chain
 * server-side, liveness-probes each host, and benches the ones that are down).
 * The two are asserted against each other in `embedSources.test.ts`, so a
 * provider added on one side and forgotten on the other fails the build rather
 * than showing up as a silent "this source does not play".
 *
 * `type` is what the UI keys its badges off: `global` providers are
 * English-first, `fast` is the HLS-first mirror, and `arabic` is reserved for
 * an Arabic-language mirror (Mycima used to carry that tier) that serves dubbed
 * and subtitled prints.
 */

/** Ids are `[A-Za-z0-9-]`; anything else could break out of the URL path. */
export function safeStreamId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return /^[A-Za-z0-9-]+$/.test(str) ? str : null;
}

export interface StreamProvider {
  id: string;
  name: string;
  quality: string;
  type: "global" | "arabic" | "fast";
  getUrl: (
    tmdbId: string,
    type: "movie" | "tv",
    season?: number,
    episode?: number
  ) => string;
}

export const STREAM_PROVIDERS: StreamProvider[] = [
  {
    id: "vidsrc-pro",
    name: "Prime HD",
    quality: "1080p / 4K",
    type: "global",
    getUrl: (id, type, s = 1, e = 1) =>
      type === "movie"
        ? `https://vidsrc.pro/embed/movie/${id}`
        : `https://vidsrc.pro/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: "vidsrc-cc",
    name: "Cinema Plus",
    quality: "1080p",
    type: "global",
    getUrl: (id, type, s = 1, e = 1) =>
      type === "movie"
        ? `https://vidsrc.cc/v2/embed/movie/${id}`
        : `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: "vidsrc-me",
    name: "Home Stream",
    quality: "1080p",
    type: "fast",
    getUrl: (id, type, s = 1, e = 1) =>
      type === "movie"
        ? `https://vidsrc.me/embed/movie?tmdb=${id}`
        : `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    id: "2embed",
    name: "Studio HD",
    quality: "720p / 1080p",
    type: "global",
    getUrl: (id, type, s = 1, e = 1) =>
      type === "movie"
        ? `https://www.2embed.cc/embed/${id}`
        : `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
  {
    id: "autoembed",
    name: "Backup Stream",
    quality: "720p / 1080p",
    type: "global",
    getUrl: (id, type, s = 1, e = 1) =>
      type === "movie"
        ? `https://vidsrc.to/embed/movie/${id}`
        : `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
];

/** Default selection for the source picker: the first, highest-priority entry. */
export const DEFAULT_STREAM_PROVIDER: StreamProvider = STREAM_PROVIDERS[0];

/** The host a provider's frames load from, read off its own URL builder. */
export function providerHost(provider?: StreamProvider): string {
  if (!provider) return "";
  try {
    return new URL(provider.getUrl("1", "movie")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Every host the app may ever load a third-party frame from. Derived from the
 * manifest rather than hand-listed, because a stale hand-list is exactly how a
 * host ends up admitted into the native player's candidate set: it is then
 * handed to `<video>`/hls.js as if it were an MP4, fails, and burns a
 * stall-detection cycle per occurrence.
 */
export const STREAM_PROVIDER_HOSTS: readonly string[] = Object.freeze(
  Array.from(new Set(STREAM_PROVIDERS.map(providerHost))).filter(Boolean)
);

/** Look a provider up by id, or `undefined` for an id that is not in the manifest. */
export function findStreamProvider(id: string | null | undefined) {
  if (!id) return undefined;
  return STREAM_PROVIDERS.find(provider => provider.id === id);
}
