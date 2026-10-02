/**
 * Local "My List" store tests.
 *
 * This file used to test an embed-consent record that no longer exists: the
 * banner that wrote it is gone, and so is the code that read it. What remains
 * worth testing here is the store the profile hub sorts on, because the
 * contract it has to keep is subtle -- the list is keyed on the *provider* id
 * rather than the local React id, tags are per-entry, and every mutation has to
 * notify subscribers so cards repaint without a reload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Must be first: installs the `window` globals the modules below read at
// module scope.
import { clearStorage } from "@/lib/webStorageStub";
import {
  entryTag,
  isEmptyList,
  isSaved,
  removeFromList,
  savedListIds,
  setEntryTag,
  sortedEntries,
  subscribeList,
  toggleListSave,
} from "./lists";

// The catalog maps a title's numeric id from its provider id (`stableId` in
// useCatalog), so for a TMDB title `id` *is* the TMDB number. Fixtures that
// pair `id: 1` with a real provider id would test a state the app can never be
// in -- the list is keyed on the provider id, so `isSaved(1)` would be asking
// about a title that was never saved.
const MOVIE = {
  id: 60300,
  providerId: "60300",
  title: "The Matrix",
  year: 1999,
  poster: "/poster.jpg",
};

const SERIES = {
  id: 1396,
  providerId: "1396",
  title: "Breaking Bad",
  year: 2008,
  poster: null,
  mediaType: "tv" as const,
};

describe("my list store", () => {
  beforeEach(() => {
    clearStorage();
  });

  it("reports an empty list before anything is saved", () => {
    expect(isEmptyList()).toBe(true);
    expect(savedListIds()).toEqual([]);
  });

  it("saves a title and reports it by its local id", () => {
    expect(toggleListSave(MOVIE).saved).toBe(true);
    expect(isSaved(MOVIE.id)).toBe(true);
    expect(isEmptyList()).toBe(false);
  });

  it("removes a title when toggled a second time", () => {
    toggleListSave(MOVIE);
    expect(toggleListSave(MOVIE).saved).toBe(false);
    expect(isSaved(MOVIE.id)).toBe(false);
    expect(sortedEntries()).toEqual([]);
  });

  it("tags an added title as Plan to Watch", () => {
    // The default is what the profile hub sorts on, and what every "Add to My
    // List" button produces without a tag being chosen.
    toggleListSave(MOVIE);
    expect(entryTag(MOVIE.id)).toBe("plan");
  });

  it("keeps tags per entry", () => {
    toggleListSave(MOVIE);
    toggleListSave(SERIES);
    setEntryTag(SERIES.id, "favorites");

    expect(entryTag(MOVIE.id)).toBe("plan");
    expect(entryTag(SERIES.id)).toBe("favorites");
    expect(sortedEntries("favorites").map(e => e.title)).toEqual([
      "Breaking Bad",
    ]);
  });

  it("filters by tag and returns everything when not filtering", () => {
    toggleListSave(MOVIE);
    toggleListSave(SERIES);
    setEntryTag(SERIES.id, "watched");

    expect(sortedEntries("all")).toHaveLength(2);
    expect(sortedEntries("plan").map(e => e.title)).toEqual(["The Matrix"]);
    expect(sortedEntries("watched").map(e => e.title)).toEqual([
      "Breaking Bad",
    ]);
    // A tag nothing carries must render an empty shelf rather than leaking the
    // whole list into whatever filter the profile happens to be on.
    expect(sortedEntries("favorites")).toEqual([]);
  });

  it("removes an entry without touching the others", () => {
    toggleListSave(MOVIE);
    toggleListSave(SERIES);
    removeFromList(MOVIE.id);

    expect(isSaved(MOVIE.id)).toBe(false);
    expect(sortedEntries().map(e => e.title)).toEqual(["Breaking Bad"]);
  });

  it("notifies subscribers on every mutation", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeList(listener);

    toggleListSave(MOVIE);
    expect(listener).toHaveBeenCalledTimes(1);

    setEntryTag(MOVIE.id, "watched");
    removeFromList(MOVIE.id);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);

    unsubscribe();
    toggleListSave(MOVIE);
    // The unsubscribe has to actually stop the notifications, or a card that
    // unmounted would keep a live subscription for the rest of the session.
    const calls = listener.mock.calls.length;
    toggleListSave(SERIES);
    expect(listener).toHaveBeenCalledTimes(calls);
  });
});
