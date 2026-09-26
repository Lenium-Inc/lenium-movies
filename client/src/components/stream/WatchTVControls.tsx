import { useMemo, useState } from "react";
import { Check, ChevronDown, Play } from "lucide-react";
import { formatRuntime } from "@/lib/format";
import type { StreamEpisode } from "@/services/api";

export interface SeasonInfo {
  season_number: number;
  episode_count: number;
  name?: string;
}

interface WatchTVControlsProps {
  currentSeason: number;
  currentEpisode: number;
  seasons: SeasonInfo[];
  episodes: StreamEpisode[];
  onSelectEpisode: (season: number, episode: number) => void;
}

/**
 * Season/episode navigation for the watch route.
 *
 * Presentational only: it reports the chosen (season, episode) upward and the
 * page owns URL state and stream resolution. Season 0 is TMDB's convention for
 * specials and is kept out of the selector because it is rarely what someone
 * opens a show to watch.
 */
export function WatchTVControls({
  currentSeason,
  currentEpisode,
  seasons,
  episodes,
  onSelectEpisode,
}: WatchTVControlsProps) {
  const [seasonOpen, setSeasonOpen] = useState(false);

  const playableSeasons = useMemo(
    () =>
      seasons
        .filter((s) => s.season_number > 0 && s.episode_count > 0)
        .sort((a, b) => a.season_number - b.season_number),
    [seasons]
  );

  const activeSeasonNumber = playableSeasons.some(
    (s) => s.season_number === currentSeason
  )
    ? currentSeason
    : playableSeasons[0]?.season_number ?? currentSeason;

  const activeSeason = playableSeasons.find(
    (s) => s.season_number === activeSeasonNumber
  );

  if (playableSeasons.length === 0) return null;

  return (
    <section
      aria-label="Season and episode selection"
      className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4 backdrop-blur-xl sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-zinc-400">
          Episodes
        </h2>

        {/* Season selector */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setSeasonOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={seasonOpen}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
          >
            <span>
              Season {activeSeasonNumber}
              {activeSeason ? ` · ${activeSeason.episode_count} ep` : ""}
            </span>
            <ChevronDown
              className={`h-4 w-4 text-zinc-400 transition-transform ${
                seasonOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          {seasonOpen ? (
            <>
              <div
                className="fixed inset-0 z-10"
                aria-hidden
                onClick={() => setSeasonOpen(false)}
              />
              <ul
                role="listbox"
                className="absolute right-0 z-20 mt-2 max-h-72 w-48 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl"
              >
                {playableSeasons.map((s) => (
                  <li key={s.season_number}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={s.season_number === activeSeasonNumber}
                      onClick={() => {
                        setSeasonOpen(false);
                        // Land on episode 1 of the newly chosen season.
                        onSelectEpisode(s.season_number, 1);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                        s.season_number === activeSeasonNumber
                          ? "bg-violet-500/15 font-semibold text-violet-300"
                          : "text-zinc-300 hover:bg-white/10"
                      }`}
                    >
                      <span>Season {s.season_number}</span>
                      {s.season_number === activeSeasonNumber ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <span className="text-xs text-zinc-500">
                          {s.episode_count}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      {episodes.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">
          No episode list available for this season.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {episodes.map((ep) => {
            const isActive =
              ep.season === activeSeasonNumber && ep.number === currentEpisode;
            const still = ep.still_url || ep.still_path;

            return (
              <li key={`${ep.season}-${ep.number}`}>
                <button
                  type="button"
                  onClick={() => onSelectEpisode(ep.season, ep.number)}
                  aria-current={isActive ? "true" : undefined}
                  className={`group flex w-full items-center gap-3 rounded-xl border p-2 text-left transition ${
                    isActive
                      ? "border-violet-500/70 bg-violet-500/10"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.07]"
                  }`}
                >
                  <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-zinc-800">
                    {still ? (
                      <img
                        src={still}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-zinc-600">
                        <Play className="h-4 w-4" />
                      </div>
                    )}
                    <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      E{ep.number}
                    </span>
                    {isActive ? (
                      <span className="absolute inset-0 grid place-items-center bg-black/45">
                        <span className="rounded-full bg-violet-500 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                          Now Playing
                        </span>
                      </span>
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-sm font-semibold ${
                        isActive ? "text-violet-200" : "text-white"
                      }`}
                    >
                      {ep.title || `Episode ${ep.number}`}
                    </p>
                    {ep.runtime ? (
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {formatRuntime(ep.runtime)}
                      </p>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
