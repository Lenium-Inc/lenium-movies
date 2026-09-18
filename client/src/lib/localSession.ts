import type { Movie } from "@/components/movies/types";

export type LocalUser = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl?: string | null;
  mode: "local-demo";
};

export type SessionState = {
  user: LocalUser | null;
  isAuthenticated: boolean;
  hydrated: boolean;
};

export type MovieSummary = {
  id: number | string;
  providerId?: string | null;
  title: string;
  year?: number | null;
  poster?: string | null;
  backdrop?: string | null;
  mediaType?: "movie" | "tv";
  score?: number | null;
};

export type WatchHistoryItem = MovieSummary & {
  watchedAt: number;
  progressSeconds?: number;
  durationSeconds?: number;
  completed?: boolean;
};

const STORAGE_KEYS = {
  session: "freestream-session-v1",
  list: "freestream-list-v1",
  history: "freestream-history-v1",
  preferences: "freestream-prefs-v1",
  ratings: "freestream-ratings-v1",
  stats: "freestream-stats-v1",
  account: "freestream-account-v1",
  user: "freestream_user",
} as const;

const DEFAULT_LOCAL_USER: LocalUser = {
  id: "local-viewer",
  displayName: "Viewer",
  email: "viewer@freestream.app",
  avatarUrl: null,
  mode: "local-demo",
};

function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(
      new CustomEvent("freestream:state-change", {
        detail: { key },
      })
    );
  } catch (error) {
    console.error("Failed to persist local FreeStream state", error);
  }
}

export function getMovieKey(movie: {
  id?: string | number | null;
  providerId?: string | number | null;
}): string {
  return String(movie.providerId ?? movie.id ?? "");
}

function loadSession(): SessionState {
  return readStorage<SessionState>(STORAGE_KEYS.session, {
    user: null,
    isAuthenticated: false,
    hydrated: true,
  });
}

function saveSession(state: SessionState): void {
  writeStorage(STORAGE_KEYS.session, state);
}

function loadList(): MovieSummary[] {
  return readStorage<MovieSummary[]>(STORAGE_KEYS.list, []);
}

function saveList(list: MovieSummary[]): void {
  writeStorage(STORAGE_KEYS.list, list);
}

function loadHistory(): WatchHistoryItem[] {
  return readStorage<WatchHistoryItem[]>(STORAGE_KEYS.history, []);
}

function saveHistory(history: WatchHistoryItem[]): void {
  writeStorage(STORAGE_KEYS.history, history);
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key && Object.values(STORAGE_KEYS).includes(e.key as any)) {
      notify();
    }
  });

  window.addEventListener("freestream:state-change", () => {
    notify();
  });
}

function migrateLegacyKeys(): void {
  const migrationMarker = "freestream-local-migration-v2";
  if (localStorage.getItem(migrationMarker)) return;

  try {
    const oldAccount = localStorage.getItem("freestream-account-v1");
    const oldList = localStorage.getItem("freestream-list-v1");
    const oldUser = localStorage.getItem("freestream_user");
    const oldRatings = localStorage.getItem("freestream-ratings-v1");
    const oldStats = localStorage.getItem("freestream-stats-v1");
    const oldPrefs = localStorage.getItem("freestream-prefs-v1");

    if (oldUser && !localStorage.getItem(STORAGE_KEYS.session)) {
      try {
        const parsed = JSON.parse(oldUser);
        if (parsed && parsed.id && parsed.name && parsed.email) {
          saveSession({
            user: {
              id: parsed.id,
              displayName: parsed.name,
              email: parsed.email,
              avatarUrl: parsed.avatar_url ?? null,
              mode: "local-demo",
            },
            isAuthenticated: true,
            hydrated: true,
          });
        }
      } catch {
        // ignore parse errors
      }
    } else if (oldAccount && !localStorage.getItem(STORAGE_KEYS.session)) {
      saveSession({
        user: DEFAULT_LOCAL_USER,
        isAuthenticated: true,
        hydrated: true,
      });
    }

    if (oldList && !localStorage.getItem(STORAGE_KEYS.list)) {
      try {
        const parsed = JSON.parse(oldList) as Record<string, any>;
        const movies: MovieSummary[] = Object.values(parsed).map((entry) => ({
          id: entry.id,
          providerId: String(entry.id),
          title: entry.title,
          year: entry.year,
          poster: entry.poster,
          mediaType: "movie",
          score: null,
        }));
        saveList(movies);
      } catch {
        // ignore parse errors
      }
    }

    localStorage.setItem(migrationMarker, "true");
  } catch {
    // migration failed, continue with fresh state
  }
}

export function initializeSession(): SessionState {
  if (typeof window === "undefined") {
    return { user: null, isAuthenticated: false, hydrated: false };
  }

  migrateLegacyKeys();

  const session = loadSession();

  if (!session.hydrated) {
    return { user: null, isAuthenticated: false, hydrated: false };
  }

  if (!session.user && !session.isAuthenticated) {
    saveSession({
      user: DEFAULT_LOCAL_USER,
      isAuthenticated: true,
      hydrated: true,
    });
    return {
      user: DEFAULT_LOCAL_USER,
      isAuthenticated: true,
      hydrated: true,
    };
  }

  return session;
}

export function signInDemo(): void {
  saveSession({
    user: DEFAULT_LOCAL_USER,
    isAuthenticated: true,
    hydrated: true,
  });
  notify();
}

export function signOut(): void {
  saveSession({
    user: null,
    isAuthenticated: false,
    hydrated: true,
  });
  notify();
}

export function getSession(): SessionState {
  return loadSession();
}

export function isInMyList(movieId: string | number): boolean {
  const list = loadList();
  const key = getMovieKey({ id: movieId, providerId: movieId });
  return list.some((m) => getMovieKey(m) === key);
}

export function addToMyList(movie: MovieSummary): void {
  const list = loadList();
  const key = getMovieKey(movie);
  if (list.some((m) => getMovieKey(m) === key)) return;
  saveList([movie, ...list]);
  notify();
}

export function removeFromMyList(movieId: string | number): void {
  const list = loadList();
  const key = getMovieKey({ id: movieId, providerId: movieId });
  saveList(list.filter((m) => getMovieKey(m) !== key));
  notify();
}

export function toggleMyList(movie: MovieSummary): boolean {
  const list = loadList();
  const key = getMovieKey(movie);
  const exists = list.some((m) => getMovieKey(m) === key);
  if (exists) {
    removeFromMyList(movie.id);
    return false;
  }
  addToMyList(movie);
  return true;
}

export function getMyList(): MovieSummary[] {
  return loadList();
}

export function addToHistory(item: WatchHistoryItem): void {
  const history = loadHistory();
  const key = getMovieKey(item);
  const next = [
    { ...item, watchedAt: Date.now() },
    ...history.filter((entry) => getMovieKey(entry) !== key),
  ].slice(0, 100);
  saveHistory(next);
  notify();
}

export function removeFromHistory(movieId: string | number): void {
  const history = loadHistory();
  const key = getMovieKey({ id: movieId, providerId: movieId });
  saveHistory(history.filter((entry) => getMovieKey(entry) !== key));
  notify();
}

export function clearHistory(): void {
  saveHistory([]);
  notify();
}

export function getHistory(): WatchHistoryItem[] {
  return loadHistory();
}

export { subscribe, STORAGE_KEYS };