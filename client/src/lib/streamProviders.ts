/**
 * Stream provider registry.
 *
 * This is the client's copy of the `EMBED_PROVIDERS` manifest in
 * `movie-backend/stream_providers.py`, which is the authority. It is mirrored
 * here for exactly three jobs, none of which is playback:
 *
 *   1. recognising a third-party host as an embed (`EMBED_HOSTS`), so a stale
 *      or raw provider URL is never handed to `<video>`/hls.js as if it were
 *      an MP4;
 *   2. labelling the provider tabs the picker draws, so a switcher reads
 *      identically on both sides;
 *   3. asserting parity with the Python manifest in `embedSources.test.ts`,
 *      which fails the build when a provider is added on one side only.
 *
 * Frames are never addressed from here. Every URL the player loads comes from
 * `/api/v1/playback/init` as a tokenised handle (`/api/v1/playback/frame
 * ?token=...`), so the set of hosts this process ever fetches is decided by
 * server-side resolution alone. `getUrl` below mirrors the backend's
 * `EmbedProvider.build()` so the two URL shapes can be asserted against each
 * other -- it is a manifest field, not a playback path.
 *
 * Every entry is a *pure URL builder* keyed on an exact TMDB id. Nothing here
 * searches by title, guesses a slug, or scrapes a provider's catalogue page --
 * a search string sent to an embed host reliably resolves to whatever the
 * provider thinks you meant, which is how a viewer ends up watching the wrong
 * film on a source that reported success. `tmdbId` is the only key.
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
  /**
   * Host the provider's frames load from. Mirrors `EmbedProvider.host` on the
   * backend exactly -- including `www.2embed.cc` keeping its `www.` -- because
   * `EMBED_HOSTS` is matched against a request hostname and a missing label
   * here is a provider the client then treats as a media file.
   */
  host: string;
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
    host: "vidsrc.pro",
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
    host: "vidsrc.cc",
    getUrl: (id, type, s = 1, e = 1) =>
      type === "movie"
        ? `https://vidsrc.cc/v2/embed/movie/${id}`
        : `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: "vidlink",
    name: "VidLink",
    quality: "1080p",
    type: "global",
    host: "vidlink.pro",
    getUrl: (id, type, s = 1, e = 1) =>
      type === "movie"
        ? `https://vidlink.pro/movie/${id}`
        : `https://vidlink.pro/tv/${id}/${s}/${e}`,
  },
  {
    id: "vidsrc-me",
    name: "Home Stream",
    quality: "1080p",
    type: "fast",
    host: "vidsrc.me",
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
    host: "www.2embed.cc",
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
    host: "vidsrc.to",
    getUrl: (id, type, s = 1, e = 1) =>
      type === "movie"
        ? `https://vidsrc.to/embed/movie/${id}`
        : `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
];

/**
 * The manifest's URL for a target, or `""` when the target cannot be keyed.
 *
 * Mirrors `EmbedProvider.build()` in `stream_providers.py`: same `safeStreamId`
 * gate, same templates, same refusal to emit anything when the id fails the
 * character class. Used by the parity tests and by `providerHost`; never by the
 * player, which only ever loads a handle the backend minted.
 */
export function buildProviderUrl(
  provider: StreamProvider,
  tmdbId: unknown,
  type: "movie" | "tv",
  season = 1,
  episode = 1
): string {
  const safe = safeStreamId(tmdbId);
  if (!safe) return "";
  return provider.getUrl(safe, type, season, episode);
}

/** Default selection for the source picker: the first, highest-priority entry. */
export const DEFAULT_STREAM_PROVIDER: StreamProvider = STREAM_PROVIDERS[0];

/** The host a provider's frames load from, read off its own manifest entry. */
export function providerHost(provider?: StreamProvider): string {
  return provider?.host ?? "";
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
