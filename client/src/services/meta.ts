/**
 * Metadata for a title, without resolving anything playable.
 *
 * The catalogue's `/detail/{slug}` record already carries everything the
 * details sheet, the watch-page header and the title page draw: synopsis,
 * artwork, genres, cast and the season/episode counts. What it does not carry
 * is a neighbours wall, so `fetchMovieMeta` derives that from the home shelves
 * -- the same curated feed -- rather than asking the backend for a second
 * endpoint it does not have.
 *
 * This stays separate from `services/api.ts` for the original reason: the
 * player imports the API module, and importing the player from every consumer
 * of a director's name would drag hls.js and dash.js into bundles that never
 * play anything.
 */

import {
  getDetail,
  getHome,
  type MovieBoxDetail,
  type MovieBoxItem,
  type MovieBoxSubject,
} from "@/services/streamvy";
import {
  tmdbEnabled,
  tmdbHomeSections,
  tmdbTitleDetails,
  type TmdbTitleDetails,
} from "@/services/tmdb";
import type {
  CastMember,
  Movie,
  SimilarItem,
} from "@/components/movies/types";

/** What the metadata call answers: one title's record plus its neighbours. */
export interface MovieMeta {
  movie: Movie;
  similar: SimilarItem[];
}

/**
 * A stable numeric id for React keys and legacy list storage.
 *
 * MovieBox subject ids exceed `Number.MAX_SAFE_INTEGER`, so they cannot be used
 * as numbers. The route handle (`providerId`) is the identity that matters;
 * this is only the numeric slot the existing UI types still require, built from
 * the low digits so it stays reasonably unique without pretending to be exact.
 */
function numericId(subjectId: string): number {
  const digits = subjectId.replace(/\D/g, "");
  const tail = digits.slice(-12);
  const parsed = Number.parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function yearFromDate(date: string | undefined): number | null {
  if (!date) return null;
  const match = date.match(/\d{4}/);
  if (!match) return null;
  const year = Number.parseInt(match[0], 10);
  return Number.isFinite(year) ? year : null;
}

function genresFromSubject(subject: MovieBoxSubject): string[] {
  return (subject.genre ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
}

function isDirector(star: NonNullable<MovieBoxDetail["stars"]>[number]): boolean {
  return star.staffType === 2 || /director/i.test(star.character ?? "");
}

function mapCastMembers(stars: MovieBoxDetail["stars"]): CastMember[] {
  if (!Array.isArray(stars)) return [];
  return stars
    .filter(star => !isDirector(star))
    .map(star =>
      star.name?.trim()
        ? {
            id: star.staffId?.trim() || star.name.trim(),
            name: star.name.trim(),
            character: star.character?.trim() || "",
            profilePath: star.avatarUrl?.trim() || null,
          }
        : null
    )
    .filter((member): member is CastMember => member !== null);
}

function runtimeMinutes(duration: unknown): number | null {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  // MovieBox reports seconds for films. A value under 300 is already minutes
  // (or an unknown short), so leave it alone rather than turning a 90-minute
  // film into a 1.5-minute one.
  return duration > 300 ? Math.round(duration / 60) : Math.round(duration);
}

function mapDetail(
  detail: MovieBoxDetail,
  kind: "movie" | "tv",
  handle?: string
): Movie {
  const subject = detail.subject;
  const mediaType = subject.subjectType === 2 ? "tv" : kind === "tv" ? "tv" : "movie";
  const stars = Array.isArray(detail.stars) ? detail.stars : [];
  const castMembers = mapCastMembers(stars);
  const cast = stars
    .filter(star => !isDirector(star))
    .map(star => star.name?.trim())
    .filter((name): name is string => Boolean(name));
  const director =
    stars.find(isDirector)?.name?.trim() || null;
  const score = Number(subject.imdbRatingValue);
  const stills =
    typeof subject.stills === "string"
      ? subject.stills
      : subject.stills?.url;

  return {
    id: numericId(subject.subjectId),
    providerId:
      subject.detailPath?.trim() || handle?.trim() || subject.subjectId,
    subjectId: subject.subjectId?.trim() || null,
    title: subject.title?.trim() || detail.metadata?.title?.trim() || "Untitled",
    year: yearFromDate(subject.releaseDate),
    runtime: runtimeMinutes(subject.duration),
    rating: null,
    score: Number.isFinite(score) && score > 0 ? score : null,
    genre: genresFromSubject(subject),
    poster: subject.cover?.url?.trim() || null,
    backdrop: stills?.trim() || subject.cover?.url?.trim() || null,
    synopsis:
      subject.description?.trim() || detail.metadata?.description?.trim() || "",
    director,
    cast,
    castMembers,
    country: subject.countryName?.trim() || null,
    language: null,
    releaseDate: subject.releaseDate?.trim() || null,
    source: "tmdb",
    mediaType,
    ...(mediaType === "tv"
      ? {
          seasons:
            detail.resource?.seasons?.reduce(
              (max, block) => Math.max(max, block.se),
              0
            ) || 1,
          episodes_per_season:
            detail.resource?.seasons?.reduce(
              (max, block) => Math.max(max, block.maxEp),
              0
            ) || 1,
        }
      : {}),
  };
}

function similarFromItem(
  item: MovieBoxItem,
  mediaType: "movie" | "tv"
): SimilarItem | null {
  const slug = item.slug?.trim();
  if (!slug) return null;
  return {
    providerId: slug,
    mediaType,
    title: item.name?.trim() || slug,
    year:
      typeof item.year === "number"
        ? item.year
        : yearFromDate(String(item.year ?? "")),
    poster: item.poster_url?.trim() || null,
    score:
      typeof item.rating === "number"
        ? item.rating
        : Number(item.rating) || null,
    synopsis: "",
  };
}

/**
 * A neighbours wall from the curated home shelves.
 *
 * The section name is the only media-kind signal a card carries, so a series
 * detail keeps its wall to series sections. Titles that share a genre with the
 * open record are ranked first; the rest pad the wall rather than leaving a
 * one-row gap for an obscure title.
 */
async function similarTitles(
  detail: MovieBoxDetail,
  mediaType: "movie" | "tv"
): Promise<SimilarItem[]> {
  try {
    const home = await getHome();
    const ownGenres = new Set(
      genresFromSubject(detail.subject).map(genre => genre.toLowerCase())
    );
    const candidates: { item: SimilarItem; rank: number }[] = [];
    const seen = new Set<string>([detail.subject.subjectId]);

    for (const section of home.sections ?? []) {
      const label = section.section.toLowerCase();
      const sectionType: "movie" | "tv" =
        label.includes("series") ||
        label.includes("show") ||
        label.includes("drama") ||
        label.includes("anime") ||
        label.includes("animation")
          ? "tv"
          : "movie";
      if (sectionType !== mediaType) continue;

      const sectionGenres = label.split(/[^a-z-]+/);
      const sharesGenre = sectionGenres.some(genre => ownGenres.has(genre));

      for (const item of section.items ?? []) {
        const slug = item.slug?.trim();
        const subjectId = item.subject_id?.trim();
        if (!slug || (subjectId && seen.has(subjectId))) continue;
        if (subjectId) seen.add(subjectId);
        const similar = similarFromItem(item, mediaType);
        if (similar) candidates.push({ item: similar, rank: sharesGenre ? 0 : 1 });
      }
    }

    return candidates
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 18)
      .map(entry => entry.item);
  } catch {
    return [];
  }
}

/**
 * A TMDB record as the title page's `Movie`.
 *
 * This is the details-page half of the catalogue fallback: the cards on the
 * home page may have come from TMDB while the media API was down, and opening
 * one should still show its title, artwork and synopsis rather than the raw id.
 */
function mapTmdbDetails(details: TmdbTitleDetails): Movie {
  return {
    id: details.id,
    providerId: String(details.id),
    title: details.title,
    year: details.year,
    runtime: details.runtime,
    rating: null,
    score: details.score,
    genre: details.genres,
    poster: details.poster_url || null,
    backdrop: details.backdrop_url || details.poster_url || null,
    synopsis: details.overview,
    director: details.director,
    cast: details.cast,
    castMembers: [],
    country: null,
    language: null,
    releaseDate: details.release_date,
    source: "tmdb",
    mediaType: details.mediaType,
    ...(details.mediaType === "tv"
      ? {
          seasons: details.seasons ?? 1,
          episodes_per_season: details.episodes_per_season ?? 1,
        }
      : {}),
    ...(details.score !== null ? { vote_average: details.score } : {}),
    genres: details.genres,
    overview: details.overview,
  };
}

/** Neighbours for a fallback title, taken from the cached TMDB shelves. */
async function tmdbSimilarTitles(
  mediaType: "movie" | "tv"
): Promise<SimilarItem[]> {
  try {
    const sections = await tmdbHomeSections();
    const seen = new Set<string>();
    const similar: SimilarItem[] = [];
    for (const section of sections) {
      if (section.mediaType !== mediaType) continue;
      for (const movie of section.movies) {
        if (seen.has(movie.id)) continue;
        seen.add(movie.id);
        similar.push({
          providerId: movie.id,
          mediaType,
          title: movie.title,
          year: movie.year ?? null,
          poster: movie.poster_url || null,
          score: movie.vote_average ?? null,
          synopsis: movie.overview ?? "",
        });
        if (similar.length >= 18) return similar;
      }
    }
    return similar;
  } catch {
    return [];
  }
}

/**
 * Full metadata plus a similar-titles wall, without resolving a stream.
 *
 * `handle` is the detail slug (the route param); a subject id works only when
 * it has already been seen on a card, because the live API answers
 * `/detail/{subject_id}` with a 502.
 */
export async function fetchMovieMeta(
  handle: string,
  kind: "movie" | "tv" = "movie"
): Promise<MovieMeta | null> {
  try {
    const detail = await getDetail(handle);
    const movie = mapDetail(detail, kind, handle);
    const similar = await similarTitles(detail, movie.mediaType);
    return { movie, similar };
  } catch {
    // A numeric handle is a TMDB id from the fallback catalogue. Anything else
    // (a MovieBox slug or a 19-digit subject id) has no TMDB record to ask for.
    if (!tmdbEnabled()) return null;
    try {
      const details = await tmdbTitleDetails(handle, kind);
      if (!details) return null;
      const movie = mapTmdbDetails(details);
      const similar = await tmdbSimilarTitles(movie.mediaType);
      return { movie, similar };
    } catch {
      return null;
    }
  }
}

/** Metadata only. Kept for callers that do not need the neighbours wall. */
export async function fetchMovieDetails(
  handle: string,
  kind: "movie" | "tv" = "movie"
): Promise<Movie | null> {
  const meta = await fetchMovieMeta(handle, kind);
  return meta ? meta.movie : null;
}
