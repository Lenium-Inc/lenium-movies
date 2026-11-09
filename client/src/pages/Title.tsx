import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import { Bookmark, Check, Film, Play, Star, X } from "lucide-react";
import { Navbar } from "@/components/layout/Navbar";
import {
  APPLY_SEARCH_EVENT,
  SELECT_TITLE_EVENT,
  type PaletteItem,
} from "@/components/layout/NavbarSearch";
import { fetchTrailer, type TrailerInfo } from "@/services/api";
import { fetchMovieMeta, type MovieMeta } from "@/services/meta";
import { savedListIds, subscribeList, toggleListSave } from "@/services/lists";
import { useEmbedFailure } from "@/hooks/useEmbedFailure";
import {
  BACKDROP_IMAGE_SIZES,
  POSTER_IMAGE_SIZES,
  backdropSrcSet,
  optimizedImage,
  posterSrcSet,
} from "@/lib/imageOptimize";
import { resolveTrailer } from "@/lib/tmdbTrailers";
import { TrailerBrandingMask } from "@/components/stream/TrailerBrandingMask";
import { buildTitlePath, buildWatchPath } from "@/lib/watchRoute";
import { publishWatchSeo, resetWatchSeo } from "@/lib/watchSeo";
import { formatRuntime } from "@/lib/format";
import { genreColor } from "@/lib/genreColors";
import type { Movie } from "@/components/movies/types";

function SectionHead({
  id,
  children,
  note,
}: {
  id: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <h2 id={id} className="mw-eyebrow text-white/50">
        {children}
      </h2>
      <span className="h-px flex-1 bg-white/10" aria-hidden />
      {note ? <span className="mw-eyebrow text-white/30">{note}</span> : null}
    </div>
  );
}

export default function TitlePage() {
  const [, navigate] = useLocation();
  const params = useParams();
  const id = params?.id ?? "";
  const search = useSearch();
  const routeQuery = useMemo(() => new URLSearchParams(search || ""), [search]);
  const kind: "movie" | "tv" =
    routeQuery.get("type") === "tv" ? "tv" : "movie";
  /*
   * Resume targeting, carried in the URL by the Continue Watching shelf (and
   * by any other caller that opens a series at a known episode). Every click
   * path now routes through this page, so the season/episode have to survive
   * the detour: they are read here and handed straight to `buildWatchPath` by
   * the Play button. `Number.parseInt` yields NaN when the param is absent or
   * malformed, and NaN is not nullish -- so `NaN ?? 1` would stay NaN and ship
   * `?season=NaN` to the watch route. Coerce to undefined so the route's own
   * S1E1 default applies.
   */
  const resumeSeason = Number.isFinite(Number.parseInt(routeQuery.get("season") ?? "", 10))
    ? Number.parseInt(routeQuery.get("season") ?? "", 10)
    : undefined;
  const resumeEpisode = Number.isFinite(Number.parseInt(routeQuery.get("episode") ?? "", 10))
    ? Number.parseInt(routeQuery.get("episode") ?? "", 10)
    : undefined;

  const [meta, setMeta] = useState<MovieMeta | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">(
    "loading"
  );
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [trailerFrameLoaded, setTrailerFrameLoaded] = useState(false);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  /*
   * Start the expensive parts of playback on the Play control's hover/focus,
   * not on the click. The route chunk, the detail record and the stream walk
   * are all cacheable; doing them a beat early is the difference between a
   * spinner and a first frame that is already there. Every failure is silent:
   * this is a head start, and the watch page owns the real error path.
   */
  const prewarmPlayback = useCallback(() => {
    const movie = meta?.movie;
    if (!movie?.providerId) return;
    void import("@/pages/Watch");
    void import("@/services/api")
      .then(async ({ resolveStream, getStreamSource }) => {
        const resolved = await resolveStream(movie.providerId, movie.year, {
          detailPath: movie.providerId,
          mediaType: movie.mediaType,
        });
        if (!resolved.stream.id) return;
        await getStreamSource({
          tmdbId: resolved.stream.id,
          detailPath: resolved.stream.detail_path || movie.providerId,
          mediaType: movie.mediaType,
          season: movie.mediaType === "tv" ? resumeSeason ?? 1 : undefined,
          episode: movie.mediaType === "tv" ? resumeEpisode ?? 1 : undefined,
        });
      })
      .catch(() => {
        /* the watch page reports a real failure if the viewer plays */
      });
  }, [meta?.movie, resumeSeason, resumeEpisode]);


  useEffect(() => {
    let active = true;
    if (!id) {
      setMeta(null);
      setStatus("missing");
      return;
    }
    setMeta(null);
    setStatus("loading");
    void fetchMovieMeta(id, kind).then(result => {
      if (!active) return;
      if (!result) {
        setStatus("missing");
        return;
      }
      setMeta(result);
      setStatus("ready");
    });
    return () => {
      active = false;
    };
  }, [id, kind]);

  useEffect(() => {
    const movie = meta?.movie;
    if (!movie?.title) {
      setTrailer(null);
      return;
    }
    let active = true;
    setTrailer(null);
    setTrailerOpen(false);
    // The route id is a catalogue slug, so the lookup runs on the loaded
    // title/year rather than passing a MovieBox id to TMDB.
    void fetchTrailer(movie.title, movie.year, movie.mediaType)
      .then(info => {
        if (active) setTrailer(info);
      })
      .catch(() => {
        if (active) setTrailer(null);
      });
    return () => {
      active = false;
    };
  }, [meta?.movie.title, meta?.movie.year, meta?.movie.mediaType]);

  const { failed: trailerFailed, frameRef: trailerFrameRef } = useEmbedFailure(
    trailer ? `${trailer.provider}:${trailer.id}` : null
  );
  const trailerSrc = resolveTrailer(trailer, { loop: false });
  const fullTrailer = useMemo(
    () =>
      resolveTrailer(trailer, {
        loop: false,
        controls: true,
        muted: false,
      }),
    [trailer]
  );

  useEffect(() => {
    setTrailerFrameLoaded(false);
  }, [trailerSrc?.src]);

  useEffect(() => {
    if (!trailerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTrailerOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [trailerOpen]);

  useEffect(() => {
    if (status === "ready" && meta) {
      publishWatchSeo({
        id: meta.movie.providerId,
        title: meta.movie.title,
        description: meta.movie.synopsis || undefined,
        image: meta.movie.backdrop || meta.movie.poster || undefined,
        year: meta.movie.year,
      });
    } else if (status === "missing") {
      publishWatchSeo(null);
    }
  }, [status, meta]);

  useEffect(() => () => resetWatchSeo(), []);

  useEffect(() => {
    const refresh = () => {
      setSaved(meta ? savedListIds().includes(meta.movie.id) : false);
    };
    refresh();
    return subscribeList(refresh);
  }, [meta]);

  useEffect(() => {
    const onSelect = (event: Event) => {
      const item = (event as CustomEvent<PaletteItem | undefined>).detail;
      if (!item || typeof item.id !== "string" || !item.title) return;
      navigate(buildTitlePath(item.id, item.mediaType));
    };
    const onApply = (event: Event) => {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query;
      if (typeof query !== "string") return;
      const trimmed = query.trim();
      navigate(trimmed ? `/?q=${encodeURIComponent(trimmed)}` : "/");
    };
    window.addEventListener(SELECT_TITLE_EVENT, onSelect);
    window.addEventListener(APPLY_SEARCH_EVENT, onApply);
    return () => {
      window.removeEventListener(SELECT_TITLE_EVENT, onSelect);
      window.removeEventListener(APPLY_SEARCH_EVENT, onApply);
    };
  }, [navigate]);

  const toggleMyList = (movie: Movie) => {
    const { saved: next } = toggleListSave({
      id: movie.id,
      title: movie.title,
      year: movie.year,
      poster: movie.poster,
      providerId: movie.providerId,
      backdrop: movie.backdrop,
      mediaType: movie.mediaType,
      score: movie.score,
    });
    setSaved(next);
  };

  return (
    <div className="min-h-screen bg-[#070a14]">
      <Navbar
        view="home"
        onNavigate={to => navigate(to === "home" ? "/" : `/?section=${to}`)}
      />

      {status === "loading" ? (
        <div aria-busy="true" aria-label="Loading title">
          <div className="h-[64vh] min-h-[460px] w-full animate-pulse bg-white/5" />
          <div className="mx-auto max-w-[1480px] px-4 pt-10 sm:px-6 lg:px-8">
            <div className="h-4 w-40 rounded bg-white/10" />
            <div className="mt-4 h-4 w-full max-w-2xl rounded bg-white/10" />
            <div className="mt-3 h-4 w-1/2 max-w-xl rounded bg-white/10" />
            <div className="mt-10 grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className="aspect-[2/3] animate-pulse rounded-md bg-white/5"
                />
              ))}
            </div>
          </div>
        </div>
      ) : status === "missing" || !meta ? (
        <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
          <p className="mw-eyebrow text-white/40">Not in the catalogue</p>
          <h1 className="text-3xl font-bold text-white">
            That title isn&apos;t here.
          </h1>
          <p className="text-sm leading-6 text-[#c5c5c1]">
            The link may be old, or this title hasn&apos;t been imported yet.
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="mt-2 rounded-xl bg-white px-6 py-2.5 text-sm font-bold text-black transition hover:bg-neutral-200"
          >
            Back to the catalogue
          </button>
        </div>
      ) : (
        (() => {
          const movie = meta.movie;
          const similar = meta.similar;
          const cast = movie.castMembers ?? [];
          const facts: Array<{ label: string; value: string | null }> = [
            { label: "Directed by", value: movie.director },
            {
              label: "Starring",
              value: movie.cast.length
                ? movie.cast.slice(0, 3).join(", ")
                : null,
            },
            { label: "Country", value: movie.country },
            { label: "Language", value: movie.language },
            ...(movie.mediaType === "tv" && movie.seasons != null
              ? [{ label: "Seasons", value: String(movie.seasons) }]
              : []),
          ];

          return (
            <>
              <section className="relative h-[64vh] min-h-[460px] w-full overflow-hidden">
                {movie.backdrop ? (
                  <img
                    src={optimizedImage(movie.backdrop, 1280)}
                    srcSet={backdropSrcSet(movie.backdrop)}
                    sizes={BACKDROP_IMAGE_SIZES}
                    alt=""
                    loading="eager"
                    fetchPriority="high"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-[#1B1B20] to-[#0a0a0c]" />
                )}
                {trailerSrc && !trailerFailed ? (
                  <>
                    {!trailerFrameLoaded ? (
                      <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center">
                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                      </div>
                    ) : null}
                    <iframe
                      key="title-trailer-embed"
                      ref={trailerFrameRef}
                      src={trailerSrc.src}
                      onLoad={() => setTrailerFrameLoaded(true)}
                      className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
                        trailerFrameLoaded ? "opacity-100" : "opacity-0"
                      }`}
                      allow="autoplay; encrypted-media"
                      sandbox="allow-scripts allow-same-origin allow-forms"
                      referrerPolicy="strict-origin-when-cross-origin"
                      title={`${movie.title} — ${trailerSrc.label}`}
                    />
                    <TrailerBrandingMask />
                  </>
                ) : null}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] h-3/5 bg-gradient-to-t from-[#070a14] via-[#070a14]/75 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 z-[4] pb-8 sm:pb-12">
                  <div className="mx-auto max-w-[1480px] px-4 sm:px-6 lg:px-8">
                    <p className="mw-eyebrow text-white/60">
                      {movie.mediaType === "tv"
                        ? `Series${
                            movie.seasons != null
                              ? ` · ${movie.seasons} season${
                                  movie.seasons === 1 ? "" : "s"
                                }`
                              : ""
                          }`
                        : "Film"}
                    </p>
                    <h1 className="mt-2 text-4xl font-bold leading-[1.05] text-white drop-shadow-lg sm:text-5xl lg:text-6xl">
                      {movie.title}
                    </h1>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[#c5c5c1]">
                      {movie.year && <span>{movie.year}</span>}
                      {movie.runtime && (
                        <>
                          <span className="text-white/30">·</span>
                          <span>{formatRuntime(movie.runtime)}</span>
                        </>
                      )}
                      {movie.genre.map((genre, index) => (
                        <span key={genre} className="flex items-center">
                          {index > 0 ? (
                            <span className="mr-3 text-white/30">·</span>
                          ) : null}
                          <span
                            className="font-semibold"
                            style={{ color: genreColor(genre) ?? undefined }}
                          >
                            {genre}
                          </span>
                        </span>
                      ))}
                      {movie.score !== null && movie.score > 0 && (
                        <span className="flex items-center gap-1 text-[var(--star)]">
                          <Star className="h-3.5 w-3.5 fill-current" />
                          {movie.score}
                        </span>
                      )}
                    </div>
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onMouseEnter={prewarmPlayback}
                        onFocus={prewarmPlayback}
                        onTouchStart={prewarmPlayback}
                        onClick={() => {
                          prewarmPlayback();
                          navigate(
                            buildWatchPath(movie.providerId, {
                              mediaType: movie.mediaType,
                              // Resume targeting, carried here from the Continue
                              // Watching shelf so "pick this back up" survives
                              // the detour through this page. Ignored for a film.
                              season: resumeSeason,
                              episode: resumeEpisode,
                            })
                          );
                        }}
                        aria-label="Play now"
                        className="flex h-12 w-12 items-center justify-center gap-2 rounded-xl bg-white px-0 py-0 text-sm font-bold text-black shadow-lg shadow-black/30 transition-all hover:bg-neutral-200 active:scale-[0.98] sm:h-auto sm:w-auto sm:px-8 sm:py-3"
                      >
                        <Play className="h-5 w-5 fill-current" />
                        <span className="hidden sm:inline">Play now</span>
                      </button>
                      {trailer && !trailerFailed ? (
                        <button
                          type="button"
                          onClick={() => setTrailerOpen(true)}
                          aria-label="Watch trailer"
                          className="flex h-12 w-12 items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 px-0 py-0 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-white/15 sm:h-auto sm:w-auto sm:px-5 sm:py-3"
                        >
                          <Film className="h-4 w-4" />
                          <span className="hidden sm:inline">Watch trailer</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => toggleMyList(movie)}
                        aria-label={saved ? "Remove from My List" : "Add to My List"}
                        aria-pressed={saved}
                        className="flex h-12 w-12 items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 px-0 py-0 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-white/15 sm:h-auto sm:w-auto sm:px-5 sm:py-3"
                      >
                        {saved ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Bookmark className="h-4 w-4" />
                        )}
                        <span className="hidden sm:inline">
                          {saved ? "In My List" : "Add to My List"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <main className="mx-auto max-w-[1480px] px-4 pb-16 sm:px-6 lg:px-8">
                <section
                  aria-labelledby="title-story"
                  className="grid gap-8 pt-10 md:grid-cols-[1fr_280px]"
                >
                  <div>
                    <SectionHead id="title-story">Story</SectionHead>
                    <p className="mt-4 text-sm leading-7 text-[#c5c5c1]">
                      {movie.synopsis || "No synopsis for this title."}
                    </p>
                  </div>
                  <dl aria-label="Title facts" className="mw-facts self-start">
                    {facts.map(fact => (
                      <div key={fact.label} className="mw-fact">
                        <dt className="mw-eyebrow text-white/40">
                          {fact.label}
                        </dt>
                        <dd className="mt-1 text-sm leading-5 text-[#c5c5c1]">
                          {fact.value ?? <span className="text-white/30">—</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>

                {cast.length > 0 ? (
                  <section aria-labelledby="title-cast" className="mt-12">
                    <SectionHead id="title-cast" note="Top billing">
                      Cast
                    </SectionHead>
                    <ul className="no-scrollbar mt-5 flex snap-x gap-5 overflow-x-auto pb-2">
                      {cast.map(person => (
                        <li
                          key={person.id}
                          className="w-[112px] shrink-0 snap-start text-center"
                        >
                          <a
                            href={`https://www.themoviedb.org/person/${person.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group block focus-visible:outline-none"
                          >
                            <div className="mx-auto aspect-square w-20 overflow-hidden rounded-full border border-white/10 bg-white/5">
                              {person.profilePath ? (
                                <img
                                  src={optimizedImage(person.profilePath, 185)}
                                  alt=""
                                  loading="lazy"
                                  decoding="async"
                                  className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.06]"
                                />
                              ) : (
                                <span className="grid h-full w-full place-items-center text-2xl font-semibold text-white/40">
                                  {person.name.charAt(0)}
                                </span>
                              )}
                            </div>
                            <p className="mt-2.5 truncate text-xs font-semibold text-white/85 transition group-hover:text-white">
                              {person.name}
                            </p>
                            <p className="mw-eyebrow mt-0.5 truncate text-white/35">
                              {person.character || "—"}
                            </p>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {similar.length > 0 ? (
                  <section aria-labelledby="title-similar" className="mt-12">
                    <SectionHead
                      id="title-similar"
                      note={`${similar.length} titles`}
                    >
                      More like this
                    </SectionHead>
                    <div className="mt-5 grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
                      {similar.map(item => (
                        <button
                          key={`${item.mediaType}-${item.providerId}`}
                          type="button"
                          onClick={() =>
                            navigate(
                              buildTitlePath(item.providerId, item.mediaType)
                            )
                          }
                          className="mw-card group rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                        >
                          <div className="relative aspect-[2/3] overflow-hidden rounded-md border border-white/10 bg-black">
                            {item.poster ? (
                              <img
                                src={optimizedImage(item.poster, 342)}
                                srcSet={posterSrcSet(item.poster)}
                                sizes={POSTER_IMAGE_SIZES}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.06]"
                              />
                            ) : (
                              <div className="grid h-full w-full place-items-center bg-gradient-to-br from-[#1B1B20] to-[#0a0a0c]">
                                <span className="text-3xl font-semibold text-white/30">
                                  {item.title.charAt(0)}
                                </span>
                              </div>
                            )}
                            <div className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 transition duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                              <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-black shadow-lg">
                                <Play className="h-4 w-4 fill-current" />
                              </span>
                            </div>
                          </div>
                          <p className="mt-2 truncate text-xs font-semibold text-white/85 transition group-hover:text-white">
                            {item.title}
                          </p>
                          <p className="mw-eyebrow mt-0.5 text-white/35">
                            {item.year ?? "—"}
                          </p>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}

                <p className="mt-12 text-[11px] leading-5 text-[var(--text-muted)]">
                  This product uses the TMDB API but is not endorsed or
                  certified by TMDB.{" "}
                  <a
                    href="https://www.themoviedb.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 transition hover:text-[var(--text)]"
                  >
                    Movie metadata &amp; artwork by TMDB
                  </a>
                  .
                </p>
              </main>

              {trailerOpen && fullTrailer ? (
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label={`${movie.title} trailer`}
                  onClick={() => setTrailerOpen(false)}
                  className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-3 backdrop-blur-sm sm:p-6"
                >
                  <button
                    type="button"
                    onClick={() => setTrailerOpen(false)}
                    aria-label="Close trailer"
                    className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/60 text-white transition hover:bg-white/15 sm:right-6 sm:top-6"
                  >
                    <X className="h-5 w-5" />
                  </button>
                  <div
                    onClick={event => event.stopPropagation()}
                    className="aspect-video w-full max-w-5xl overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl"
                  >
                    <iframe
                      src={fullTrailer.src}
                      title={`${movie.title} — ${fullTrailer.label}`}
                      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                      allowFullScreen
                      className="h-full w-full"
                    />
                  </div>
                </div>
              ) : null}
            </>
          );
        })()
      )}
    </div>
  );
}
