/**
 * Tagged "My List" store. Each saved title carries a curation tag
 * (Plan to Watch / Favorites / Watched) that the profile hub sorts on.
 * Persisted under `freestream-list-v1` and broadcast via a DOM event.
 */

export type ListTag = "plan" | "favorites" | "watched";

export interface ListEntry {
  id: number;
  tag: ListTag;
  addedAt: string;
  title: string;
  year: number | null;
  poster: string | null;
}

const KEY = "freestream-list-v1";

export const LIST_TAGS: { value: ListTag; label: string }[] = [
  { value: "plan", label: "Plan to Watch" },
  { value: "favorites", label: "Favorites" },
  { value: "watched", label: "Watched" },
];

function loadList(): Record<number, ListEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ListEntry>;
    const map: Record<number, ListEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.id === "number") map[value.id] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function saveList(entries: Record<number, ListEntry>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
    window.dispatchEvent(new CustomEvent("freestream:list"));
  } catch {
    /* storage unavailable */
  }
}

export function savedListIds(): number[] {
  return Object.keys(loadList()).map(Number);
}

export function isSaved(id: number): boolean {
  return id in loadList();
}

export function entryTag(id: number): ListTag | undefined {
  return loadList()[id]?.tag;
}

export function isEmptyList(): boolean {
  return Object.keys(loadList()).length === 0;
}

/** Toggle a title in the list, defaulting to "Plan to Watch" on add. */
export function toggleListSave(entry: {
  id: number;
  title: string;
  year: number | null;
  poster: string | null;
}): { saved: boolean; tag: ListTag } {
  const entries = loadList();
  if (entries[entry.id]) {
    delete entries[entry.id];
    saveList(entries);
    return { saved: false, tag: "plan" };
  }
  entries[entry.id] = {
    ...entry,
    tag: "plan",
    addedAt: new Date().toISOString(),
  };
  saveList(entries);
  return { saved: true, tag: "plan" };
}

export function setEntryTag(id: number, tag: ListTag): void {
  const entries = loadList();
  if (entries[id]) {
    entries[id] = { ...entries[id], tag };
    saveList(entries);
  }
}

export function removeFromList(id: number): void {
  const entries = loadList();
  delete entries[id];
  saveList(entries);
}

/** Saved titles newest-first, with the picked tag or a default. */
export function sortedEntries(
  filter: ListTag | "all" = "all"
): ListEntry[] {
  return Object.values(loadList())
    .filter(e => filter === "all" || e.tag === filter)
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

export function subscribeList(listener: () => void): () => void {
  window.addEventListener("freestream:list", listener);
  return () => window.removeEventListener("freestream:list", listener);
}