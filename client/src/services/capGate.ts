/**
 * Single gateway every playback entry point passes through. Enforces the
 * daily mindful viewing cap (8/day) before a title ever mounts a player.
 */
import { DAILY_LIMIT, playsToday, recordPlay } from "./stats";

type Listener = (locked: boolean, count: number) => void;

const listeners = new Set<Listener>();

function current(): { locked: boolean; count: number } {
  const count = playsToday();
  return { count, locked: count >= DAILY_LIMIT };
}

function emit(): void {
  const { locked, count } = current();
  listeners.forEach(fn => fn(locked, count));
}

export function subscribeCap(listener: Listener): () => void {
  listeners.add(listener);
  listener(current().locked, current().count);
  return () => listeners.delete(listener);
}

export function dayLocked(): boolean {
  return current().locked;
}

export function dayCount(): number {
  return current().count;
}

export function capLimit(): number {
  return DAILY_LIMIT;
}

/** Register a play attempt. Returns true when playback may proceed. */
export function attemptPlay(): boolean {
  const { locked } = recordPlay();
  emit();
  return !locked;
}