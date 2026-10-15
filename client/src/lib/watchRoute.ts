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

/**
 * Build the canonical title-page path -- the movie window as a URL.
 *
 * Same invariant as the watch route: a film never carries a query, and the
 * kind rides as `type=tv` because a TMDB id means nothing without its media
 * type. One builder so the page, the cards and the wall can never disagree
 * about what a title's address is.
 *
 * `resume` is the Continue Watching case. That shelf's whole promise is "pick
 * this back up", and routing it through the details page (which every click
 * now does) would otherwise drop the viewer back to S1E1 of a series they were
 * three episodes into. The season/episode ride along as query params so the
 * title page's Play button can hand them straight to the watch route; they are
 * ignored for a film, which has no episode to restore.
 */
export function buildTitlePath(
  tmdbId: string | number,
  mediaType: MediaType = "movie",
  resume?: { season?: number; episode?: number },
): string {
  if (mediaType !== "tv") return `/title/${tmdbId}`;
  const base = `/title/${tmdbId}?type=tv`;
  const season = resume?.season ?? 1;
  const episode = resume?.episode ?? 1;
  return `${base}&season=${season}&episode=${episode}`;
}
