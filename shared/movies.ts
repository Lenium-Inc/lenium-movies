export type SearchableMovie = {
  title: string;
  genre: string[];
  director: string;
};

export function matchesMovieSearch(movie: SearchableMovie, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${movie.title} ${movie.genre.join(" ")} ${movie.director}`.toLowerCase().includes(normalized);
}
