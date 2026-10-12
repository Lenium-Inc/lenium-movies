import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  Download,
  Loader2,
  Play,
  Star,
  X,
  Clock,
} from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { formatRuntime } from "@/lib/format";
import { buildWatchPath, resolveMediaType } from "@/lib/watchRoute";
import { toast } from "sonner";
import { getRating, setRating, subscribeRatings } from "@/services/ratings";
import {
  fetchTrailer,
  fetchTrailerByTmdbId,
  getStreamSource,
  proxiedDownloadUrl,
  resolveStream,
  StreamNotFoundError,
  type ResolvedStream,
  type StreamMovie,
  type TrailerInfo,
} from "@/services/api";
import {
  buildDownloadFilename,
  downloadUnavailableReason,
  pickDownloadCandidate,
} from "@/lib/downloadSource";
import { EpisodeMatrix } from "@/components/movies/EpisodeMatrix";
import { useEmbedFailure } from "@/hooks/useEmbedFailure";
import { tmdbImage, type TmdbImageSize } from "@/lib/tmdbImages";
import { resolveTrailer } from "@/lib/tmdbTrailers";
import { TrailerBrandingMask } from "@/components/stream/TrailerBrandingMask";
import {
  getProgress,
  progressForTitle,
  subscribeStats,
} from "@/services/stats";
import type { Movie } from "./types";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

/** Delegates to `tmdbImage` so the requested rendition actually takes effect.
 *  The old `startsWith("http")` early return matched every backend-supplied
 *  value, so the `original` backdrop below was served at the stored w1280. */
function getImageUrl(path: string, size: TmdbImageSize): string {
  if (path.startsWith("http")) return tmdbImage(path, size);
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

const RATE_AFTER_SECONDS = 15 * 60;

interface DetailsProps {
  movie: Movie;
  onClose: () => void;
  onSave: () => void;
  saved: boolean;
}

/**
 * Bottom-sheet style modal that opens instantly with skeleton placeholders.
 * Loads full metadata and stream resolution in the background.
 */
export function Details({ movie, onClose, onSave, saved }: DetailsProps) {
  const [, navigate] = useLocation();
  const { user: authUser } = useAuth();
  const [resolved, setResolved] = useState<ResolvedStream | null>(null);
  // Whether the sheet's silent warm resolve came back empty-handed. Without
  // this the TV branch below sat on a blank gap forever: `detailsLoaded`
  // flips synchronously, so the skeleton never showed, and a failed resolve
  // looked exactly like "this series has no episodes".
  const [resolveFailed, setResolveFailed] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [myRating, setMyRating] = useState<number>(
    () => getRating(movie.id) ?? 0
  );
  const [watchedSeconds, setWatchedSeconds] = useState(0);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);

  useEffect(
    () =>
      subscribeRatings(() => {
        setMyRating(getRating(movie.id) ?? 0);
      }),
    [movie.id]
  );

  useEffect(() => {
    const refresh = () =>
      setWatchedSeconds(
        Math.max(
          getProgress(String(movie.id)),
          resolved ? getProgress(resolved.stream.id) : 0,
          progressForTitle(movie.title)
        )
      );
    refresh();
    return subscribeStats(refresh);
  }, [movie.id, movie.title, resolved]);

  const canRate = watchedSeconds >= RATE_AFTER_SECONDS;

  // Fetch trailer in background (by title/year)
  useEffect(() => {
    // Title lookup is the fallback for a row with no TMDB id. When an id is
    // present the id-based effect below owns the trailer, and letting a
    // title search also write would race it -- the slower response wins, and
    // a slower null erases a trailer that was already correct.
    if (movie.providerId) return;
    let active = true;
    setTrailer(null);
    void fetchTrailer(movie.title, movie.year)
      .then(info => {
        if (active) setTrailer(info);
      })
      .catch(() => {
        if (active) setTrailer(null);
      });
    return () => {
      active = false;
    };
  }, [movie.title, movie.year, movie.providerId]);

  // Fetch YouTube trailer by TMDB ID for autoplaying background
  useEffect(() => {
    if (!movie.providerId) return;
    let active = true;
    // The media kind has to ride along: a TMDB id is only meaningful against
    // its own type, and asking the movie endpoint for a series id returns the
    // wrong trailer (or none) -- which is why this sheet showed no trailer.
    void fetchTrailerByTmdbId(movie.providerId, movie.mediaType)
      .then(info => {
        if (active && info) setTrailer(info);
      })
      .catch(() => {
        // Silently fail - keep existing trailer or fallback to backdrop
      });
    return () => {
      active = false;
    };
  }, [movie.providerId, movie.mediaType]);

  // Tear the background embed down if it is unplayable, so this dialog falls
  // back to the backdrop instead of showing the player's error card.
  const { failed: trailerFailed, frameRef: trailerFrameRef } = useEmbedFailure(
    trailer ? `${trailer.provider}:${trailer.id}` : null
  );

  // Built by the one resolver rather than assembled here. This dialog is a
  // destination the viewer opened deliberately, so it gets the provider's own
  // controls -- unlike the hover preview on a card, where they would fight the
  // poster for the pointer.
  const trailerSrc = resolveTrailer(trailer, { loop: false, controls: true });

  // The embed takes a beat to produce its first frame. The backdrop holds the
  // slot and a spinner marks the wait, so the sheet never shows a black
  // rectangle where the trailer will be.
  const [trailerFrameLoaded, setTrailerFrameLoaded] = useState(false);
  useEffect(() => {
    setTrailerFrameLoaded(false);
  }, [trailerSrc?.src]);

  /**
   * Build the playable stream for the selected title/episode and open the player.
   */
  const resolveAndPlay = async (
    targetSeason: number,
    targetEpisode: number
  ) => {
    if (resolving) return;
    setResolving(true);
    setPlayError(null);
    try {
      let base = resolved?.stream ?? null;
      if (!base) {
        // Resolve by TMDB ID when the card carries one. A title-only lookup
        // for a series searches the film catalog, finds nothing, and answers
        // "unavailable" -- the title is right, the media kind is not.
        const stream = await resolveStream(movie.title, movie.year, {
          tmdbId: /^\d+$/.test(movie.providerId) ? movie.providerId : undefined,
          mediaType: movie.mediaType,
        });
        setResolved(stream);
        base = stream.stream;
      }
      setSeason(targetSeason);
      setEpisode(targetEpisode);

      let playable: StreamMovie = base;
      const mediaType = resolveMediaType({ localMediaType: movie.mediaType });
      if (mediaType && /^\d+$/.test(base.id)) {
        try {
          const source = await getStreamSource({
            tmdbId: base.id,
            mediaType,
            season: mediaType === "tv" ? targetSeason : undefined,
            episode: mediaType === "tv" ? targetEpisode : undefined,
          });
          playable = {
            ...base,
            stream_url: source.url,
            sources: source.sources,
            mirrors: source.mirrors,
            season: targetSeason,
            episode: targetEpisode,
          };
        } catch (error) {
          console.warn(
            `[Details] playback-init failed for "${base.title}" (S${targetSeason}E${targetEpisode}), using resolved source`,
            error
          );
          if (mediaType === "tv") {
            const stream = await resolveStream(movie.title, movie.year, {
              tmdbId: /^\d+$/.test(movie.providerId) ? movie.providerId : undefined,
              mediaType: "tv",
              season: targetSeason,
              episode: targetEpisode,
            });
            playable = {
              ...stream.stream,
              season: targetSeason,
              episode: targetEpisode,
            };
          }
        }
      }

      setResolved({ stream: playable, exact: true });
      navigate(
        buildWatchPath(movie.providerId, {
          mediaType: movie.mediaType,
          season: targetSeason,
          episode: targetEpisode,
        })
      );
    } catch (error) {
      const isNotFound = error instanceof StreamNotFoundError;
      console.error(
        `[Details] could not resolve "${movie.title}" (${movie.year ?? "unknown year"})`,
        error
      );
      setPlayError(
        isNotFound
          ? `"${movie.title}" isn't available to stream yet.`
          : "We couldn't find a stream for this title just yet."
      );
    } finally {
      setResolving(false);
    }
  };

  const play = async () => {
    if (resolving) return;
    // Navigation belongs to `resolveAndPlay`: it pushes the watch route only
    // once the stream is actually playable, and leaves the dialog open on a
    // failure so `playError` can say why. A second navigate here duplicated
    // the history entry (Back appeared broken) and fired even when the
    // resolve had failed, unmounting the dialog before its error showed.
    if (resolved) {
      const isSeries = movie.mediaType === "tv";
      await resolveAndPlay(isSeries ? season : 1, isSeries ? episode : 1);
      return;
    }
    await resolveAndPlay(1, 1);
  };

  /**
   * Save the resolved direct file to the user's device.
   *
   * Resolution is done on demand rather than reusing the Play path, because
   * Play navigates away from this sheet and its resolved `playable` object is
   * local to `resolveAndPlay`. A TV title resolves the specific episode the
   * viewer is looking at so the download matches what is on screen.
   *
   * Sources that are not a single saveable file are reported rather than
   * silently writing a 3 KB playlist or navigating the tab to a third-party
   * page.
   */
  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const mediaType = resolveMediaType({ localMediaType: movie.mediaType });
      let source: StreamMovie | null = resolved?.stream ?? null;

      if (!source) {
        source = (
          await resolveStream(movie.title, movie.year, {
            tmdbId: /^\d+$/.test(movie.providerId) ? movie.providerId : undefined,
            mediaType: movie.mediaType,
          })
        ).stream;
      }
      // A TV title's primary source is the S1E1 embed, so ask for the episode
      // currently selected in the sheet.
      if (mediaType === "tv" && /^\d+$/.test(source.id)) {
        try {
          const episodeSource = await getStreamSource({
            tmdbId: source.id,
            mediaType,
            season,
            episode,
          });
          source = {
            ...source,
            stream_url: episodeSource.url,
            ...(episodeSource.sources
              ? { sources: episodeSource.sources }
              : {}),
          };
        } catch (error) {
          console.warn(
            `[Details] playback-init failed for download "${source.title}" (S${season}E${episode})`,
            error
          );
        }
      }

      const candidate = pickDownloadCandidate(source);
      if (candidate.kind !== "progressive") {
        toast.error(downloadUnavailableReason(candidate));
        return;
      }

      const filename = buildDownloadFilename(source, candidate);
      // An anchor with a same-origin href lets the browser act on the
      // `Content-Disposition: attachment` the backend returns. A minted
      // download handle *is* the route; a raw archive.org URL still needs
      // the relay alias built around it.
      const anchor = document.createElement("a");
      anchor.href = candidate.url.startsWith("/")
        ? candidate.url
        : proxiedDownloadUrl(candidate.url, filename);
      anchor.rel = "noopener";
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast.success(`Downloading ${filename}`);
    } catch (error) {
      console.warn("[Details] download failed", error);
      toast.error("Could not start the download. Please try again.");
    } finally {
      setDownloading(false);
    }
  };

  const playEpisode = (targetSeason: number, targetEpisode: number) => {
    void resolveAndPlay(targetSeason, targetEpisode);
  };

  // Pre-cache engine: the moment the sheet opens, silently resolve the title.
  // The lookup itself lives in `warmResolve` because the failure state below
  // offers it as a retry — an effect-only version would strand the viewer on
  // an empty sheet with no way back in.
  const warmResolve = useCallback(async () => {
    setResolveFailed(false);
    try {
      const isSeries = movie.mediaType === "tv";
      const stream = await resolveStream(movie.title, movie.year, {
        tmdbId: /^\d+$/.test(movie.providerId) ? movie.providerId : undefined,
        mediaType: movie.mediaType,
        // A series warms the episode the sheet will open on, so the first
        // Play click is already resolved rather than a cold lookup.
        season: isSeries ? 1 : undefined,
        episode: isSeries ? 1 : undefined,
      });
      setResolved(stream);
    } catch (error) {
      console.warn(`[Details] warm resolve skipped for "${movie.title}"`, error);
      setResolveFailed(true);
    }
  }, [movie.title, movie.year, movie.providerId, movie.mediaType]);

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;

    // The sheet's content is local; there is nothing to wait on before showing
    // it. (This used to sit behind a 100ms timer "for smooth UX" — which only
    // delayed the metadata the render already had.)
    setDetailsLoaded(true);

    void warmResolve();
  }, [warmResolve]);

  // Skeleton placeholder for metadata
  const SkeletonMetadata = () => (
    <div className="space-y-3 animate-pulse">
      <div className="flex flex-wrap items-center gap-2">
        <div className="h-4 w-16 bg-white/10 rounded" />
        <div className="h-4 w-4 bg-white/10 rounded-full" />
        <div className="h-4 w-24 bg-white/10 rounded" />
        <div className="h-4 w-20 bg-white/10 rounded" />
      </div>
      <div className="h-4 w-full bg-white/10 rounded" />
      <div className="h-4 w-3/4 bg-white/10 rounded" />
      <div className="h-4 w-1/2 bg-white/10 rounded" />
    </div>
  );

  // Skeleton placeholder for action buttons
  const SkeletonActions = () => (
    <div className="flex flex-wrap gap-2 animate-pulse">
      <div className="h-10 w-28 bg-white/10 rounded-md" />
      <div className="h-10 w-32 bg-white/10 rounded-md border border-white/10" />
    </div>
  );

  // Skeleton placeholder for EpisodeMatrix
  const SkeletonEpisodes = () => (
    <section className="mt-8 rounded-xl border border-white/10 bg-[#121212] p-5 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-4 w-32 bg-white/10 rounded" />
      </div>
      <div className="mt-3 space-y-2">
        {[1, 2, 3].map(i => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-white/5 px-4 py-3"
          >
            <div className="h-8 w-8 rounded-full border border-white/10" />
            <div className="flex-1">
              <div className="h-4 w-3/4 bg-white/10 rounded" />
              <div className="mt-1 h-3 w-24 bg-white/10 rounded" />
            </div>
            <div className="h-9 w-9 rounded-full bg-white/10" />
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${movie.title} details`}
      onClick={onClose}
    >
      <div
        onClick={event => event.stopPropagation()}
        className="sv-surface-strong max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-t-xl shadow-2xl sm:rounded-xl"
      >
        <div className="relative aspect-video w-full bg-[var(--sv-base-deep)]">
          {/*
            Backdrop first, trailer over it. These used to be exclusive
            branches, so an embed that failed to play left the provider's error
            card filling this box with nothing behind it. Keeping the artwork
            mounted means dropping a failed iframe is all it takes to recover.
          */}
          {movie.backdrop ? (
            <img
              key="backdrop"
              src={getImageUrl(movie.backdrop, "original")}
              alt=""
              loading="eager"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-[#1B1B20] to-[#0a0a0c]" />
          )}
          {trailerSrc && !trailerFailed ? (
            <>
              {!trailerFrameLoaded ? (
                <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                </div>
              ) : null}
              <iframe
                key="trailer-embed"
                ref={trailerFrameRef}
                src={trailerSrc.src}
                onLoad={() => setTrailerFrameLoaded(true)}
                className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
                  trailerFrameLoaded ? "opacity-100" : "opacity-0"
                }`}
                allow="autoplay; encrypted-media"
                sandbox="allow-scripts allow-same-origin allow-forms"
                // See Spotlight: "no-referrer" is what makes the host answer 153.
                referrerPolicy="strict-origin-when-cross-origin"
                title={`${movie.title} — ${trailerSrc.label}`}
              />
              <TrailerBrandingMask />
            </>
          ) : null}
          <button
            onClick={onClose}
            aria-label="Close details"
            className="absolute right-3 top-3 z-10 rounded-full bg-black/60 p-2 text-white backdrop-blur-sm transition hover:bg-black/80"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">
          {detailsLoaded ? (
            <>
              <h2 className="text-2xl font-bold sm:text-3xl">{movie.title}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#aaa9ae]">
                {movie.year && <span>{movie.year}</span>}
                {movie.runtime && (
                  <>
                    <span>·</span>
                    <span>{formatRuntime(movie.runtime)}</span>
                  </>
                )}
                <span>·</span>
                <span>{movie.genre.join(" · ")}</span>
                {movie.score !== null && (
                  <span className="flex items-center gap-1 text-[#d7d7d3]">
                    <Star className="h-3.5 w-3.5 fill-current" />
                    {movie.score}
                  </span>
                )}
              </div>
              {/* The mapper no longer invents synopsis copy, so the fallback
                  lives here: a title the catalog has no overview for shows
                  nothing here instead of a paragraph of marketing. */}
              {movie.synopsis ? (
                <p className="mt-4 text-sm leading-6 text-[#c5c5c1]">
                  {movie.synopsis}
                </p>
              ) : null}
            </>
          ) : (
            <SkeletonMetadata />
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {/* The Play button is shown for series too. It used to be gated on
                `mediaType !== "tv"` -- the episode grid was treated as the only
                entry point for a show -- but a viewer opening the sheet for a
                series still wants the obvious primary action, and `play()`
                already resolves the currently selected episode (S1E1 by
                default) and routes through buildWatchPath with type=tv. */}
            <button
              onClick={play}
              disabled={resolving}
              className="flex w-full sm:w-auto items-center justify-center gap-2 rounded-xl bg-white px-8 py-3 text-sm font-bold text-black hover:bg-neutral-200 disabled:opacity-60 transition-all active:scale-[0.98] shadow-lg shadow-black/20"
            >
              {resolving ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Play className="h-5 w-5 fill-current" />
              )}
              Play
            </button>
            <button
              onClick={() => {
                if (!authUser) {
                  navigate("/login");
                  return;
                }
                toast.success(
                  saved ? "Removed from your list" : "Added to your list!"
                );
                onSave();
              }}
              className="flex items-center gap-2 rounded-md border border-white/15 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              {saved ? (
                <Check className="h-4 w-4" />
              ) : (
                <Bookmark className="h-4 w-4" />
              )}
              <span>{saved ? "In My List" : "Add to My List"}</span>
            </button>
            <button
              onClick={() => {
                void handleDownload();
              }}
              disabled={downloading}
              aria-label="Download for offline viewing"
              className="flex items-center gap-2 rounded-md border border-white/15 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:opacity-60"
            >
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <span>{downloading ? "Preparing…" : "Download"}</span>
            </button>
          </div>

          {canRate && detailsLoaded && (
            <div className="mt-4 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/40">
                Your rating
              </span>
              <span className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    type="button"
                    aria-label={`Rate ${star} out of 5`}
                    disabled={!canRate}
                    onClick={() => {
                      setRating(movie, star === myRating ? 0 : star);
                      setMyRating(star === myRating ? 0 : star);
                    }}
                    className="p-0.5 text-white transition hover:scale-110"
                  >
                    <Star
                      className={`h-4 w-4 ${
                        star <= myRating
                          ? "fill-[#d7d7d3] text-[#d7d7d3]"
                          : "text-white/30"
                      }`}
                    />
                  </button>
                ))}
              </span>
              {myRating > 0 && (
                <span className="text-[11px] tabular-nums text-white/50">
                  {myRating}/5
                </span>
              )}
            </div>
          )}

          {playError && detailsLoaded && (
            <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs leading-5 text-[#c5c5c1]">
              <p>{playError}</p>
            </div>
          )}

          {resolved && !resolved.exact && detailsLoaded && (
            <p className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-5 text-[#c5c5c1]">
              Closest matching archive film:{" "}
              <span className="font-semibold text-white">
                {resolved.stream.title}
              </span>
            </p>
          )}

          {movie.mediaType === "tv" ? (
            resolved ? (
              <EpisodeMatrix
                movie={resolved.stream}
                onPlay={ep => {
                  playEpisode(ep.season, ep.number);
                  navigate(
                    buildWatchPath(movie.providerId, {
                      mediaType: "tv",
                      season: ep.season,
                      episode: ep.number,
                    })
                  );
                }}
              />
            ) : resolveFailed ? (
              // The warm resolve missed (no source, backend hiccup). Saying
              // so beats a blank gap that reads as "this show has no
              // episodes"; Play retries the same lookup, and so does this.
              <div
                role="status"
                className="mt-6 rounded-md border border-white/10 bg-white/[0.03] px-3 py-3 text-xs leading-5 text-[#c5c5c1]"
              >
                <p>
                  The episode list couldn't load — no playable source answered
                  for this title right now.
                </p>
                <button
                  type="button"
                  onClick={() => void warmResolve()}
                  className="mt-2 font-semibold text-white underline underline-offset-2 transition hover:text-white/80"
                >
                  Try again
                </button>
              </div>
            ) : (
              <SkeletonEpisodes />
            )
          ) : detailsLoaded ? null : (
            <SkeletonEpisodes />
          )}
        </div>
      </div>
    </div>
  );
}
