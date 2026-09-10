import { useCallback, useRef, useState } from "react";
import { GlassHeader } from "@/components/layout/GlassHeader";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
import { FilterBar } from "@/components/movies/FilterBar";
import { MediaCard } from "@/components/movies/MediaCard";
import { MovieGrid } from "@/components/movies/MovieGrid";
import { Spotlight } from "@/components/movies/Spotlight";
import { ALL_GENRE, useMovieFilters } from "@/hooks/useMovieFilters";
import { fetchTrailer, type TrailerInfo } from "@/services/api";
import type { Movie } from "@/components/movies/types";

const img = (path: string | null, size: "w342" | "w780" | "w1280") =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

const fmtRuntime = (minutes: number | null): string | null =>
  minutes == null ? null : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

interface PreviewFilm {
  id: number;
  title: string;
  year: number | null;
  runtimeMin: number | null;
  score: number | null;
  genre: string[];
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  region: "Hollywood" | "Bollywood";
}

/** Real TMDB titles — every badge (Year / Runtime / Genres / TMDB rating) is live. */
const previewFilms: PreviewFilm[] = [
  {
    id: 569094,
    title: "Spider-Man: Across the Spider-Verse",
    year: 2023, runtimeMin: 140, score: 8.3,
    genre: ["Sci-Fi", "Action"],
    poster: img("/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg", "w342"),
    backdrop: img("/kVd3a9YeLGkoeR50jGEXM6EqseS.jpg", "w780"),
    overview:
      "After reuniting with Gwen Stacy, Brooklyn's full-time, friendly neighbourhood Spider-Man is catapulted across the Multiverse, where he encounters a team of Spider-People charged with protecting its very existence.",
    region: "Hollywood",
  },
  {
    id: 634649,
    title: "Spider-Man: No Way Home",
    year: 2021, runtimeMin: 148, score: 7.9,
    genre: ["Action", "Sci-Fi"],
    poster: img("/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg", "w342"),
    backdrop: img("/uyrOU4BDm2kbVxFsMiDFIHDhc4d.jpg", "w780"),
    overview:
      "Peter Parker is unmasked and no longer able to separate his normal life from the high-stakes of being a super-hero. When he asks for help from Doctor Strange, the stakes become even more dangerous.",
    region: "Hollywood",
  },
  {
    id: 429617,
    title: "Spider-Man: Far From Home",
    year: 2019, runtimeMin: 129, score: 7.4,
    genre: ["Action", "Sci-Fi"],
    poster: img("/4q2NNj4S5dG2RLF9CpXsej7yXl.jpg", "w342"),
    backdrop: img("/vamhMTvh9m9zFHDoR0v1nRtf6T4.jpg", "w780"),
    overview:
      "Peter Parker and his friends go on a summer trip to Europe. However, they will hardly be able to rest — Peter has to agree to help Nick Fury uncover the mystery of creatures that spawn element attacks.",
    region: "Hollywood",
  },
  {
    id: 10331,
    title: "Night of the Living Dead",
    year: 1968, runtimeMin: 96, score: 7.6,
    genre: ["Thriller"],
    poster: img("/rb2NWyb008u1EcKCOyXs2Nmj0ra.jpg", "w342"),
    backdrop: img("/5KtmBSqFtHY3I9t8lgH27Mc0bqY.jpg", "w780"),
    overview:
      "A ragtag group barricade themselves in an old Pennsylvania farmhouse to remain safe from a horde of flesh-eating ghouls ravaging the countryside.",
    region: "Hollywood",
  },
  {
    id: 16093,
    title: "Carnival of Souls",
    year: 1962, runtimeMin: 78, score: 6.9,
    genre: ["Thriller"],
    poster: img("/AdbQsFB8pS090l0NO3uBtLZy2zw.jpg", "w342"),
    backdrop: img("/esIoQw7VaykfHsw6fx2VltZ1R7U.jpg", "w780"),
    overview:
      "Mary Henry ends up the sole survivor of a fatal car accident through mysterious circumstances. Trying to put the incident behind her, she moves to Utah and takes a job as a church organist.",
    region: "Hollywood",
  },
  {
    id: 653,
    title: "Nosferatu",
    year: 1922, runtimeMin: 94, score: 7.7,
    genre: ["Thriller"],
    poster: img("/zv7J85D8CC9qYagAEhPM63CIG6j.jpg", "w342"),
    backdrop: img("/cA9iGtvjRGJHzDBfrq48l0eyCvA.jpg", "w780"),
    overview:
      "The mysterious Count Orlok summons a happily married real estate agent to his castle, located up in the Transylvanian mountains, to finalise a purchase.",
    region: "Hollywood",
  },
  {
    id: 44977,
    title: "Dhoom 3",
    year: 2013, runtimeMin: 171, score: 6.0,
    genre: ["Action"],
    poster: img("/rUVTM5EQUQ2I0fcfE46AkvBYWae.jpg", "w342"),
    backdrop: img("/m715Fj5VVCXfwzqbCZFhmJBH8S9.jpg", "w780"),
    overview:
      "To avenge his father's death, a circus entertainer trained in magic and acrobatics robs banks to take down a corrupt bank owner. Two cops from Bombay are brought in to hunt him down.",
    region: "Bollywood",
  },
  {
    id: 20453,
    title: "3 Idiots",
    year: 2009, runtimeMin: 171, score: 8.0,
    genre: ["Comedy"],
    poster: img("/66A9MqXOyVFCssoloscw79z8Tew.jpg", "w342"),
    backdrop: img("/8gT3UKtglLVpu0YfccwbmXZ5Eis.jpg", "w780"),
    overview:
      "Two friends are searching for their long-lost companion. They revisit their college days and recall the memories of their friend who inspired them to think differently.",
    region: "Bollywood",
  },
  {
    id: 534780,
    title: "Andhadhun",
    year: 2018, runtimeMin: 139, score: 7.6,
    genre: ["Thriller", "Comedy"],
    poster: img("/dy3K6hNvwE05siGgiLJcEiwgpdO.jpg", "w342"),
    backdrop: img("/ArvKQJv3nEpnBoVyjWDUT7TtJOL.jpg", "w780"),
    overview:
      "A series of mysterious events changes the life of a blind pianist who now must report a crime that was actually never witnessed by him.",
    region: "Bollywood",
  },
  {
    id: 813,
    title: "Airplane!",
    year: 1980, runtimeMin: 88, score: 7.3,
    genre: ["Comedy"],
    poster: img("/7Q3efxd3AF1vQjlSxnlerSA7RzN.jpg", "w342"),
    backdrop: img("/wQyvrsNSTzFVEGgarZbFkFyIciy.jpg", "w780"),
    overview:
      "An ex-fighter pilot forced to take over the controls of an airliner when the flight crew succumbs to food poisoning. A cult comedy classic.",
    region: "Hollywood",
  },
];

/**
 * Fallback demonstration tiles: a broken poster asset and missing metadata.
 * MediaCard degrades them to polished typographic skeleton cards, and the
 * Spotlight's missing backdrop falls back to a gradient — nothing breaks.
 */
const fallbackFilms: PreviewFilm[] = [
  {
    id: 900001,
    title: "Reel from the Vault",
    year: 1985, runtimeMin: null, score: null,
    genre: ["Thriller"],
    poster: null,
    backdrop: null,
    overview: null,
    region: "Hollywood",
  },
  {
    id: 900002,
    title: "Archival Copy 07",
    year: null, runtimeMin: null, score: null,
    genre: ["Thriller"],
    poster: null,
    backdrop: null,
    overview: null,
    region: "Hollywood",
  },
];

const REGIONS = ["All", "Hollywood", "Bollywood"];
const GENRES = ["All", "Sci-Fi", "Thriller", "Action", "Comedy"];

const regionOf = (film: PreviewFilm) => film.region;
const genresOf = (film: PreviewFilm) => film.genre;

function toMovie(film: PreviewFilm): Movie {
  return {
    id: film.id,
    providerId: `tmdb-${film.id}`,
    source: "tmdb",
    mediaType: "movie",
    title: film.title,
    year: film.year,
    runtime: fmtRuntime(film.runtimeMin) ?? "",
    rating: "TBD",
    score: film.score,
    genre: film.genre,
    poster: film.poster,
    backdrop: film.backdrop,
    synopsis: film.overview ?? "",
    director: null,
  };
}

const allFilms = [...previewFilms, ...fallbackFilms];

/**
 * Living demo of the synchronized, real-time filtering engine. The two-tier
 * filter bar (region × genre) drives both the Spotlight hero — which crossfades
 * its backdrop, typography, tags and synopsis to the top filtered title on
 * every change — and the animated MediaCard grid. Cards cross-fade posters into
 * high-res backdrops after 300ms of hover; the last two tiles demonstrate the
 * typographic skeleton fallback for missing assets.
 */
export default function HeroPreview() {
  const [savedIds, setSavedIds] = useState<number[]>([]);

  // Preview trailers resolve at most once per title and are shared through the
  // session, so repeated hovers never re-hit the TMDB-backed endpoint.
  const trailerCache = useRef(new Map<string, Promise<TrailerInfo | null>>());
  const trailerFor = useCallback((film: PreviewFilm) => {
    let pending = trailerCache.current.get(String(film.id));
    if (!pending) {
      pending = fetchTrailer(film.title, film.year).catch(() => null);
      trailerCache.current.set(String(film.id), pending);
    }
    return pending;
  }, []);

  const {
    regions,
    genres,
    region,
    genre,
    setRegion,
    setGenre,
    filtered,
    activeCount,
    total,
  } = useMovieFilters<PreviewFilm>({
    items: allFilms,
    regions: REGIONS,
    genres: GENRES,
    regionOf,
    genresOf,
    initialGenre: ALL_GENRE,
  });

  const spotlightItems = filtered.slice(0, 8).map(toMovie);

  const toggleSave = (id: number) =>
    setSavedIds(current =>
      current.includes(id)
        ? current.filter(value => value !== id)
        : [...current, id]
    );

  const showDetails = (film: Movie) =>
    alert(`${film.title} · ${film.year}\n\n${film.synopsis ?? "No synopsis available."}`);

  return (
    <div className="min-h-screen bg-[#050505] font-sans text-[#FFFFFF]">
      <GlassHeader profile={<ProfileMenu />} /><Spotlight
        items={spotlightItems}
        savedIds={savedIds}
        onSave={film =>
          toggleSave(film.id)
        }
      />
      <main className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6">
        <section aria-labelledby="discover-title" className="mt-12">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/60">
                Discover
              </p>
              <h2
                id="discover-title"
                className="mt-1 text-xl font-bold tracking-tight text-white"
              >
                Filter by region + genre
              </h2>
            </div>
            <p className="text-xs text-[#8E8E93]">
              {activeCount} of {total} titles
            </p>
          </div>

          <div className="mt-4">
            <FilterBar
              regions={regions}
              genres={genres}
              activeRegion={region}
              activeGenre={genre}
              onRegionChange={setRegion}
              onGenreChange={setGenre}
            />
          </div>

          {filtered.length > 0 ? (
            <>
              <MovieGrid className="mt-8">
                {filtered.map(film => (
                  <MediaCard
                    key={film.id}
                    id={String(film.id)}
                    title={film.title}
                    posterUrl={film.poster}
                    backdropUrl={film.backdrop}
                    trailerResolver={
                      film.id < 900000 ? () => trailerFor(film) : undefined
                    }
                    year={film.year}
                    runtime={fmtRuntime(film.runtimeMin)}
                    genres={film.genre}
                    rating={film.score}
                    onPlay={() => showDetails(toMovie(film))}
                  />
                ))}
              </MovieGrid>
            </>
          ) : (
            <div className="mt-8 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center">
              <h3 className="text-sm font-semibold text-[#E5E5EA]">
                No titles match {region} + {genre}
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#8E8E93]">
                Widen the filters to see more of the catalog — the hero and grid
                re-sync the instant you toggle a pill.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}