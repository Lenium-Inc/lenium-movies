import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearch, Link } from "wouter";
import { ArrowLeft, Check, Download, Loader2, Play, Smartphone } from "lucide-react";
import { ANDROID_APP_URL } from "@/lib/androidApp";
import { isNativeApp } from "@/lib/native";
import { canPlayNative, playNative, watchDeepLink } from "@/lib/nativePlayback";
import { optimizedImage } from "@/lib/imageOptimize";
import { buildTitlePath } from "@/lib/watchRoute";
import { fetchMovieDetails } from "@/services/meta";
import type { Movie } from "@/components/movies/types";

/**
 * The website's playback boundary.
 *
 * Full playback is not possible in a browser: MovieBox's CDN rejects requests
 * without its own player-page Referer and a Chromium TLS fingerprint. Rather
 * than pretend, the web route is the hand-off to the Android app. The app sends
 * the catalogue ids to a native WebView player instead of loading the web
 * player at all.
 */
export default function WatchGate() {
  const params = useParams<{ id: string }>();
  const search = useSearch();
  const detailPath = params.id ? decodeURIComponent(params.id) : "";
  const query = useMemo(() => new URLSearchParams(search || ""), [search]);
  const urlType = query.get("type") === "tv" ? "tv" : "movie";
  const season = Math.max(1, Number.parseInt(query.get("season") || "1", 10) || 1);
  const episode = Math.max(
    1,
    Number.parseInt(query.get("episode") || "1", 10) || 1
  );

  const [movie, setMovie] = useState<Movie | null>(null);
  const [loading, setLoading] = useState(true);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launchRef = useRef<string | null>(null);
  const native = isNativeApp();

  useEffect(() => {
    let alive = true;
    if (!detailPath) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchMovieDetails(detailPath, urlType)
      .then(result => {
        if (alive) setMovie(result);
      })
      .catch(() => {
        if (alive) setMovie(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [detailPath, urlType]);

  useEffect(() => {
    if (!native || !canPlayNative() || !movie) return;
    if (!movie.subjectId) {
      setError("This title has no app playback id yet. Try another title.");
      return;
    }

    const nativeSeason = movie.mediaType === "tv" ? season : 0;
    const nativeEpisode = movie.mediaType === "tv" ? episode : 0;
    const key = `${movie.subjectId}:${nativeSeason}:${nativeEpisode}`;
    if (launchRef.current === key) return;
    launchRef.current = key;
    setError(null);
    setLaunched(false);

    void playNative({
      subjectId: movie.subjectId,
      detailPath: movie.providerId || detailPath,
      season: nativeSeason,
      episode: nativeEpisode,
      title: movie.title,
    })
      .then(() => setLaunched(true))
      .catch(err => {
        launchRef.current = null;
        setError(
          err instanceof Error
            ? err.message
            : "The player could not be opened. Please try again."
        );
      });
  }, [native, movie, season, episode, detailPath]);

  const title = movie?.title || "This title";
  const kind = movie?.mediaType ?? urlType;
  const nativeSeason = kind === "tv" ? season : 0;
  const nativeEpisode = kind === "tv" ? episode : 0;
  const titlePath = buildTitlePath(detailPath, kind, {
    season: kind === "tv" ? season : undefined,
    episode: kind === "tv" ? episode : undefined,
  });
  const artwork = movie?.backdrop || movie?.poster || null;
  const artworkUrl = artwork ? optimizedImage(artwork, 1280) : "";
  const deepLink = detailPath ? watchDeepLink(detailPath, search || "") : "";

  if (native) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0b0c10] px-5 py-14 text-white">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-7 text-center shadow-[0_30px_90px_-40px_rgba(0,0,0,1)]">
          <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full bg-white text-black">
            {error ? (
              <Smartphone className="h-6 w-6" />
            ) : loading || !launched ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <Check className="h-6 w-6" />
            )}
          </div>
          <p className="mw-eyebrow text-white/45">Stream Vy app</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">
            {error ? "Couldn't start playback" : loading ? "Preparing playback" : title}
          </h1>
          <p className="mt-3 text-sm leading-6 text-white/60">
            {error
              ? error
              : loading
                ? "Loading the title and opening the player…"
                : launched
                  ? "The player opens in a moment. Use back to return to this title."
                  : "Opening the player…"}
          </p>

          {!loading && !error ? (
            <button
              type="button"
              onClick={() => {
                if (!movie?.subjectId) return;
                launchRef.current = `${movie.subjectId}:${nativeSeason}:${nativeEpisode}`;
                void playNative({
                  subjectId: movie.subjectId,
                  detailPath: movie.providerId || detailPath,
                  season: nativeSeason,
                  episode: nativeEpisode,
                  title: movie.title,
                }).catch(() => undefined);
              }}
              className="mt-6 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-bold text-black transition hover:bg-white/90"
            >
              <Play className="h-4 w-4 fill-current" />
              Open player
            </button>
          ) : null}

          <Link
            href={titlePath}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-5 text-sm font-semibold text-white/80 transition hover:bg-white/[0.08] hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to title
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#09090b] text-white">
      {artworkUrl ? (
        <img
          src={artworkUrl}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover opacity-30 blur-[2px]"
        />
      ) : null}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_0%,rgba(109,59,232,0.28),transparent_65%),linear-gradient(180deg,rgba(9,9,11,0.45),#09090b_78%)]"
      />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-5 py-14 sm:px-8">
        <Link
          href={titlePath}
          className="mb-8 inline-flex w-fit items-center gap-2 text-sm font-medium text-white/55 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to {title}
        </Link>

        <div className="rounded-3xl border border-white/10 bg-black/55 p-6 shadow-[0_40px_120px_-50px_rgba(0,0,0,1)] backdrop-blur-xl sm:p-10">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/60">
            <Smartphone className="h-3.5 w-3.5" />
            Android app
          </span>
          <h1 className="mt-5 text-balance text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
            Watch {title} free in the Stream Vy app
          </h1>
          <p className="mt-4 max-w-xl text-pretty text-sm leading-6 text-white/60 sm:text-base">
            The website is for browsing. Full playback lives in the Android app,
            where Stream Vy can play the title directly on your phone.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href={ANDROID_APP_URL}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-bold text-black transition hover:bg-white/90"
            >
              <Download className="h-4 w-4" />
              Get the free app
            </a>
            {deepLink ? (
              <a
                href={deepLink}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-6 text-sm font-semibold text-white/85 transition hover:bg-white/[0.1] hover:text-white"
              >
                <Play className="h-4 w-4 fill-current" />
                Open in app
              </a>
            ) : null}
          </div>

          <p className="mt-5 text-xs leading-5 text-white/35">
            Already installed? “Open in app” launches Stream Vy — if the button
            does nothing, use “Get the free app” to install it.
          </p>
        </div>
      </div>
    </main>
  );
}
