import { useEffect, useMemo, useState } from "react";
import { fetchSeasonDetails, type SeasonEpisode } from "@/services/api";
import { progressKey } from "@/lib/progressKey";
import type { Movie } from "@/components/movies/types";

export interface ShelfEpisode {
  showId: string;
  showName: string;
  episode: SeasonEpisode;
  /** Resume fraction for this exact episode, or null when unwatched. */
  resume: number | null;
}

export interface NewEpisodesResult {
  episodes: ShelfEpisode[];
  loading: boolean;
  /** True once every candidate has been asked and none of them had an episode. */
  empty: boolean;
}

/** How many shows to interrogate, and how many episodes to keep. */
const MAX_SHOWS = 6;
const MAX_EPISODES = 18;

/**
 * "New episodes", newest first.
 *
 * There is no backend endpoint for "episodes that aired recently", and adding one
 * would mean a new TMDB query type per row. So this composes the season endpoint
 * the catalogue already exposes: ask the shows that are trending *now* for their
 * newest aired season, and sort the union of those episodes by air date. A show
 * that is trending is a show with something happening to it, which makes it a far
 * better source for this shelf than a hardcoded list of favourites.
 *
 * Requests are issued with a concurrency cap rather than all at once. `Promise.all`
 * over six shows is six simultaneous requests, and on a cold page load that is
 * six requests competing with the hero image, the trending row and the season
 * posters -- three of which are above the fold.
 *
 * A show that fails is dropped silently. One unresolvable season must not empty
 * the shelf, and this is background decoration for a shelf nobody navigated to.
 */
export function useNewEpisodes(candidates: Movie[]): NewEpisodesResult {
  const [episodes, setEpisodes] = useState<ShelfEpisode[]>([]);
  const [loading, setLoading] = useState(false);
  const [settled, setSettled] = useState(false);

  // Keyed by show id so the effect does not re-run because an unrelated prop
  // object was recreated; the ids and order are all that matter here.
  const showKey = useMemo(
    () =>
      candidates
        .filter(movie => movie.mediaType === "tv" && movie.providerId)
        .slice(0, MAX_SHOWS)
        .map(movie => `${movie.providerId}`)
        .join(","),
    [candidates]
  );

  useEffect(() => {
    if (!showKey) {
      setEpisodes([]);
      setLoading(false);
      setSettled(true);
      return;
    }

    const ids = showKey.split(",");
    let cancelled = false;
    setLoading(true);
    setSettled(false);

    const load = async () => {
      const collected: ShelfEpisode[] = [];
      // Three at a time: enough to keep the shelf filling without spending the
      // page's whole request budget on decoration.
      const CONCURRENCY = 3;

      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const batch = ids.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async id => {
            try {
              return await fetchSeasonDetails(id);
            } catch {
              // 500s and rate limits are handled here rather than surfaced: this
              // shelf is not worth an error toast, and a partial shelf beats an
              // empty one.
              return null;
            }
          })
        );

        for (const payload of results) {
          if (!payload || !payload.episodes?.length) continue;
          for (const episode of payload.episodes) {
            collected.push({
              showId: String(payload.show.id),
              showName: payload.show.name,
              episode,
              resume: null,
            });
          }
        }
        if (cancelled) return;
      }

      if (cancelled) return;

      // Newest air date first, undated episodes last (they cannot be "recent",
      // so they only fill the shelf if nothing dated does). `season`/`number`
      // break ties deterministically, because a season's episodes frequently
      // share one air date and the original order between them is arbitrary.
      collected.sort((a, b) => {
        const left = a.episode.air_date || "";
        const right = b.episode.air_date || "";
        if (left !== right) {
          if (!left) return 1;
          if (!right) return -1;
          return right < left ? -1 : 1;
        }
        if (a.episode.season !== b.episode.season) {
          return b.episode.season - a.episode.season;
        }
        return (b.episode.number ?? 0) - (a.episode.number ?? 0);
      });

      setEpisodes(collected.slice(0, MAX_EPISODES));
      setLoading(false);
      setSettled(true);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [showKey]);

  return { episodes, loading, empty: settled && episodes.length === 0 };
}

/**
 * Merge watch progress onto the shelf.
 *
 * Kept separate from the fetch because it has to re-run whenever progress
 * changes -- and progress changes during playback, which is not a reason to
 * re-request six seasons.
 *
 * `watched` is the Continue Watching list. Those are already keyed per episode,
 * so this only has to rebuild that key and look the shelf up.
 */
export function useEpisodeResume(
  episodes: ShelfEpisode[],
  watched: Movie[]
): ShelfEpisode[] {
  return useMemo(() => {
    const byKey = new Map<string, number>();
    for (const movie of watched) {
      const season = movie.resumeSeason;
      const episode = movie.resumeEpisode;
      if (!movie.providerId || season == null || episode == null) continue;
      const fraction = movie.resume;
      if (typeof fraction !== "number" || fraction <= 0 || fraction >= 1) {
        // Finished or unwatched. A full bar on a finished episode would be a
        // claim about this episode that the progress store does not support.
        continue;
      }
      byKey.set(
        progressKey(movie.providerId, movie.mediaType ?? "tv", season, episode),
        fraction
      );
    }

    if (byKey.size === 0) return episodes;

    return episodes.map(item => {
      // `number` is null only for an episode TMDB listed without one. There is
      // no route to open for it, so it keeps no resume bar rather than opening
      // S{season}E0.
      if (item.episode.number == null) return item;
      const key = progressKey(
        item.showId,
        "tv",
        item.episode.season,
        item.episode.number
      );
      const resume = byKey.get(key);
      return resume == null ? item : { ...item, resume };
    });
  }, [episodes, watched]);
}
