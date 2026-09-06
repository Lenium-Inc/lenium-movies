/**
 * Personal rating log. A half-star-scale score per title, rendered back as a
 * chronological "Rating & Review" list in the profile.
 */
import type { Movie } from "@/components/movies/types";

export interface RatingEntry {
  id: number;
  rating: number; // 0.5 .. 5, 0.5 steps
  title: string;
  year: number | null;
  poster: string | null;
  ratedAt: string;
}

const KEY = "freestream-ratings-v1";

function loadRatings(): Record<number, RatingEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const map: Record<number, RatingEntry> = {};
    for (const [, value] of Object.entries(JSON.parse(raw) as Record<string, RatingEntry>)) {
      if (value && typeof value.id === "number") map[value.id] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function saveRatings(ratings: Record<number, RatingEntry>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ratings));
    window.dispatchEvent(new CustomEvent("freestream:ratings"));
  } catch {
    /* storage unavailable */
  }
}

/** The viewer's score for a title, or null when not rated. */
export function getRating(id: number): number | null {
  return loadRatings()[id]?.rating ?? null;
}

/** Rate a title (0.5–5); passing `0` removes the rating. */
export function setRating(movie: Movie, rating: number): void {
  const ratings = loadRatings();
  const clamped = Math.round(Math.max(0, Math.min(5, rating)) * 2) / 2;
  if (clamped <= 0) {
    delete ratings[movie.id];
  } else {
    ratings[movie.id] = {
      id: movie.id,
      rating: clamped,
      title: movie.title,
      year: movie.year,
      poster: movie.poster,
      ratedAt: new Date().toISOString(),
    };
  }
  saveRatings(ratings);
}

export function removeRating(id: number): void {
  const ratings = loadRatings();
  delete ratings[id];
  saveRatings(ratings);
}

/** Most recent ratings first — the profile's rating & review log. */
export function ratingLog(): RatingEntry[] {
  return Object.values(loadRatings()).sort((a, b) =>
    b.ratedAt.localeCompare(a.ratedAt)
  );
}

export function subscribeRatings(listener: () => void): () => void {
  window.addEventListener("freestream:ratings", listener);
  return () => window.removeEventListener("freestream:ratings", listener);
}