/**
 * Mindful-viewing stats engine: daily viewing cap (8/day), hours watched,
 * per-title progress, and a monochrome achievement system. Persisted to
 * localStorage so everything survives reloads on the viewer's machine.
 */
import {
  Award,
  Clock3,
  Eye,
  Film,
  Hourglass,
  MoonStar,
  Stars,
  type LucideIcon,
} from "lucide-react";
import { historyEnabled } from "./settings";

export const DAILY_LIMIT = 8;

export interface Achievement {
  id: string;
  title: string;
  copy: string;
  icon: LucideIcon;
  hint: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: "first-frame",
    title: "First Frame",
    copy: "Welcome to the mindful cinema. Breathe in, press play.",
    icon: Film,
    hint: "Watch your first title",
  },
  {
    id: "hour-1",
    title: "1 Hour Explored",
    copy: "A mindful start — one hour behind you.",
    icon: Clock3,
    hint: "Reach 1 hour watched",
  },
  {
    id: "hour-5",
    title: "5 Hours Immersed",
    copy: "Deep focus unlocked. Keep it steady.",
    icon: Hourglass,
    hint: "Reach 5 hours watched",
  },
  {
    id: "hour-10",
    title: "10 Hours Explored",
    copy: "Mindful Viewer — a real cinematic habit.",
    icon: Stars,
    hint: "Reach 10 hours watched",
  },
  {
    id: "hour-25",
    title: "25 Hours Absorbed",
    copy: "True cinéphile territory now.",
    icon: MoonStar,
    hint: "Reach 25 hours watched",
  },
  {
    id: "series-finisher",
    title: "Series Finisher",
    copy: "Immersed in a season — a film fully seen.",
    icon: Award,
    hint: "Complete a title",
  },
  {
    id: "eye-open",
    title: "Wakeful",
    copy: "You opened your eyes cinema.",
    icon: Eye,
    hint: "Open a title",
  },
];

export interface Stats {
  playsByDay: Record<string, number>;
  allTimePlays: number;
  watchSeconds: number;
  /** Seconds watched per stream id (title progress). */
  progress: Record<string, number>;
  /** Fraction (0..1) of each title watched; used for progress bars. */
  progressFraction: Record<string, number>;
  completedCount: number;
  earned: string[];
  /** Most recent play per stream id — powers the Continue Watching queue. */
  lastWatched: Record<
    string,
    { t: number; title: string; poster: string | null; year: number | null }
  >;
}

const KEY = "freestream-stats-v1";

const DEFAULTS: Stats = {
  playsByDay: {},
  allTimePlays: 0,
  watchSeconds: 0,
  progress: {},
  progressFraction: {},
  completedCount: 0,
  earned: [],
  lastWatched: {},
};

function load(): Stats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Stats>;
    return {
      ...DEFAULTS,
      ...parsed,
      playsByDay: parsed.playsByDay ?? {},
      progress: parsed.progress ?? {},
      progressFraction: parsed.progressFraction ?? {},
      earned: Array.isArray(parsed.earned) ? parsed.earned : [],
      lastWatched: parsed.lastWatched ?? {},
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(data: Stats): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("freestream:stats"));
    }
  } catch {
    /* quota / privacy mode — stats degrade silently */
  }
}

export function todayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function hoursWatched(): number {
  return load().watchSeconds / 3600;
}

export function getProgress(id: string): number {
  return load().progress[id] ?? 0;
}

export function getProgressFraction(id: string): number {
  return load().progressFraction[id] ?? 0;
}

/** Watch seconds for a title across every stream id that shares its name. */
export function progressForTitle(title: string): number {
  const data = load();
  let total = 0;
  for (const [id, entry] of Object.entries(data.lastWatched)) {
    if (entry.title === title) {
      total += data.progress[id] ?? 0;
    }
  }
  if (total > 0) return total;
  for (const id of Object.keys(data.progress)) {
    const entry = data.lastWatched[id];
    if (entry && entry.title === title) total += data.progress[id] ?? 0;
  }
  return total;
}

/** Continue Watching snapshot — most recently played titles and their state. */
export function lastWatchedList(): Stats["lastWatched"] {
  return load().lastWatched;
}

export function playsToday(): number {
  return load().playsByDay[todayKey()] ?? 0;
}

export interface CapResult {
  count: number;
  locked: boolean;
}

/**
 * Register a play attempt. Every attempt beyond the daily limit is refused —
 * the lock message shows `8/8` even as more attempts land.
 */
export function recordPlay(): CapResult {
  const data = load();
  const key = todayKey();
  const count = data.playsByDay[key] ?? 0;
  if (count >= DAILY_LIMIT) {
    save(data);
    return { count, locked: true };
  }
  data.playsByDay[key] = count + 1;
  data.allTimePlays += 1;
  save(data);
  return { count: count + 1, locked: false };
}

/** Seconds until the daily counter resets at local midnight. */
export function secondsToReset(): number {
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  );
  return Math.max(0, Math.round((midnight.getTime() - now.getTime()) / 1000));
}

function newlyEarned(data: Stats): string[] {
  const earned = new Set(data.earned);
  const gained: string[] = [];
  const check = (id: string, condition: boolean) => {
    if (condition && !earned.has(id)) gained.push(id);
  };
  check("first-frame", data.allTimePlays >= 1);
  check("hour-1", data.watchSeconds >= 3600);
  check("hour-5", data.watchSeconds >= 5 * 3600);
  check("hour-10", data.watchSeconds >= 10 * 3600);
  check("hour-25", data.watchSeconds >= 25 * 3600);
  check("series-finisher", data.completedCount >= 1);
  data.earned = Array.from(new Set([...data.earned, ...gained]));
  return gained;
}

export interface WatchMeta {
  title: string;
  poster: string | null;
  year: number | null;
}

/**
 * Accumulate watch time for a title and possibly complete it (once more than
 * 60% of its runtime has been spent watching — an episode counts as soon as
 * the viewer stays past that point). Returns the ids of any achievements that
 * were just earned. The mindful counter (hours watched) always accrues;
 * per-title progress, the completion counter, and the Continue Watching queue
 * only update while the viewer has watch-history enabled.
 */
export function recordWatch(
  id: string,
  seconds: number,
  durationSeconds?: number,
  meta?: WatchMeta
): string[] {
  const data = load();
  data.watchSeconds += Math.max(0, seconds);
  if (id && seconds > 0 && historyEnabled()) {
    const before = data.progress[id] ?? 0;
    data.progress[id] = before + seconds;
    if (durationSeconds && durationSeconds > 0) {
      data.progressFraction[id] = Math.min(
        1,
        Math.max(data.progressFraction[id] ?? 0, before / durationSeconds)
      );
    }
    if (
      durationSeconds &&
      before <= durationSeconds * 0.6 &&
      data.progress[id] > durationSeconds * 0.6
    ) {
      data.completedCount += 1;
    }
    data.lastWatched[id] = {
      t: Date.now(),
      title: meta?.title ?? id,
      poster: meta?.poster ?? null,
      year: meta?.year ?? null,
    };
  }
  const gained = newlyEarned(data);
  save(data);
  return gained;
}

/** Reset the daily play counter (clears today's cap). */
export function resetDailyLimit(): void {
  const data = load();
  data.playsByDay = {};
  save(data);
}

/** Drop a title's progress and Continue Watching entry (privacy clear-one). */
export function clearProgress(id: string): void {
  const data = load();
  delete data.progress[id];
  delete data.progressFraction[id];
  delete data.lastWatched[id];
  save(data);
}

/** Drop progress + Continue Watching for every watched title (Clear All). */
export function clearAllProgress(): void {
  const data = load();
  data.progress = {};
  data.progressFraction = {};
  data.lastWatched = {};
  save(data);
}

export function earnedAchievements(): Achievement[] {
  const data = load();
  return ACHIEVEMENTS.filter(a => data.earned.includes(a.id));
}

export function nextMilestone(): {
  current: number;
  target: number;
  fraction: number;
} | null {
  const data = load();
  const targets = [3600, 5 * 3600, 10 * 3600, 25 * 3600];
  const next = targets.find(t => data.watchSeconds < t);
  if (!next) return null;
  return {
    current: data.watchSeconds,
    target: next,
    fraction: Math.min(1, data.watchSeconds / next),
  };
}

export function subscribeStats(listener: () => void): () => void {
  window.addEventListener("freestream:stats", listener);
  return () => window.removeEventListener("freestream:stats", listener);
}
