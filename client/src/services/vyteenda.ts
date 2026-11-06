/**
 * Vyteenda's local decision log.
 *
 * The deck is a Tinder-style discovery surface over the same catalogue the
 * shelves read. A heart is a match and writes the title to My List; a pass
 * writes nothing but must still be remembered, or the next visit deals the same
 * rejected film first. Neither decision belongs to the account: there is no
 * endpoint for "titles this viewer swiped past", and inventing one would put a
 * second, subtly different list in the product. localStorage is the same store
 * the anonymous list already uses, so it is the honest place for it.
 *
 * The log is an ordered journal rather than two sets because Undo needs the
 * last decision and whether it *added* the title (as opposed to finding it
 * already saved). A set cannot answer either question.
 */

const STORAGE_KEY = "freestream-vyteenda-v1";
const MAX_DECISIONS = 500;
const LISTENERS = new Set<() => void>();

export type VyteendaAction = "like" | "pass";

export interface VyteendaDecision {
  /** The backend/provider id, which is also the My List key. */
  key: string;
  action: VyteendaAction;
  /** True when this heart is what put the title in My List. */
  added: boolean;
  at: number;
}

interface StoredDeck {
  decisions: VyteendaDecision[];
}

function read(): VyteendaDecision[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<StoredDeck> | null;
    const decisions = parsed?.decisions;
    if (!Array.isArray(decisions)) return [];
    return decisions.filter(
      (entry): entry is VyteendaDecision =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof entry.key === "string" &&
        entry.key.length > 0 &&
        (entry.action === "like" || entry.action === "pass") &&
        typeof entry.at === "number"
    );
  } catch {
    return [];
  }
}

function write(decisions: VyteendaDecision[]): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = decisions.slice(-MAX_DECISIONS);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ decisions: trimmed } satisfies StoredDeck)
    );
  } catch {
    // Storage disabled or full: the deck still works for this visit.
  }
  LISTENERS.forEach(listener => listener());
}

export function getDecisions(): VyteendaDecision[] {
  return read();
}

export function decidedKeys(): Set<string> {
  return new Set(read().map(entry => entry.key));
}

export function recordDecision(
  key: string,
  action: VyteendaAction,
  added = false
): VyteendaDecision {
  const decisions = read().filter(entry => entry.key !== key);
  const decision: VyteendaDecision = { key, action, added, at: Date.now() };
  decisions.push(decision);
  write(decisions);
  return decision;
}

/** The most recent decision, for Undo. */
export function lastDecision(): VyteendaDecision | null {
  const decisions = read();
  return decisions.length ? decisions[decisions.length - 1] : null;
}

/** Pop the most recent decision and return it, or null when the log is empty. */
export function popDecision(): VyteendaDecision | null {
  const decisions = read();
  const decision = decisions.pop() ?? null;
  if (decision) write(decisions);
  return decision;
}

export function resetDecisions(): void {
  write([]);
}

export function subscribeDecisions(listener: () => void): () => void {
  LISTENERS.add(listener);
  return () => LISTENERS.delete(listener);
}
