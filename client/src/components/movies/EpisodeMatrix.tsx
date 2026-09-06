import { useMemo, useState } from "react";
import { Check, ChevronDown, Play } from "lucide-react";
import { useStatsRevision } from "@/hooks/useStats";
import { getProgressFraction } from "@/services/stats";
import type { StreamEpisode, StreamMovie } from "@/services/api";

interface EpisodeMatrixProps {
  movie: StreamMovie;
  onPlay: () => void;
}

/**
 * Season & Episode matrix. Real shows use `movie.episodes` (grouped by
 * season); standalone films synthesize "Season 1 · Episode 1" for the film.
 * Each row carries a watched-progress bar against the stream's stats.
 */
export function EpisodeMatrix({ movie, onPlay }: EpisodeMatrixProps) {
  useStatsRevision();

  const episodes = useMemo<StreamEpisode[]>(() => {
    if (movie.episodes?.length) return movie.episodes;
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

  const [openSeasons, setOpenSeasons] = useState<Set<number>>(
    () => new Set([grouped[0]?.[0] ?? 1])
  );

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

  return (
    <section className="mt-8 rounded-xl border border-white/10 bg-[#121212] p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-white/80">
          {episodes.length === 1 ? "Feature" : "Episodes"}
          {episodes.length > 1 && <span className="ml-1 text-white/50">• {episodes.length}</span>}
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
                  {list.map(episode => (
                    <li
                      key={`${season}-${episode.number}`}
                      className="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-0"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/15 text-[11px] font-bold tabular-nums text-white/80">
                        {String(episode.number).padStart(2, "0")}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-white">
                          {episode.title}
                        </p>
                        <div className="mt-1.5 flex items-center gap-2">
                          {watched ? (
                            <span className="flex items-center gap-1 text-[11px] text-white/70">
                              <Check className="h-3 w-3" /> Watched
                            </span>
                          ) : fraction > 0 ? (
                            <div className="h-1 w-32 overflow-hidden rounded-full bg-white/10">
                              <div
                                className="h-full rounded-full bg-white"
                                style={{ width: `${Math.round(fraction * 100)}%` }}
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
                        onClick={onPlay}
                        aria-label={`Play ${episode.title}`}
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-black transition hover:bg-white/90"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}