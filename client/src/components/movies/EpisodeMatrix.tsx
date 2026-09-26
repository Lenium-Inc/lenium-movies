import { useCallback, useMemo, useState, useEffect } from "react";
import { Check, ChevronDown, Play, Loader2 } from "lucide-react";
import { useStatsRevision } from "@/hooks/useStats";
import { getProgressFraction } from "@/services/stats";
import { formatRuntime } from "@/lib/format";
import { fetchEpisodeDetails } from "@/services/api";
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

  // Episode detail state - preloaded for all episodes
  const [episodeDetails, setEpisodeDetails] = useState<
    Map<string, StreamEpisode>
  >(new Map());
  const [loadingDetails, setLoadingDetails] = useState<Set<string>>(new Set());

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

  // Preload episode details for all episodes when component mounts
  useEffect(() => {
    if (!movie.id || !/^\d+$/.test(movie.id)) return;

    const loadAllEpisodeDetails = async () => {
      for (const episode of episodes) {
        const key = `${episode.season}-${episode.number}`;
        if (episodeDetails.has(key) || loadingDetails.has(key)) continue;

        setLoadingDetails(prev => new Set(prev).add(key));

        try {
          const details = await fetchEpisodeDetails(
            movie.id,
            episode.season,
            episode.number
          );
          if (details) {
            setEpisodeDetails(prev =>
              new Map(prev).set(key, { ...episode, ...details })
            );
          }
        } catch (error) {
          console.warn(
            `Failed to fetch episode details for S${episode.season}E${episode.number}:`,
            error
          );
        } finally {
          setLoadingDetails(prev => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
    };

    loadAllEpisodeDetails();
  }, [movie.id, episodes]);

  // Also load details when a season is expanded (for any not yet loaded)
  useEffect(() => {
    if (!movie.id || !/^\d+$/.test(movie.id)) return;

    const loadVisibleEpisodeDetails = async () => {
      for (const [season, list] of grouped) {
        if (!openSeasons.has(season)) continue;

        for (const episode of list) {
          const key = `${episode.season}-${episode.number}`;
          if (episodeDetails.has(key) || loadingDetails.has(key)) continue;

          setLoadingDetails(prev => new Set(prev).add(key));

          try {
            const details = await fetchEpisodeDetails(
              movie.id,
              episode.season,
              episode.number
            );
            if (details) {
              setEpisodeDetails(prev =>
                new Map(prev).set(key, { ...episode, ...details })
              );
            }
          } catch (error) {
            console.warn(
              `Failed to fetch episode details for S${episode.season}E${episode.number}:`,
              error
            );
          } finally {
            setLoadingDetails(prev => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
          }
        }
      }
    };

    loadVisibleEpisodeDetails();
  }, [openSeasons, movie.id, grouped, episodeDetails, loadingDetails]);

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
                    const isLoading = loadingDetails.has(key);

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
