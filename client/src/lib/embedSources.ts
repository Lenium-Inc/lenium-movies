/**
 * Stream provider registry and server-side failover.
 *
 * Playback used to be resolved by two independent, disjoint provider lists: two
 * hardcoded `vidsrc.*` hosts in the backend and five unrelated hosts in
 * `embedSources.ts`. Neither list knew about the other, so "the primary
 * provider is down" was decided in the browser, one viewer click at a time.
 * That is why the error card needed a "Try another source" button: the backend
 * could not express a fallback chain, so the only way to reach the next
 * provider was for the viewer to ask for it.
 *
 * Playback is tiered:
 *
 *   1. `direct` -- Archive.org-backed catalog entries. Real HLS/MP4 URLs the
 *      native player boots directly. Preferred: no third-party frame in the
 *      path, and quality variants come along as mirrors.
 *   2. `embed` -- third-party iframe players, always addressable from a valid
 *      TMDB id. They are the terminal fallback, so a title the direct catalog
 *      does not carry still plays.
 *
 * The backend walks the whole chain server-side and returns the first provider
 * that yields a playable source, plus the remaining candidates in priority
 * order for client-side failover if that URL dies mid-play. A request only
 * fails once every enabled provider has been attempted.
 *
 * Everything here is a pure URL builder plus a liveness probe: no scraping and
 * no proxying, so a provider going away is a manifest edit rather than a code
 * change.
 */

/** IDs are `[A-Za-z0-9-]`; anything else could break out of the URL path. */
function safeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return /^[A-Za-z0-9-]+$/.test(str) ? str : null;
}

export type EmbedMedia = "movie" | "tv";

export interface EmbedSource {
  /** Stable id used for state and React keys. */
  id: string;
  /** Short label for the switcher tab. */
  label: string;
  /** Longer label used in the a11y title attribute. */
  title: string;
  /** Which host this provider needs allowlisted for the frame to load. */
  host: string;
}

export interface EmbedTarget {
  tmdbId?: number | string | null;
  imdbId?: string | null;
  mediaType: EmbedMedia;
  season?: number;
  episode?: number;
}

export interface ResolvedEmbedSource extends EmbedSource {
  url: string;
}

/**
 * Order matters: the first source is preselected and the backend's failover
 * chain follows the same order, so put the most reliable provider first and the
 * shakiest last.
 *
 * These ids and hosts mirror `movie-backend/stream_providers.py`, which is the
 * authority for which provider actually served a title. The two are asserted
 * against each other in `embedSources.test.ts`, because a provider added on
 * one side and not the other is how a title ends up reported as playable by a
 * host the client does not recognise as an embed.
 */
export const EMBED_SOURCES: readonly EmbedSource[] = [
  { id: "vidsrc", label: "Server 1", title: "Server 1", host: "vidsrc.me" },
  { id: "vidsrc_alt", label: "Server 2", title: "Server 2", host: "vidsrc.cc" },
  { id: "vidsrc_to", label: "Server 3", title: "Server 3", host: "vidsrc.to" },
  { id: "autoembed", label: "Server 4", title: "Server 4", host: "autoembed.to" },
  { id: "mycima", label: "Server 5", title: "Server 5", host: "mycima.tv" },
  { id: "2embed", label: "Server 6", title: "Server 6", host: "2embed.org" },
  { id: "multiembed", label: "Server 7", title: "Server 7", host: "multiembed.mov" },
] as const;

/**
 * Every host this app may ever load a third-party frame from. Derived from
 * `EMBED_SOURCES` rather than hand-listed, because a stale hand-list is exactly
 * how a host ends up admitted into the native player's candidate set: it is
 * then handed to `<video>`/hls.js as if it were an MP4, fails, and burns a
 * stall-detection cycle per occurrence.
 */
export const EMBED_HOSTS: readonly string[] = Object.freeze(
  Array.from(new Set(EMBED_SOURCES.map((source) => source.host))),
);

/**
 * tmdb= wins when both ids are present: every provider below is keyed on TMDB.
 * Falls back to IMDb for providers that accept an imdb- style path.
 */
function buildUrl(source: EmbedSource, target: EmbedTarget): string | null {
  const tmdb = safeId(target.tmdbId);
  const imdb = safeId(target.imdbId);
  const isTv = target.mediaType === "tv";
  const season = Number.isFinite(target.season) ? Number(target.season) : 1;
  const episode = Number.isFinite(target.episode) ? Number(target.episode) : 1;

  switch (source.id) {
    case "vidsrc":
    case "vidsrc_to":
      if (tmdb) {
        return isTv
          ? `https://${source.host}/embed/tv/${tmdb}/${season}/${episode}`
          : `https://${source.host}/embed/movie/${tmdb}`;
      }
      if (imdb) {
        return isTv
          ? `https://${source.host}/embed/tv/${imdb}/${season}/${episode}`
          : `https://${source.host}/embed/movie/${imdb}`;
      }
      return null;

    case "vidsrc_alt":
      if (tmdb) {
        return isTv
          ? `https://${source.host}/v2/embed/tv/${tmdb}/${season}/${episode}`
          : `https://${source.host}/v2/embed/movie/${tmdb}`;
      }
      return null;

    case "autoembed":
      if (tmdb) {
        return isTv
          ? `https://${source.host}/embed/tv/${tmdb}?season=${season}&episode=${episode}`
          : `https://${source.host}/embed/movie/tmdb/${tmdb}`;
      }
      if (imdb) {
        return isTv
          ? `https://${source.host}/embed/tv/imdb/${imdb}?season=${season}&episode=${episode}`
          : `https://${source.host}/embed/movie/imdb/${imdb}`;
      }
      return null;

    case "mycima":
      if (tmdb) {
        return isTv
          ? `https://${source.host}/embed/tv/${tmdb}/${season}/${episode}`
          : `https://${source.host}/embed/movie/${tmdb}`;
      }
      if (imdb) return `https://${source.host}/embed/movie/${imdb}`;
      return null;

    case "2embed":
      if (tmdb) {
        return isTv
          ? `https://${source.host}/embed/tv/${tmdb}/${season}/${episode}`
          : `https://${source.host}/embed/movie/${tmdb}`;
      }
      if (imdb) {
        return isTv
          ? `https://${source.host}/embed/tv/${imdb}/${season}/${episode}`
          : `https://${source.host}/embed/movie/${imdb}`;
      }
      return null;

    case "multiembed":
      if (tmdb) {
        return isTv
          ? `https://${source.host}/directstream.php?video_id=${tmdb}&tmdb=1&season=${season}&episode=${episode}`
          : `https://${source.host}/directstream.php?video_id=${tmdb}&tmdb=1`;
      }
      return null;

    default:
      return null;
  }
}

/**
 * Resolve every provider that can serve this target, in failover order.
 * Providers that can't address the target are dropped rather than rendered
 * as a broken tab.
 */
export function resolveEmbedSources(target: EmbedTarget): ResolvedEmbedSource[] {
  const out: ResolvedEmbedSource[] = [];
  for (const source of EMBED_SOURCES) {
    const url = buildUrl(source, target);
    if (url) out.push({ ...source, url });
  }
  return out;
}
