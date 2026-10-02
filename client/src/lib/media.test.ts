import { describe, expect, it } from "vitest";
import { playbackId, stableId, toMovie } from "./media";

describe("stableId", () => {
  it("passes a numeric id through untouched", () => {
    expect(stableId("603")).toBe(603);
  });

  it("folds non-numeric ids deterministically", () => {
    expect(stableId("archive-thing")).toBe(stableId("archive-thing"));
    expect(stableId("archive-thing")).toBeGreaterThan(0);
  });

  it("does not collide the way a length-based hash would", () => {
    // Two ids of the same length that differ only in their characters have to
    // land on different keys: they share one My List, and colliding silently
    // saves one title in place of the other.
    expect(stableId("aaaaaaaa")).not.toBe(stableId("bbbbbbbb"));
  });
});

describe("playbackId", () => {
  it("prefers the TMDB id so playback resolves against it", () => {
    expect(playbackId({ id: "archive-x", tmdb_id: 603 })).toBe("603");
  });

  it("falls back to the provider id when there is no TMDB id", () => {
    expect(playbackId({ id: "archive-x" })).toBe("archive-x");
    expect(playbackId({ id: 42 })).toBe("42");
  });

  it("does not treat an empty tmdb_id as present", () => {
    // `""` is falsy but not null, so a naive `!= null` check would resolve
    // playback against an empty id.
    expect(playbackId({ id: "archive-x", tmdb_id: "" })).toBe("archive-x");
  });
});

describe("toMovie", () => {
  const card = {
    id: "603",
    media_type: "movie",
    title: "The Matrix",
    year: "1999",
    overview: "A hacker learns the truth.",
    poster_url: "https://img/p.jpg",
    backdrop_url: "https://img/b.jpg",
    vote_average: 8.7,
    genres: ["Action", "Sci-Fi"],
  };

  it("maps the common card shape", () => {
    const movie = toMovie(card);
    expect(movie.title).toBe("The Matrix");
    expect(movie.year).toBe(1999);
    expect(movie.mediaType).toBe("movie");
    expect(movie.genre).toEqual(["Action", "Sci-Fi"]);
    expect(movie.score).toBe(8.7);
    expect(movie.poster).toBe("https://img/p.jpg");
  });

  it("reads a year off release_date when there is no year field", () => {
    const movie = toMovie({ ...card, year: null, release_date: "1999-03-30" });
    expect(movie.year).toBe(1999);
  });

  it("labels an untyped card by its media type rather than inventing a genre", () => {
    expect(toMovie({ ...card, genres: [] }).genre).toEqual(["Movie"]);
    expect(toMovie({ ...card, media_type: "tv", genres: null }).genre).toEqual([
      "Series",
    ]);
  });

  it("leaves an absent overview empty instead of inventing copy", () => {
    // The old mappers wrote "Playable right now - pick it to start watching."
    // into this field, which every unrated card then rendered as if it were the
    // title's own description.
    expect(toMovie({ ...card, overview: "" }).synopsis).toBe("");
    expect(toMovie({ ...card, overview: undefined }).synopsis).toBe("");
  });

  it("keeps an absent score null rather than zero", () => {
    // Zero is a real rating and would render as "0.0" next to a title nobody
    // has rated; null lets the card omit it.
    expect(toMovie({ ...card, vote_average: null }).score).toBeNull();
    expect(toMovie({ ...card, vote_average: 0 }).score).toBe(0);
  });

  it("accepts both the *_url and *_path field spellings", () => {
    const movie = toMovie({
      ...card,
      poster_url: null,
      backdrop_url: null,
      poster_path: "/p.jpg",
      backdrop_path: "/b.jpg",
    });
    expect(movie.poster).toBe("/p.jpg");
    expect(movie.backdrop).toBe("/b.jpg");
  });

  it("falls back to name for series payloads that do not carry title", () => {
    expect(
      toMovie({
        ...card,
        media_type: "tv",
        title: undefined,
        name: "Severance",
      }).title
    ).toBe("Severance");
  });
});
