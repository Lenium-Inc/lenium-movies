/**
 * Continue Watching queue, derived from the mindful stats engine's per-title
 * progress. Titles with at least 35 seconds watched and no more than ~60% of
 * the runtime appear here so the viewer can jump back in — anything past that
 * counts as an episode seen, anything below is a stray tap. Respects the
 * watch-history master switch: when it is off this queue stays empty.
 */
import {
  clearAllProgress,
  clearProgress,
  getProgress,
  getProgressFraction,
  lastWatchedList,
  type WatchMeta,
} from "./stats";
import { historyEnabled } from "./settings";

export interface ContinueItem extends WatchMeta {
  id: string;
  fraction: number;
  t: number;
}

/**
 * The floor for a title to be worth resuming: 35 seconds of actually watched
 * time. An accidental tap opens a title and records a handful of seconds --
 * that is a mis-click, not a viewing, and a shelf of mis-clicks is noise.
 * The server-sourced half of the queue applies the same number to its
 * `progress_seconds`, so both sources agree on what "started watching" means.
 */
export const RESUME_MIN_SECONDS = 35;

export function continueWatching(): ContinueItem[] {
  if (!historyEnabled()) return [];
  const records = lastWatchedList();
  const items: ContinueItem[] = [];
  for (const [id, record] of Object.entries(records)) {
    const fraction = getProgressFraction(id);
    if (fraction <= 0 || fraction > 0.6) continue;
    if (getProgress(id) < RESUME_MIN_SECONDS) continue;
    items.push({ id, ...record, fraction, t: record.t });
  }
  return items.sort((a, b) => b.t - a.t);
}

export function removeFromHistory(id: string): void {
  clearProgress(id);
}

export function clearHistory(): void {
  clearAllProgress();
}
