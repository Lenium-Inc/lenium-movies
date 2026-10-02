import { useCallback, useEffect, useMemo, useState } from "react";
import { continueWatching } from "@/services/history";
import { subscribeStats } from "@/services/stats";
import { apiHistory, type RemoteHistoryItem } from "@/services/auth";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import { parseProgressKey } from "@/lib/progressKey";
import type { Movie } from "@/components/movies/types";

/**
 * The Continue Watching shelf.
 *
 * Two sources, because neither is complete on its own:
 *
 * 1. The account's watch history (`/api/auth/history`), which the watch page
 *    writes on every title it opens. Per profile, so two people sharing a
 *    device get their own queue, and it follows the viewer to any device.
 * 2. The local progress engine, for a signed-out viewer, who has no account to
 *    write history to.
 *
 * They are merged and deduplicated on the title key, newest first, and a title
 * that is more than 60% watched is dropped: past that point it is a title that
 * has been seen, not one to resume.
 */

const RESUME_CEILING = 0.6;
const SHELF_SIZE = 20;

/** Card-shaped projection of a title the viewer has started but not finished. */
function toResumeMovie(entry: {
  key: string;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
  fraction: number;
  at: number;
}): Movie {
  // The card resolves `providerId` with `parseInt` and builds the watch route
  // from it, so the episode-qualified key must not be handed over as the id --
  // it would parse to the show and silently reopen S01E01. The episode travels in
  // `resumeSeason`/`resumeEpisode` instead.
  const parts = parseProgressKey(entry.key);
  return {
    id: Number(parts?.id ?? entry.key) || 0,
    providerId: parts?.id ?? entry.key,
    title: entry.title,
    year: entry.year,
    runtime: null,
    rating: null,
    score: null,
    genre: [entry.mediaType === "tv" ? "Series" : "Movie"],
    poster: entry.poster,
    backdrop: entry.backdrop,
    synopsis: "",
    director: null,
    cast: [],
    country: null,
    language: null,
    releaseDate: null,
    source: "tmdb",
    mediaType: entry.mediaType,
    vote_average: undefined,
    // Carried on the card itself so the shelf can show a resume bar without
    // MovieRow needing to know anything about watch history.
    resume: entry.fraction,
    resumeSeason: entry.season,
    resumeEpisode: entry.episode,
  };
}

function fromRemote(item: RemoteHistoryItem) {
  const duration = item.duration_seconds ?? 0;
  const progress = item.progress_seconds ?? 0;
  const fraction = duration > 0 ? progress / duration : 0;
  const key = String(item.movie_key ?? "");
  const parts = parseProgressKey(key);
  return {
    key,
    // The episode lives in the key, because `watch_history` has no season or
    // episode column: the server stores `movie_key` opaquely and this is the
    // only place the information still exists.
    season: parts?.season,
    episode: parts?.episode,
    title: item.title || "Untitled",
    year: item.year ?? null,
    poster: item.poster ?? null,
    backdrop: item.backdrop ?? null,
    mediaType: (item.media_type === "tv" ? "tv" : "movie") as "movie" | "tv",
    fraction,
    at: item.watched_at ?? 0,
  };
}

export interface ContinueWatchingShelf {
  items: Movie[];
  loading: boolean;
  refresh: () => void;
}

export function useContinueWatching(): ContinueWatchingShelf {
  const { user } = useAuth();
  const { activeProfile } = useActiveProfile();
  const profileId = activeProfile ? String(activeProfile.id) : null;
  const [remote, setRemote] = useState<RemoteHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  // Bumped by the stats subscription: a title finished in the player has to
  // appear here without a reload, which is the whole point of the shelf.
  const [progressTick, setProgressTick] = useState(0);

  const refresh = useCallback(() => setProgressTick(t => t + 1), []);

  useEffect(() => subscribeStats(() => setProgressTick(t => t + 1)), []);

  useEffect(() => {
    // Signed out there is no history to read; the local engine below is the
    // only queue, and asking the server for one would just 401.
    if (!user) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiHistory(profileId)
      .then(items => {
        if (!cancelled) setRemote(Array.isArray(items) ? items : []);
      })
      .catch(() => {
        if (!cancelled) setRemote([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, profileId]);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const merged: Array<Parameters<typeof toResumeMovie>[0]> = [];

    for (const item of remote) {
      const entry = fromRemote(item);
      // A key with no addressable id cannot be turned into a watch route, and a
      // title with no progress at all has nothing to resume.
      if (!parseProgressKey(entry.key)) continue;
      if (entry.fraction <= 0 || entry.fraction > RESUME_CEILING) continue;
      seen.add(entry.key);
      merged.push(entry);
    }

    for (const item of continueWatching()) {
      if (seen.has(item.id)) continue;
      if (!parseProgressKey(item.id)) continue;
      if (item.fraction <= 0 || item.fraction > RESUME_CEILING) continue;
      seen.add(item.id);
      merged.push({
        key: item.id,
        title: item.title,
        year: item.year ?? null,
        poster: item.poster ?? null,
        backdrop: null,
        // Recorded per play now. Records written before the field existed carry
        // no type, and defaulting those to "movie" is the safe answer: a film
        // route with a TMDB id still opens, while a series typed as a film does
        // not.
        mediaType: item.mediaType ?? "movie",
        season: item.season,
        episode: item.episode,
        fraction: item.fraction,
        at: item.t,
      });
    }

    // One card per show, newest first.
    //
    // Progress is now stored per episode, so a viewer halfway through a season
    // has a record per episode -- and three cards of the same show, two of them
    // pointing at episodes they have moved on from, is noise on a shelf whose
    // whole job is to say "pick this one back up". The newest episode is the one
    // being watched, so it is the one that wins the slot.
    const byRecency = merged.sort((a, b) => b.at - a.at);
    const shelf: typeof byRecency = [];
    const shown = new Set<string>();
    for (const entry of byRecency) {
      const showId = parseProgressKey(entry.key)?.id;
      if (!showId || shown.has(showId)) continue;
      shown.add(showId);
      shelf.push(entry);
      if (shelf.length === SHELF_SIZE) break;
    }
    return shelf.map(toResumeMovie);
    // `progressTick` is the invalidation signal for the local engine, which
    // reads straight from storage and has no subscription of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, progressTick]);

  return { items, loading, refresh };
}

export default useContinueWatching;
