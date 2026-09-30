/**
 * Server-backed taste recording.
 *
 * The client used to keep its own affinity model in sessionStorage. That
 * version was per-browser and per-tab: it never reached the server, so it could
 * not rank the catalogue (which is fetched server-side) and it disappeared when
 * the tab closed. The weights now live in one place server-side, which is also
 * what makes them consistent across the watch page and the home feed.
 *
 * Everything in this module is deliberately fire-and-forget. Personalisation is
 * never allowed to interfere with playback, so a failed write is dropped
 * silently: the worst case is a feed that is not personalised, not a video that
 * will not start.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiRecommendationEval,
  apiRecommendations,
  apiTaste,
  type RecommendationEval,
  type RecommendationResponse,
  type TasteKind,
} from "@/services/auth";
import { useAuth } from "@/context/AuthContext";

/** The subset of a movie the model reads. Mirrors `affinity.ts`'s SignalSource. */
export interface TasteSignals {
  genre?: readonly string[] | null;
  genres?: readonly string[] | null;
  cast?: readonly string[] | null;
  director?: string | null;
}

export type TasteRecorder = (
  kind: TasteKind,
  signals?: TasteSignals,
  extra?: { query?: string; weight?: number }
) => void;

export interface TasteFeedState {
  data: RecommendationResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export interface TasteEvalState {
  data: RecommendationEval | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Normalise to a plain lowercase string list, dropping blanks and duplicates. */
function cleanList(values: readonly string[] | null | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim().toLowerCase();
    // Dedupe by hand rather than with a Set: spreading a Set needs
    // downlevelIteration, and this file is compiled to an older target.
    if (trimmed && out.indexOf(trimmed) === -1) out.push(trimmed);
  }
  return out;
}

// A write bus for "taste changed". A module-level emitter, like the saved-list
// one, because the recorder is handed to effects and handlers as a stable
// callback and cannot carry a React setState with it. Without this the "For You"
// row kept showing the ranking computed before the viewer's latest signals.
const tasteListeners: Array<() => void> = [];

/** Subscribe to taste writes from anywhere in the app. Returns an unsubscribe. */
export function subscribeTaste(listener: () => void): () => void {
  tasteListeners.push(listener);
  return () => {
    const at = tasteListeners.indexOf(listener);
    if (at >= 0) tasteListeners.splice(at, 1);
  };
}

/**
 * Build a recorder for one profile.
 *
 * Returns a no-op when there is no user or profile, so callers do not need to
 * branch. A signed-out viewer still gets the plain catalogue, which is the
 * intended behaviour rather than a degraded one.
 */
export function useTasteRecorder(profileId: string | number | null): TasteRecorder {
  const { user } = useAuth();
  // The recorder is handed to effects and event handlers, so it has to be
  // stable: rebuilding it on every render would re-run the "record the play"
  // effect below and double-count every title.
  const userId = user ? String(user.id) : null;
  const ref = useRef<{ userId: string | null; profileId: string | number | null }>({
    userId,
    profileId,
  });
  ref.current = { userId, profileId };

  return useCallback<TasteRecorder>(
    (kind, signals, extra) => {
      const { userId: uid, profileId: pid } = ref.current;
      if (!uid || pid === null || pid === undefined) return;
      const genres = cleanList(signals?.genre ?? signals?.genres);
      // Director and cast are stored in one `people` column server-side; the
      // weight difference is applied by the model, not by the caller.
      const people = [
        ...cleanList(signals?.cast),
        ...(signals?.director ? [signals.director.trim().toLowerCase()] : []),
      ];
      void apiTaste({
        profile_id: pid,
        kind,
        genres,
        people,
        query: extra?.query,
        weight: extra?.weight,
      })
        .then(() => {
          // Only announce a write that landed. A failed one has not changed the
          // ranking, so reloading on it would just be a wasted request.
          for (const listener of tasteListeners.slice()) listener();
        })
        .catch(() => {
          // See the module comment: never let taste recording break playback.
        });
    },
    []
  );
}

/**
 * Ranked catalogue for the active profile.
 *
 * The endpoint answers signed-out and profile-less callers with the unranked
 * list and `personalised: false`, so this hook simply does not fetch without a
 * profile -- there is nothing to rank and one fewer request per page load.
 *
 * `personalised` is checked rather than assumed by the caller, because a profile
 * with no history yet also gets the untouched upstream list and labelling that
 * as personalised would be a lie the UI repeats.
 */
export function useTasteFeed(
  profileId: string | number | null,
  options: { kind?: "trending" | "popular" | "now_playing"; page?: number; limit?: number } = {}
): TasteFeedState {
  const { user } = useAuth();
  const { kind = "trending", page = 1, limit = 20 } = options;
  const userId = user ? String(user.id) : null;
  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Re-rank when anything records a signal, so a viewer who just watched
  // something sees the effect of it rather than the previous profile state.
  useEffect(() => subscribeTaste(() => setNonce((n) => n + 1)), []);

  useEffect(() => {
    if (!userId || profileId === null || profileId === undefined) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiRecommendations({ profile_id: profileId, kind, page, limit })
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        setError(err instanceof Error ? err.message : "Could not load picks.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, profileId, kind, page, limit, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}

/** Held-out evaluation for the active profile. Not shown to viewers. */
export function useTasteEval(profileId: string | number | null): TasteEvalState {
  const { user } = useAuth();
  const userId = user ? String(user.id) : null;
  const [data, setData] = useState<RecommendationEval | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!userId || profileId === null || profileId === undefined) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiRecommendationEval(profileId)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        setError(err instanceof Error ? err.message : "Could not evaluate the model.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, profileId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
