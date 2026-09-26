/**
 * Multi-source embed registry.
 *
 * Playback on this app is tiered:
 *   1. Directly playable URLs (HLS/MP4) resolved from the backend, played by
 *      <VideoPlayer>. Preferred -- no third-party frame in the way.
 *   2. When none of those resolve, fall back to one of the embed providers
 *      below, rendered by <EmbedPlayer>. Selection and failover between them
 *      are automatic -- the viewer is never shown which provider is in use or
 *      offered a switcher -- so `label` and `title` below are registry
 *      metadata for debugging only and are not rendered.
 *
 * Everything here is a pure URL builder: no scraping, no server-side proxying.
 * Each entry is just a template, so a provider going down is a one-line removal
 * rather than a code change.
 */

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
 * Order matters: the first source is preselected, so put the most reliable
 * provider first and the shakiest last.
 */
export const EMBED_SOURCES: readonly EmbedSource[] = [
  { id: "vidsrc", label: "Server 1", title: "Server 1 - VidSrc", host: "vidsrc.to" },
  {
    id: "autoembed",
    label: "Server 2",
    title: "Server 2 - AutoEmbed",
    host: "autoembed.to",
  },
  { id: "mycima", label: "MyCima Stream", title: "MyCima Stream", host: "mycima.tv" },
  { id: "2embed", label: "Server 4", title: "Server 4 - 2Embed", host: "2embed.org" },
  {
    id: "multiembed",
    label: "Server 5",
    title: "Server 5 - MultiEmbed",
    host: "multiembed.mov",
  },
] as const;

/** IDs are `[a-z0-9-]`; anything else could break out of the URL path. */
function safeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return /^[A-Za-z0-9-]+$/.test(str) ? str : null;
}

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
 * Resolve every provider that can serve this target, in switcher order.
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
