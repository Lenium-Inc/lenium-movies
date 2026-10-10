import { useMemo, useState, useEffect, useRef } from "react";
import { Check, ChevronDown, Play, Loader2 } from "lucide-react";
import { useStatsRevision } from "@/hooks/useStats";
import { getProgressFraction } from "@/services/stats";
import { formatRuntime } from "@/lib/format";
import { fetchSeasonDetails } from "@/services/api";
import type { StreamEpisode, StreamMovie } from "@/services/api";

interface EpisodeMatrixProps {
  movie: StreamMovie;
  onPlay: (episode: StreamEpisode) => void;
}

/**
 * Season & Episode matrix. Real shows use `movie.episodes` (grouped by
 * season); standalone films synthesize "Season 1 · Episode 1" for the film.
 * Series served without a full episode manifest fall back to a generated grid
 * sized by the backend's `seasons`/`episodes` counts. Each row carries a
 * watched-progress bar against the stream's stats and plays that exact episode.
 *
 * Episode details (images, descriptions) are preloaded for all episodes by default
 * to provide a rich browsing experience without requiring hover.
 */
export function EpisodeMatrix({ movie, onPlay }: EpisodeMatrixProps) {
  useStatsRevision();

  const episodes = useMemo<StreamEpisode[]>(() => {
    if (movie.episodes?.length) return movie.episodes;
    if (movie.media_type === "tv") {
      const totalSeasons = movie.seasons ?? 1;
      const perSeason = movie.episodes_per_season ?? 12;
      const list: StreamEpisode[] = [];
      for (let season = 1; season <= totalSeasons; season += 1) {
        for (let number = 1; number <= perSeason; number += 1) {
          list.push({
            season,
            number,
            title: `${movie.title} — S${season} E${number}`,
          });
        }
      }
      return list;
    }
    return [{ season: 1, number: 1, title: movie.title }];
  }, [movie]);

  const grouped = useMemo(() => {
    const map = new Map<number, StreamEpisode[]>();
    for (const episode of episodes) {
      const list = map.get(episode.season) ?? [];
      list.push(episode);
      map.set(episode.season, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [episodes]);

  // All seasons collapsed by default - clean, scannable UI
  const [openSeasons, setOpenSeasons] = useState<Set<number>>(new Set());

  // Episode metadata, keyed `${season}-${number}`. Populated lazily, one whole
  // season at a time, as seasons are expanded.
  const [episodeDetails, setEpisodeDetails] = useState<
    Map<string, StreamEpisode>
  >(new Map());

  // Seasons that still need their details fetched. A season is removed from
  // this set the moment its fetch starts (success or failure) so a season is
  // never requested twice, and so a failed season does not spin forever.
  const [pendingSeasons, setPendingSeasons] = useState<Set<number>>(
    () => new Set(grouped.map(([season]) => season))
  );
  const [loadingSeasons, setLoadingSeasons] = useState<Set<number>>(new Set());
  // Guards against a season being claimed by two effects in the same commit.
  const claimedSeasons = useRef<Set<number>>(new Set());

  const fraction = getProgressFraction(movie.id);
  const watched = fraction > 0.6;

  const toggle = (season: number) => {
    setOpenSeasons(previous => {
      const next = new Set(previous);
      if (next.has(season)) next.delete(season);
      else next.add(season);
      return next;
    });
  };

  // Episode metadata is fetched lazily, one whole season per request, and only
  // once that season is actually expanded.
  //
  // The old version prefetched every episode of every season on mount as
  // individual /api/episodes calls -- a 4-season show fired dozens of requests
  // in parallel and tripped the backend's 429 limiter. /api/season answers with
  // an entire season in a single call, so the fan-out collapses to one request
  // per expansion, and expansion-only loading keeps a collapsed show at zero
  // metadata requests.
  useEffect(() => {
    if (!movie.id || !/^\d+$/.test(movie.id)) return;
    const controller = new AbortController();

    const loadSeason = async (season: number) => {
      setLoadingSeasons(previous => new Set(previous).add(season));
      try {
        const payload = await fetchSeasonDetails(movie.id, season);
        if (controller.signal.aborted) return;
        const list = payload?.episodes;
        if (!list?.length) return;
        setEpisodeDetails(previous => {
          const next = new Map(previous);
          for (const episode of list) {
            // A real season from TMDB always numbers its episodes and carries
            // the optional metadata; the bulk type is widened to
            // `number | null` only because the shelf's synthesized rows can
            // lack one. Narrow it back to the shape the matrix renders.
            if (episode.number == null) continue;
            const { number, runtime, vote_average, ...rest } = episode;
            next.set(`${episode.season}-${number}`, {
              ...rest,
              number,
              ...(runtime != null ? { runtime } : {}),
              ...(vote_average != null ? { vote_average } : {}),
            });
          }
          return next;
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`Failed to fetch details for season ${season}:`, error);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingSeasons(previous => {
            const next = new Set(previous);
            next.delete(season);
            return next;
          });
        }
      }
    };

    const run = async () => {
      // At most three season fetches are in flight at a time. Each is a single
      // bulk request, but a page can expand several seasons in quick succession
      // (or remount with rows already open), and an unbounded burst is what
      // tripped the limiter in the first place.
      const queue = grouped
        .map(([season]) => season)
        .filter(
          season =>
            openSeasons.has(season) &&
            pendingSeasons.has(season) &&
            !claimedSeasons.current.has(season)
        );
      if (!queue.length) return;

      for (const season of queue) claimedSeasons.current.add(season);
      setPendingSeasons(previous => {
        const next = new Set(previous);
        for (const season of queue) next.delete(season);
        return next;
      });

      let cursor = 0;
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (cursor < queue.length) {
          const season = queue[cursor];
          cursor += 1;
          await loadSeason(season);
        }
      });
      await Promise.all(workers);
    };

    void run();
    return () => controller.abort();
  }, [openSeasons, movie.id, grouped, pendingSeasons]);

  return (
    <section className="mt-8 rounded-xl border border-white/10 bg-[#121212] p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-white/80">
          {episodes.length === 1 ? "Feature" : "Episodes"}
          {episodes.length > 1 && (
            <span className="ml-1 text-white/50">• {episodes.length}</span>
          )}
        </h2>
        {fraction > 0 && (
          <span
            className={`flex items-center gap-1 text-[11px] ${
              watched ? "font-semibold text-white" : "text-white/50"
            }`}
          >
            {watched ? (
              <>
                <Check className="h-3 w-3" /> Watched
              </>
            ) : (
              `${Math.round(fraction * 100)}% so far`
            )}
          </span>
        )}
      </div>

      <div className="mt-3 space-y-2">
        {grouped.map(([season, list]) => {
          const open = openSeasons.has(season);
          return (
            <div
              key={season}
              className="overflow-hidden rounded-lg border border-white/10"
            >
              <button
                type="button"
                onClick={() => toggle(season)}
                aria-expanded={open}
                className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-white/[0.03]"
              >
                <span className="text-xs font-semibold text-white">
                  Season {season}
                </span>
                <ChevronDown
                  className={`h-4 w-4 text-white/60 transition-transform ${
                    open ? "rotate-180" : ""
                  }`}
                />
              </button>

              {open && (
                <ul className="border-t border-white/10">
                  {list.map(episode => {
                    const key = `${season}-${episode.number}`;
                    const details = episodeDetails.get(key);
                    const isLoading = loadingSeasons.has(season);

                    return (
                      <li
                        key={key}
                        className="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-0 group"
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/15 text-[11px] font-bold tabular-nums text-white/80">
                          {String(episode.number).padStart(2, "0")}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-white">
                            {details?.title || episode.title}
                          </p>
                          {/* Episode metadata display - always visible when details loaded */}
                          {details && (
                            <div className="mt-2 flex items-start gap-3 text-[11px] text-white/70">
                              {details.still_url && (
                                <img
                                  src={details.still_url}
                                  alt=""
                                  className="h-12 w-16 shrink-0 rounded object-cover border border-white/10"
                                  loading="lazy"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                {details.overview && (
                                  <p className="truncate text-white/60 line-clamp-2">
                                    {details.overview}
                                  </p>
                                )}
                                <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-white/40">
                                  {details.air_date && (
                                    <span>📅 {details.air_date}</span>
                                  )}
                                  {details.runtime && (
                                    <span>⏱ {formatRuntime(details.runtime)}</span>
                                  )}
                                  {details.vote_average && (
                                    <span>
                                      ⭐ {details.vote_average.toFixed(1)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          )}
                          {isLoading && !details && (
                            <div className="mt-2 flex items-center gap-2 text-[11px] text-white/50">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              <span>Loading episode details…</span>
                            </div>
                          )}
                          <div className="mt-1.5 flex items-center gap-2">
                            {watched ? (
                              <span className="flex items-center gap-1 text-[11px] text-white/70">
                                <Check className="h-3 w-3" /> Watched
                              </span>
                            ) : fraction > 0 ? (
                              <div className="h-1 w-32 overflow-hidden rounded-full bg-white/10">
                                <div
                                  className="h-full rounded-full bg-white"
                                  style={{
                                    width: `${Math.round(fraction * 100)}%`,
                                  }}
                                />
                              </div>
                            ) : (
                              <span className="text-[11px] text-white/35">
                                Not started
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onPlay(episode)}
                          aria-label={`Play ${details?.title || episode.title}`}
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-black transition hover:bg-white/90"
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
