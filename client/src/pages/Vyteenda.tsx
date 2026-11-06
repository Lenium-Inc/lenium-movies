import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  AnimatePresence,
  motion,
  useAnimation,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "framer-motion";
import {
  Bookmark,
  ChevronRight,
  Heart,
  Info,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { Navbar } from "@/components/layout/Navbar";
import type { View } from "@/components/layout/navigation";
import type { Movie } from "@/components/movies/types";
import { buildTitlePath } from "@/lib/watchRoute";
import { tmdbImage, tmdbSrcSet } from "@/lib/tmdbImages";
import { toMovie } from "@/lib/media";
import {
  fetchDiscover,
  fetchPopular,
  fetchTrending,
  type CatalogItem,
  type StreamMovie,
} from "@/services/api";
import {
  isSaved,
  pushRemoveToRemote,
  removeFromList,
  setEntryTag,
  toggleListSave,
} from "@/services/lists";
import {
  decidedKeys,
  getDecisions,
  lastDecision,
  popDecision,
  recordDecision,
  resetDecisions,
} from "@/services/vyteenda";
import { tapFeedback } from "@/lib/native";

/** A swipe shorter than this snaps the card back instead of deciding it. */
const SWIPE_THRESHOLD = 110;
/** Cards rendered in the stack, including the one on top. */
const STACK_SIZE = 3;
const POSTER_SIZES =
  "(min-width: 768px) 420px, (min-width: 640px) 70vw, 88vw";

const POSTER_SRCSET = ["w342", "w500", "w780"] as const;

function movieKey(movie: Movie): string {
  return String(movie.providerId || movie.id);
}

function posterOf(movie: Movie): string {
  return tmdbImage(movie.poster, "w500") || tmdbImage(movie.backdrop, "w780");
}

function backdropOf(movie: Movie): string {
  return tmdbImage(movie.backdrop ?? movie.backdrop_url, "w780");
}

function numericId(movie: Movie): number {
  const parsed = Number(movie.providerId);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : movie.id;
}

/** Merge every catalogue feed into one shuffled, duplicate-free deck. */
function mergeDeck(
  discover: CatalogItem[],
  trending: StreamMovie[],
  popular: StreamMovie[],
  decided: Set<string>
): Movie[] {
  const seen = new Set<string>();
  const deck: Movie[] = [];
  const push = (movie: Movie) => {
    const key = movieKey(movie);
    if (!key || seen.has(key) || decided.has(key)) return;
    if (!movie.title) return;
    if (!movie.poster && !movie.backdrop) return;
    seen.add(key);
    deck.push(movie);
  };

  discover.forEach(item => push(toMovie(item)));
  trending.forEach(item => push(toMovie(item)));
  popular.forEach(item => push(toMovie(item)));

  // Shuffle once per load. The feeds are rank-ordered, so dealing them in
  // order would make every visit start on the same handful of titles.
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export default function Vyteenda() {
  const [, navigate] = useLocation();
  const [deck, setDeck] = useState<Movie[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matched, setMatched] = useState<Movie | null>(null);
  const [busy, setBusy] = useState(false);
  const [likedCount, setLikedCount] = useState(0);
  const [passedCount, setPassedCount] = useState(0);
  // Counts only the swipes made since this page opened, so Undo can never
  // reach back into a previous visit and silently remove a settled match.
  const [sessionSwipes, setSessionSwipes] = useState(0);
  const preloaded = useRef(new Set<string>());

  const controls = useAnimation();
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-260, 0, 260], [-14, 0, 14]);
  const likeOpacity = useTransform(x, [30, 150], [0, 1]);
  const passOpacity = useTransform(x, [-150, -30], [1, 0]);

  const current = deck[index];
  const upcoming = deck.slice(index + 1, index + STACK_SIZE);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [discoverA, discoverB, trending, popular] = await Promise.all([
        fetchDiscover({ media_type: "movie", page: 1, per_page: 24 }),
        fetchDiscover({ media_type: "movie", page: 2, per_page: 24 }),
        fetchTrending({ time_window: "week", media_type: "all" }),
        fetchPopular({ media_type: "movie" }),
      ]);
      const decided = decidedKeys();
      const items = mergeDeck(
        [...discoverA.items, ...discoverB.items],
        trending,
        popular,
        decided
      );
      const decisions = getDecisions();
      setDeck(items);
      setIndex(0);
      setLikedCount(
        decisions.filter(entry => entry.action === "like").length
      );
      setPassedCount(
        decisions.filter(entry => entry.action === "pass").length
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The deck could not be dealt right now."
      );
      setDeck([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Warm the next two posters while the current card is on screen.
   *
   * The deck is the one screen where every single interaction needs a new
   * image, so waiting until the card is on top makes the swipe land on a blank
   * frame. Idle-time, and only two ahead, so it never competes with the card
   * the viewer is actually looking at.
   */
  useEffect(() => {
    const warm = () => {
      deck.slice(index + 1, index + STACK_SIZE).forEach(movie => {
        const url = posterOf(movie);
        if (!url || preloaded.current.has(url)) return;
        preloaded.current.add(url);
        const image = new Image();
        image.decoding = "async";
        image.src = url;
      });
    };
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(warm, { timeout: 1500 })
      : null;
    const timer = idle === null ? window.setTimeout(warm, 400) : null;
    return () => {
      if (idle !== null) window.cancelIdleCallback?.(idle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [deck, index]);

  const commit = useCallback(
    (action: "like" | "pass", movie: Movie) => {
      const key = movieKey(movie);
      if (action === "like") {
        const id = numericId(movie);
        const already = isSaved(id);
        if (!already) {
          toggleListSave({
            id,
            providerId: movie.providerId,
            title: movie.title,
            year: movie.year,
            poster: movie.poster,
            backdrop: movie.backdrop ?? movie.backdrop_url ?? null,
            mediaType: movie.mediaType,
            score: movie.score,
          });
        }
        // A match is a favourite, not a vague "plan"; My List's Favorites
        // filter is where the deck's output should collect.
        setEntryTag(id, "favorites");
        recordDecision(key, "like", !already);
        setLikedCount(count => count + 1);
        setSessionSwipes(count => count + 1);
        setMatched(movie);
        void tapFeedback("medium");
      } else {
        recordDecision(key, "pass");
        setPassedCount(count => count + 1);
        setSessionSwipes(count => count + 1);
        void tapFeedback("light");
      }
      setIndex(value => value + 1);
    },
    []
  );

  const settle = useCallback(
    async (action: "like" | "pass") => {
      if (!current || busy) return;
      setBusy(true);
      const direction = action === "like" ? 1 : -1;
      try {
        await controls.start({
          x: direction * 620,
          rotate: direction * 18,
          opacity: 0,
          transition: { duration: 0.2, ease: "easeOut" },
        });
        commit(action, current);
      } finally {
        x.set(0);
        controls.set({ x: 0, rotate: 0, opacity: 1 });
        setBusy(false);
      }
    },
    [busy, commit, controls, current, x]
  );

  const handleDragEnd = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (info.offset.x > SWIPE_THRESHOLD) void settle("like");
      else if (info.offset.x < -SWIPE_THRESHOLD) void settle("pass");
    },
    [settle]
  );

  const undo = useCallback(() => {
    if (sessionSwipes === 0) return;
    const last = lastDecision();
    if (!last) return;
    popDecision();
    setSessionSwipes(count => Math.max(0, count - 1));
    if (last.action === "like") {
      if (last.added) {
        const id = Number(last.key);
        if (Number.isFinite(id)) {
          removeFromList(id);
          void pushRemoveToRemote(id);
        }
      }
      setLikedCount(count => Math.max(0, count - 1));
    } else {
      setPassedCount(count => Math.max(0, count - 1));
    }
    setMatched(null);
    x.set(0);
    controls.set({ x: 0, rotate: 0, opacity: 1 });
    // Before the first card there is nothing on screen to go back to; rebuild
    // the deck so the undone title is actually dealt again.
    if (index === 0) void load();
    else setIndex(value => Math.max(0, value - 1));
  }, [controls, index, load, sessionSwipes, x]);

  const reset = useCallback(() => {
    resetDecisions();
    setLikedCount(0);
    setPassedCount(0);
    setSessionSwipes(0);
    setMatched(null);
    void load();
  }, [load]);

  // Arrow keys are the desktop equivalent of a swipe. Ignore them while a text
  // field has focus, because "/" opens search and typed text must not swipe.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (matched) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        void settle("pass");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        void settle("like");
      } else if (event.key === "Backspace") {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matched, settle, undo]);

  const openTitle = useCallback(
    (movie: Movie) => {
      const id = movie.providerId || movie.id;
      if (id) navigate(buildTitlePath(id, movie.mediaType));
    },
    [navigate]
  );

  const onNavigate = useCallback(
    (view: View) => {
      if (view === "home") navigate("/");
      else navigate(`/?section=${view}`);
    },
    [navigate]
  );

  const total = likedCount + passedCount + Math.max(0, deck.length - index);
  const progress = total > 0 ? Math.round(((likedCount + passedCount) / total) * 100) : 0;
  const currentPoster = current ? posterOf(current) : "";
  const currentBackdrop = current ? backdropOf(current) : "";

  return (
    <div className="sv-accent-scope min-h-screen text-white">
      <Navbar view="vyteenda" onNavigate={onNavigate} />

      <main className="mx-auto max-w-6xl px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--text-muted)]">
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
              Find your next watch
            </p>
            <h1 className="mt-2 font-display text-4xl font-black tracking-tight sm:text-5xl">
              Vyteenda
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--text-muted)]">
              Swipe right or tap the heart to match. Every match lands in My
              List under Favorites; swipe left to pass.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
              <Heart className="h-4 w-4 fill-rose-500 text-rose-500" />
              {likedCount} matched
            </span>
            <Link
              href="/my-list"
              className="hidden items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-white/60 transition hover:bg-white/5 sm:inline-flex"
            >
              <Bookmark className="h-3.5 w-3.5" />
              My List
            </Link>
          </div>
        </header>

        <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>

        <div className="relative mx-auto flex min-h-[620px] max-w-xl items-center justify-center">
          {loading ? (
            <div className="grid h-[520px] w-full place-items-center rounded-3xl border border-white/10 bg-white/[0.03]">
              <div className="flex flex-col items-center gap-3 text-white/50">
                <Loader2 className="h-7 w-7 animate-spin" />
                <span className="text-sm">Dealing the deck…</span>
              </div>
            </div>
          ) : error ? (
            <div className="w-full rounded-3xl border border-white/10 bg-white/[0.03] p-8 text-center">
              <p className="text-lg font-semibold">Couldn&apos;t deal the deck</p>
              <p className="mt-2 text-sm text-white/50">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-5 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white"
              >
                Try again
              </button>
            </div>
          ) : !current ? (
            <div className="w-full rounded-3xl border border-white/10 bg-white/[0.03] p-10 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-rose-500/15">
                <Heart className="h-7 w-7 fill-rose-500 text-rose-500" />
              </div>
              <h2 className="mt-5 text-2xl font-bold">
                {total === 0 ? "You've seen the whole deck" : "That's everyone"}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-white/50">
                {likedCount > 0
                  ? `${likedCount} match${likedCount === 1 ? "" : "es"} waiting in My List. Reset the deck to rediscover titles you passed.`
                  : "Reset the deck to start again, or browse the catalogue for something new."}
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={reset}
                  className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset deck
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/my-list")}
                  className="inline-flex items-center gap-2 rounded-full border border-white/15 px-5 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/5"
                >
                  <Bookmark className="h-4 w-4" />
                  My List
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Two static cards behind the top one: enough depth to read as a
                  deck, few enough that no extra artwork is downloaded. */}
              {upcoming
                .slice()
                .reverse()
                .map((movie, order) => {
                  const depth = order + 1;
                  return (
                    <div
                      key={movieKey(movie)}
                      aria-hidden
                      className="absolute inset-x-6 overflow-hidden rounded-3xl border border-white/10 bg-zinc-900"
                      style={{
                        height: "calc(100% - 24px)",
                        transform: `translateY(${depth * 12}px) scale(${1 - depth * 0.04})`,
                        opacity: 1 - depth * 0.35,
                        zIndex: STACK_SIZE - depth,
                      }}
                    >
                      <img
                        src={posterOf(movie)}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    </div>
                  );
                })}

              <motion.article
                key={movieKey(current)}
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.7}
                onDragEnd={handleDragEnd}
                style={{ x, rotate }}
                animate={controls}
                className="relative z-10 w-full cursor-grab touch-pan-y overflow-hidden rounded-3xl border border-white/10 bg-zinc-900 shadow-[0_30px_80px_rgba(0,0,0,0.6)] active:cursor-grabbing"
                aria-label={`${current.title}${current.year ? `, ${current.year}` : ""}`}
              >
                <div className="relative h-[520px] w-full sm:h-[560px]">
                  {currentBackdrop ? (
                    <img
                      src={currentBackdrop}
                      alt=""
                      aria-hidden
                      className="absolute inset-0 h-full w-full scale-110 object-cover opacity-35 blur-2xl"
                      loading="eager"
                      decoding="async"
                    />
                  ) : null}
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(9,10,15,0.1)_0%,rgba(9,10,15,0.15)_35%,rgba(9,10,15,0.92)_100%)]" />

                  {currentPoster ? (
                    <img
                      src={currentPoster}
                      srcSet={tmdbSrcSet(current.poster, POSTER_SRCSET)}
                      sizes={POSTER_SIZES}
                      alt={current.title}
                      className="absolute left-1/2 top-5 h-[360px] w-auto max-w-[78%] -translate-x-1/2 rounded-xl object-cover shadow-2xl sm:h-[390px]"
                      loading="eager"
                      fetchPriority="high"
                      decoding="async"
                    />
                  ) : null}

                  <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-6">
                    <div className="min-w-0">
                      <h2 className="truncate font-display text-3xl font-black tracking-tight">
                        {current.title}
                      </h2>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/70">
                        {current.year ? (
                          <span className="rounded-md border border-white/15 px-2 py-1">
                            {current.year}
                          </span>
                        ) : null}
                        {current.score ? (
                          <span className="rounded-md border border-white/15 px-2 py-1">
                            ★ {current.score.toFixed(1)}
                          </span>
                        ) : null}
                        {current.mediaType === "tv" ? (
                          <span className="rounded-md border border-white/15 px-2 py-1">
                            Series
                          </span>
                        ) : null}
                        {current.genre.slice(0, 2).map(genre => (
                          <span
                            key={genre}
                            className="rounded-md border border-white/15 px-2 py-1"
                          >
                            {genre}
                          </span>
                        ))}
                      </div>
                      {current.synopsis ? (
                        <p className="mt-3 line-clamp-3 text-sm leading-6 text-white/60">
                          {current.synopsis}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => openTitle(current)}
                      aria-label={`More about ${current.title}`}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/20 bg-black/40 text-white/80 backdrop-blur transition hover:bg-white/10"
                    >
                      <Info className="h-5 w-5" />
                    </button>
                  </div>
                </div>

                {/* Direction cues tint the card as it is dragged, so the
                    gesture reports what it will do before release. */}
                <motion.div
                  aria-hidden
                  style={{ opacity: likeOpacity }}
                  className="pointer-events-none absolute left-5 top-5 rotate-[-8deg] rounded-lg border-4 border-emerald-400 px-3 py-1 text-xl font-black uppercase tracking-widest text-emerald-400"
                >
                  Match
                </motion.div>
                <motion.div
                  aria-hidden
                  style={{ opacity: passOpacity }}
                  className="pointer-events-none absolute right-5 top-5 rotate-[8deg] rounded-lg border-4 border-rose-400 px-3 py-1 text-xl font-black uppercase tracking-widest text-rose-400"
                >
                  Pass
                </motion.div>
              </motion.article>
            </>
          )}
        </div>

        {!loading && !error && current ? (
          <div className="mt-8 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={undo}
              disabled={busy || sessionSwipes === 0}
              aria-label="Undo last swipe"
              className="grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-white/60 transition hover:bg-white/10 disabled:opacity-40"
            >
              <RotateCcw className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => void settle("pass")}
              disabled={busy}
              aria-label="Pass"
              className="grid h-16 w-16 place-items-center rounded-full border border-rose-400/30 bg-rose-500/10 text-rose-400 transition hover:bg-rose-500/20 disabled:opacity-40"
            >
              <X className="h-8 w-8" />
            </button>
            <button
              type="button"
              onClick={() => void settle("like")}
              disabled={busy}
              aria-label="Match"
              className="grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-rose-500 to-fuchsia-600 text-white shadow-[0_16px_40px_rgba(244,63,94,0.35)] transition hover:scale-105 disabled:opacity-40"
            >
              <Heart className="h-9 w-9 fill-white" />
            </button>
            <button
              type="button"
              onClick={() => openTitle(current)}
              aria-label="Open title details"
              className="grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-white/60 transition hover:bg-white/10"
            >
              <Info className="h-5 w-5" />
            </button>
          </div>
        ) : null}

        <p className="mt-6 text-center text-xs text-white/35">
          ← pass · → match · Backspace to undo
        </p>
      </main>

      <AnimatePresence>
        {matched ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 grid place-items-center bg-black/80 px-5 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label="It's a match"
            onClick={() => setMatched(null)}
          >
            <motion.div
              initial={{ scale: 0.85, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 22 }}
              className="w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 bg-zinc-950 text-center shadow-2xl"
              onClick={event => event.stopPropagation()}
            >
              {posterOf(matched) ? (
                <div className="relative h-56 w-full overflow-hidden">
                  <img
                    src={tmdbImage(matched.backdrop ?? matched.backdrop_url, "w780") || posterOf(matched)}
                    alt=""
                    className="h-full w-full object-cover opacity-60"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 to-transparent" />
                </div>
              ) : null}
              <div className="px-7 pb-7 pt-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-rose-400">
                  Vyteenda
                </p>
                <h2 className="mt-2 font-display text-3xl font-black">
                  It&apos;s a match
                </h2>
                <p className="mt-2 text-sm leading-6 text-white/55">
                  <span className="font-semibold text-white/80">
                    {matched.title}
                  </span>{" "}
                  is now in My List → Favorites.
                </p>
                <div className="mt-6 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMatched(null);
                      navigate("/my-list");
                    }}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-5 py-3 text-sm font-bold text-white"
                  >
                    <Bookmark className="h-4 w-4" />
                    View My List
                  </button>
                  <button
                    type="button"
                    onClick={() => setMatched(null)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-full border border-white/10 px-5 py-3 text-sm font-semibold text-white/70 transition hover:bg-white/5"
                  >
                    Keep swiping
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

