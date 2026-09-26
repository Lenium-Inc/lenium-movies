/**
 * Authoritative media-type resolution and watch-route construction.
 *
 * The external stream resolver's `media_type` has been observed to report some
 * films as series. Trusting it produced `/watch/<id>?season=1&episode=1&type=tv`
 * for a movie, after which every resolve hunted for an episode of a film and
 * playback failed. Local TMDB-backed metadata always wins; the URL is consulted
 * only while that metadata is still loading.
 *
 * These live in one place because the rule was previously duplicated across
 * three call sites, which is how the copies drifted apart in the first place.
 */

export type MediaType = "movie" | "tv";

export function resolveMediaType(input: {
  localMediaType?: MediaType | null;
  resolverMediaType?: string | null;
  urlType?: string | null;
}): MediaType {
  if (input.localMediaType === "tv") return "tv";
  if (input.localMediaType === "movie") return "movie";
  if (input.resolverMediaType === "tv") return "tv";
  if (input.resolverMediaType === "movie") return "movie";
  return input.urlType === "tv" ? "tv" : "movie";
}

/**
 * Build the canonical watch path.
 *
 * A film never carries `season`/`episode`/`type` -- that is the invariant this
 * whole module exists to enforce, since a film resolved as a series is the
 * failure mode that motivated it.
 */
export function buildWatchPath(
  tmdbId: string | number,
  opts: { mediaType: MediaType; season?: number; episode?: number } = {
    mediaType: "movie",
  },
): string {
  const base = `/watch/${tmdbId}`;
  if (opts.mediaType !== "tv") return base;
  const season = opts.season ?? 1;
  const episode = opts.episode ?? 1;
  return `${base}?season=${season}&episode=${episode}&type=tv`;
}
