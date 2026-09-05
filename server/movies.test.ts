import { describe, expect, it } from "vitest";
import { matchesMovieSearch } from "../shared/movies";

describe("matchesMovieSearch", () => {
  const movie = {
    title: "Afterlight",
    genre: ["Sci-fi", "Drama"],
    director: "Mara Voss",
  };

  it("matches title, genre, and director text case-insensitively", () => {
    expect(matchesMovieSearch(movie, "after")).toBe(true);
    expect(matchesMovieSearch(movie, "SCI-FI")).toBe(true);
    expect(matchesMovieSearch(movie, "mara voss")).toBe(true);
  });

  it("matches an empty query and rejects unrelated text", () => {
    expect(matchesMovieSearch(movie, "   ")).toBe(true);
    expect(matchesMovieSearch(movie, "comedy")).toBe(false);
  });
});
