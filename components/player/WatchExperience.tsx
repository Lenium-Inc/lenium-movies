"use client";

import { useEffect, useState } from "react";
import { NativeStreamPlayer } from "@/components/player/NativeStreamPlayer";
import type { EpisodeSummary, StreamPayload } from "@/types/stream";
import type { ContentCardItem } from "@/components/ui/ContentGrid";

interface WatchExperienceProps {
  titleId: string;
  title: ContentCardItem & { cast: string[]; episodes: EpisodeSummary[] };
  initialEpisode?: EpisodeSummary;
}

async function resolveStream(
  titleId: string,
  episode?: Pick<EpisodeSummary, "season" | "episode">
): Promise<StreamPayload> {
  const params = new URLSearchParams({ titleId });
  if (episode) {
    params.set("season", String(episode.season));
    params.set("episode", String(episode.episode));
  }
  const response = await fetch(`/api/v1/stream/resolve?${params}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error || "This title is not available.");
  }
  return (await response.json()) as StreamPayload;
}

export function WatchExperience({
  titleId,
  title,
  initialEpisode,
}: WatchExperienceProps) {
  const [stream, setStream] = useState<StreamPayload | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<
    EpisodeSummary | undefined
  >(initialEpisode);
  const [retryVersion, setRetryVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStream(null);
    setError("");
    resolveStream(titleId, selectedEpisode)
      .then(payload => {
        if (!cancelled) setStream(payload);
      })
      .catch(failure => {
        if (!cancelled) {
          setError(
            failure instanceof Error
              ? failure.message
              : "This title could not be loaded."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [titleId, selectedEpisode, retryVersion]);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <div className="sticky top-4 z-20">
          {stream ? (
            <NativeStreamPlayer
              key={`${titleId}-${selectedEpisode?.season ?? 0}-${selectedEpisode?.episode ?? 0}`}
              titleId={titleId}
              initialPayload={stream}
              title={title.title}
            />
          ) : (
            <div className="grid aspect-video place-items-center rounded-2xl border border-white/10 bg-zinc-950 text-sm text-white/65">
                {loading ? (
                  "Preparing your stream…"
                ) : (
                  <div className="text-center">
                    <p>{error || "Stream unavailable."}</p>
                    <button
                      type="button"
                      onClick={() => setRetryVersion(value => value + 1)}
                      className="mt-4 rounded-full border border-white/20 px-4 py-2 text-xs font-semibold text-white hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    >
                      Try again
                    </button>
                  </div>
                )}
            </div>
          )}
        </div>
        <div className="mt-6 flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-200/70">
              {title.kind === "series" ? "Series" : "Feature"}
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
              {title.title}
            </h1>
            {selectedEpisode ? (
              <p className="mt-2 text-sm text-white/60">
                Season {selectedEpisode.season}, episode {selectedEpisode.episode}
                {selectedEpisode.title ? ` · ${selectedEpisode.title}` : ""}
              </p>
            ) : null}
          </div>
          <p className="pt-1 text-sm text-white/55">
            {[title.year, title.rating ? `★ ${title.rating}` : ""]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-white/65">
          {selectedEpisode?.synopsis || title.synopsis}
        </p>
      </div>

      <aside id="details" className="space-y-8">
        {title.kind === "series" && title.episodes.length ? (
          <section>
            <label
              htmlFor="episode-picker"
              className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45"
            >
              Episodes
            </label>
            <select
              id="episode-picker"
              value={
                selectedEpisode
                  ? `${selectedEpisode.season}:${selectedEpisode.episode}`
                  : ""
              }
              onChange={event => {
                const [season, episode] = event.currentTarget.value
                  .split(":")
                  .map(Number);
                setSelectedEpisode(
                  title.episodes.find(
                    item => item.season === season && item.episode === episode
                  )
                );
              }}
              className="mt-3 w-full rounded-lg border border-white/10 bg-white/[0.05] px-3 py-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200"
            >
              {title.episodes.map(item => (
                <option
                  key={`${item.season}:${item.episode}`}
                  value={`${item.season}:${item.episode}`}
                  className="bg-zinc-950"
                >
                  S{String(item.season).padStart(2, "0")} · E
                  {String(item.episode).padStart(2, "0")} — {item.title}
                </option>
              ))}
            </select>
          </section>
        ) : null}

        {title.cast.length ? (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
              Cast
            </h2>
            <ul className="mt-3 divide-y divide-white/[0.07]">
              {title.cast.slice(0, 8).map(person => (
                <li key={person} className="py-3 text-sm text-white/75">
                  {person}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {title.genres.length ? (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
              Genres
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {title.genres.map(genre => (
                <span
                  key={genre}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/70"
                >
                  {genre}
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </aside>
    </div>
  );
}
