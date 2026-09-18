/**
 * Continue Watching queue, derived from the mindful stats engine's per-title
 * progress. Titles with more than a few seconds and no more than ~60% watched
 * appear here so the viewer can jump back in — anything past that counts as an
 * episode seen. Respects the watch-history master switch: when it is off this
 * queue stays empty.
 */
import {
  clearAllProgress,
  clearProgress,
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

export function continueWatching(): ContinueItem[] {
  if (!historyEnabled()) return [];
  const records = lastWatchedList();
  const items: ContinueItem[] = [];
  for (const [id, record] of Object.entries(records)) {
    const fraction = getProgressFraction(id);
    if (fraction > 0 && fraction <= 0.6) {
      items.push({ id, ...record, fraction, t: record.t });
    }
  }
  return items.sort((a, b) => b.t - a.t);
}

export function removeFromHistory(id: string): void {
  clearProgress(id);
}

export function clearHistory(): void {
  clearAllProgress();
}
