/**
 * "Remind me" store for titles that have not come out yet.
 *
 * The catalogue already knows a title's release date (`Movie.releaseDate`), so
 * a viewer can ask to be told when it lands. That answer is theirs and belongs
 * on their machine, not in an account: it is one boolean per title, it works
 * signed-out, and the site ships no analytics or push service that could
 * deliver a real notification anyway. So this is a local list that the bell in
 * the nav reads, and nothing here promises a message on a channel the product
 * does not have.
 *
 * Storage follows the `freestream-*` family and is a NEW key, so no existing
 * saved data is touched. Timestamps are epoch milliseconds; release dates are
 * kept as the catalogue's `YYYY-MM-DD` string and compared in UTC, because a
 * date-only value parsed in local time is a day off for half the world.
 */
import type { Movie } from "@/components/movies/types";

export interface Reminder {
  /** Provider (catalogue) id, the same key My List uses. */
  id: string;
  title: string;
  poster: string | null;
  /** `YYYY-MM-DD`, straight from the catalogue. */
  releaseDate: string;
  mediaType: "movie" | "tv";
  /** Epoch ms, for a stable newest-first tiebreak. */
  createdAt: number;
}

const KEY = "freestream-reminders-v1";
const EVENT = "freestream:reminders";

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach(fn => fn());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

function read(): Reminder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Guard the shape at the only place storage is read: a hand-edited or
    // half-written entry must not reach the bell's render and throw.
    return parsed.filter((entry): entry is Reminder => {
      return (
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.title === "string" &&
        typeof entry.releaseDate === "string"
      );
    });
  } catch {
    return [];
  }
}

function write(list: Reminder[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    notify();
  } catch {
    /* quota / privacy mode — reminders degrade silently */
  }
}

/** Every reminder, soonest release first. */
export function getReminders(): Reminder[] {
  return read().sort((a, b) => {
    const delta = a.releaseDate.localeCompare(b.releaseDate);
    return delta !== 0 ? delta : b.createdAt - a.createdAt;
  });
}

export function isReminded(id: string | number): boolean {
  const key = String(id);
  return read().some(entry => entry.id === key);
}

/** Add or remove a reminder. Returns the resulting state (true = set). */
export function toggleReminder(movie: {
  providerId?: string | null;
  id: number | string;
  title: string;
  poster?: string | null;
  releaseDate: string;
  mediaType: "movie" | "tv";
}): boolean {
  const key = String(movie.providerId ?? movie.id);
  const list = read();
  const index = list.findIndex(entry => entry.id === key);
  if (index >= 0) {
    list.splice(index, 1);
    write(list);
    return false;
  }
  list.push({
    id: key,
    title: movie.title,
    poster: movie.poster ?? null,
    releaseDate: movie.releaseDate,
    mediaType: movie.mediaType,
    createdAt: Date.now(),
  });
  write(list);
  return true;
}

export function removeReminder(id: string | number): void {
  const key = String(id);
  write(read().filter(entry => entry.id !== key));
}

export function clearReminders(): void {
  write([]);
}

export function subscribeReminders(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) notify();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/** Whole days from today (UTC) until a `YYYY-MM-DD` date; NaN if unparseable. */
export function daysUntil(releaseDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(releaseDate);
  if (!match) return NaN;
  const target = Date.UTC(+match[1], +match[2] - 1, +match[3]);
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return Math.round((target - today) / 86_400_000);
}

/** A title is "upcoming" while its release day is still ahead of us. */
export function isUpcoming(releaseDate: string | null | undefined): boolean {
  if (!releaseDate) return false;
  const days = daysUntil(releaseDate);
  return Number.isFinite(days) && days > 0;
}

/**
 * Release date as prose. `UTC` is pinned so the rendered day matches the
 * catalogue's date in every timezone, and a bad value falls back to the raw
 * string rather than "Invalid Date".
 */
export function formatReleaseDate(
  releaseDate: string,
  options: { month: "long" | "short" } = { month: "long" }
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(releaseDate);
  if (!match) return releaseDate;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.toLocaleDateString(undefined, {
    month: options.month,
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Short form for a button label, e.g. "16 Dec". */
export function formatReleaseShort(releaseDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(releaseDate);
  if (!match) return releaseDate;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Month and day without the year, e.g. "December 16" — the frame's big line. */
export function formatReleaseMonthDay(releaseDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(releaseDate);
  if (!match) return releaseDate;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The watch artboard's countdown label: "Coming in 68 days". Empty string when
 * the date is unparseable, so the frame can fall back to the plain date.
 */
export function releaseCountdownLabel(releaseDate: string): string {
  const days = daysUntil(releaseDate);
  if (!Number.isFinite(days) || days < 0) return "";
  if (days === 0) return "Coming today";
  if (days === 1) return "Coming in 1 day";
  return `Coming in ${days} days`;
}

/** The reminder a `Movie` would create, or null when it has no date. */
export function reminderFor(movie: Movie): Reminder | null {
  if (!movie.releaseDate) return null;
  return {
    id: String(movie.providerId ?? movie.id),
    title: movie.title,
    poster: movie.poster ?? null,
    releaseDate: movie.releaseDate,
    mediaType: movie.mediaType,
    createdAt: 0,
  };
}
