/**
 * Regression tests for the My List fixes.
 *
 * The crash tests below are the important ones: each writes deliberately
 * malformed state into storage and asserts that reading it back does not throw.
 * `getMyList` is called from a `useState` initialiser on the home page and
 * directly during MyList's render, so anything it throws happens *during
 * render* and takes out the whole page via the error boundary.
 */
import { beforeEach, describe, expect, it } from "vitest";
// Must be first: installs the `window` globals the module below reads at
// module scope.
import { clearStorage, stubStorage } from "@/lib/webStorageStub";
import {
  getMyList,
  isInMyList,
  addToMyList,
  removeFromMyList,
  toggleMyList,
  initializeSession,
} from "./localSession";

const LIST_KEY = "freestream-list-v1";
const SESSION_KEY = "freestream-session-v1";

describe("localSession list reads", () => {
  beforeEach(() => {
    clearStorage();
  });

  it("returns an empty list when nothing is stored", () => {
    expect(getMyList()).toEqual([]);
  });

  it("survives syntactically invalid JSON", () => {
    stubStorage.setItem(LIST_KEY, "{not json");
    expect(getMyList()).toEqual([]);
  });

  it("survives a stored list containing null entries", () => {
    // The exact shape that used to throw a TypeError inside the sort
    // comparator: Object.values yields [null] and the comparator read
    // `a.addedAt` off it.
    stubStorage.setItem(
      LIST_KEY,
      JSON.stringify({ a: null, b: { id: 2, title: "Real" } })
    );
    expect(() => getMyList()).not.toThrow();
    const list = getMyList();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Real");
  });

  it("survives entries that are not objects", () => {
    stubStorage.setItem(
      LIST_KEY,
      JSON.stringify({ a: "string", b: 42, c: ["array"], d: { id: 4, title: "Ok" } })
    );
    expect(() => getMyList()).not.toThrow();
    expect(getMyList().map(e => e.title)).toEqual(["Ok"]);
  });

  it("survives a non-object list root", () => {
    for (const raw of ["null", "123", '"hello"', "[]", "true"]) {
      stubStorage.setItem(LIST_KEY, raw);
      expect(() => getMyList(), `raw=${raw}`).not.toThrow();
      expect(getMyList()).toEqual([]);
    }
  });

  it("drops entries with no id and backfills a missing title", () => {
    stubStorage.setItem(
      LIST_KEY,
      JSON.stringify({ a: { title: "No id" }, b: { id: 7 } })
    );
    const list = getMyList();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(7);
    expect(list[0].title).toBe("Untitled");
  });

  it("isInMyList tolerates corrupt storage", () => {
    stubStorage.setItem(LIST_KEY, JSON.stringify({ a: null }));
    expect(() => isInMyList(1)).not.toThrow();
    expect(isInMyList(1)).toBe(false);
  });
});

describe("localSession list writes", () => {
  beforeEach(() => {
    clearStorage();
  });

  it("round-trips an add, a check and a remove", () => {
    addToMyList({ id: 1, title: "Dune" });
    expect(isInMyList(1)).toBe(true);
    expect(getMyList()[0].title).toBe("Dune");
    removeFromMyList(1);
    expect(isInMyList(1)).toBe(false);
  });

  it("toggleMyList reports the new state", () => {
    expect(toggleMyList({ id: 2, title: "Arrival" })).toBe(true);
    expect(toggleMyList({ id: 2, title: "Arrival" })).toBe(false);
  });

  it("keys on providerId so a remote row can be matched back", () => {
    addToMyList({ id: 7, providerId: "1580190", title: "The Scavenger" });
    // The account row is keyed on the TMDB id; the local list has to agree or
    // syncSavedFromRemote re-adds the title on every visit.
    expect(isInMyList(1580190)).toBe(true);
  });

  it("repairs corrupt storage on the next write", () => {
    stubStorage.setItem(LIST_KEY, JSON.stringify({ a: null }));
    expect(() => addToMyList({ id: 9, title: "Fixed" })).not.toThrow();
    expect(getMyList().every(e => e && typeof e === "object")).toBe(true);
  });
});

describe("session hydration", () => {
  beforeEach(() => {
    clearStorage();
  });

  it("hydrates when the session key is absent", () => {
    expect(initializeSession().hydrated).toBe(true);
  });

  it("hydrates when a stored session lacks the hydrated flag", () => {
    // The permanent-spinner bug: the provider calls this once, so returning
    // hydrated:false here left /my-list on its loading state forever.
    stubStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ user: null, isAuthenticated: false })
    );
    expect(initializeSession().hydrated).toBe(true);
  });

  it("hydrates when the stored session has a non-boolean flag", () => {
    stubStorage.setItem(SESSION_KEY, JSON.stringify({ hydrated: "yes" }));
    expect(initializeSession().hydrated).toBe(true);
  });

  it("still honours an explicit hydrated:false", () => {
    stubStorage.setItem(SESSION_KEY, JSON.stringify({ hydrated: false }));
    expect(initializeSession().hydrated).toBe(false);
  });
});
