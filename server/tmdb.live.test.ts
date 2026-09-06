import { describe, expect, it } from "vitest";
import { getMovieById, searchMovies } from "./providers/tmdb";

describe("TMDB live credential", () => {
  it("authenticates against the lightweight configuration endpoint", async () => {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) throw new Error("TMDB_API_KEY is not available to the test process");

    const response = await fetch(
      `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`,
    );

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { images?: unknown };
    expect(payload.images).toBeDefined();
  }, 15_000);

  it("fetches real search results and normalized movie metadata", async () => {
    const results = await searchMovies("Inception", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ source: "tmdb" });
    expect(results[0]?.providerId).toBeTruthy();
    expect(results[0]?.title).toContain("Inception");

    const movie = await getMovieById(Number(results[0]?.providerId));
    expect(movie.source).toBe("tmdb");
    expect(movie.providerId).toBe(results[0]?.providerId);
    expect(movie.title).toContain("Inception");
    expect(movie.genre.length).toBeGreaterThan(0);
  }, 15_000);
});
