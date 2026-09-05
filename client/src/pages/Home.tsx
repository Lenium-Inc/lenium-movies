import { useMemo, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import {
  ArrowRight,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Clock3,
  Info,
  ListVideo,
  Menu,
  Play,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { matchesMovieSearch } from "../../../shared/movies";

type Movie = {
  id: number;
  title: string;
  year: number;
  runtime: string;
  rating: string;
  score: number;
  genre: string[];
  poster: string;
  backdrop: string;
  synopsis: string;
  director: string;
  mood: string;
  accent: string;
};

const img = (id: string, width = 900) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${width}&q=85`;

const movies: Movie[] = [
  {
    id: 1,
    title: "Afterlight",
    year: 2024,
    runtime: "1h 52m",
    rating: "16+",
    score: 8.4,
    genre: ["Sci-fi", "Drama"],
    poster: img("photo-1534447677768-be436bb09401", 620),
    backdrop: img("photo-1518709268805-4e9042af9f23", 1600),
    synopsis: "A lighthouse keeper on the edge of a flooded world receives a signal from a city that disappeared beneath the sea.",
    director: "Mara Voss",
    mood: "Quietly epic",
    accent: "#f2ac71",
  },
  {
    id: 2,
    title: "The Last Broadcast",
    year: 2023,
    runtime: "1h 38m",
    rating: "13+",
    score: 8.1,
    genre: ["Mystery", "Thriller"],
    poster: img("photo-1489599849927-2ee91cede3ba", 620),
    backdrop: img("photo-1478720568477-152d9b164e26", 1600),
    synopsis: "On the final night of local television, a producer uncovers a story hidden in the static.",
    director: "Jules Anwar",
    mood: "Slow-burn",
    accent: "#9f8cf5",
  },
  {
    id: 3,
    title: "Soft Focus",
    year: 2024,
    runtime: "1h 46m",
    rating: "13+",
    score: 7.9,
    genre: ["Romance", "Indie"],
    poster: img("photo-1496440737103-cd596325d314", 620),
    backdrop: img("photo-1524985069026-dd778a71c7b4", 1600),
    synopsis: "Two strangers meet in the projection booth of a cinema that is closing for good.",
    director: "Nina Sol",
    mood: "Warm & wry",
    accent: "#eabf66",
  },
  {
    id: 4,
    title: "Into the Blue",
    year: 2022,
    runtime: "2h 08m",
    rating: "16+",
    score: 8.7,
    genre: ["Adventure", "Drama"],
    poster: img("photo-1500534623283-312aade485b7", 620),
    backdrop: img("photo-1507525428034-b723cf961d3e", 1600),
    synopsis: "A marine biologist returns to the coast she left behind to follow a pod that should not exist.",
    director: "Eli Hart",
    mood: "Oceanic",
    accent: "#7dc4db",
  },
  {
    id: 5,
    title: "Night Shift",
    year: 2024,
    runtime: "1h 29m",
    rating: "18+",
    score: 8.0,
    genre: ["Crime", "Noir"],
    poster: img("photo-1515886657613-9f3515b0c78f", 620),
    backdrop: img("photo-1519608487953-e999c86e7455", 1600),
    synopsis: "A night-shift paramedic has one hour to choose between the truth and the person who saved her life.",
    director: "Owen Price",
    mood: "Neon noir",
    accent: "#db7fb0",
  },
  {
    id: 6,
    title: "The Orchard",
    year: 2021,
    runtime: "1h 41m",
    rating: "13+",
    score: 8.2,
    genre: ["Family", "Drama"],
    poster: img("photo-1500530855697-b586d89ba3ee", 620),
    backdrop: img("photo-1500534314209-a25ddb2bd429", 1600),
    synopsis: "When an old orchard is threatened, three siblings come home to decide what is worth keeping.",
    director: "Amara Kent",
    mood: "Tender",
    accent: "#b8d583",
  },
  {
    id: 7,
    title: "Static Bloom",
    year: 2023,
    runtime: "1h 34m",
    rating: "13+",
    score: 7.8,
    genre: ["Music", "Drama"],
    poster: img("photo-1501386761578-eac5c94b800a", 620),
    backdrop: img("photo-1492684223066-81342ee5ff30", 1600),
    synopsis: "A bedroom musician gets one strange summer to turn a bedroom recording into a real song.",
    director: "Rae Okafor",
    mood: "Electric",
    accent: "#e88d72",
  },
  {
    id: 8,
    title: "Dust & Signal",
    year: 2022,
    runtime: "1h 57m",
    rating: "16+",
    score: 8.5,
    genre: ["Western", "Mystery"],
    poster: img("photo-1473448912268-2022ce9509d8", 620),
    backdrop: img("photo-1470252649378-9c29740c9fa8", 1600),
    synopsis: "A cartographer follows a radio signal across an unmarked desert and finds a town that refuses to appear on maps.",
    director: "Theo Ramires",
    mood: "Haunting",
    accent: "#c99366",
  },
];

const categories = ["All films", "Sci-fi", "Drama", "Mystery", "Romance", "Documentary", "Comedy", "Short films"];

function SectionHeading({ eyebrow, title, action = "View all" }: { eyebrow?: string; title: string; action?: string }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.24em] text-[#efaa6d]">{eyebrow}</p>}
        <h2 className="font-display text-2xl font-semibold tracking-tight text-[#f5f1ea] md:text-3xl">{title}</h2>
      </div>
      <button className="group hidden items-center gap-2 pb-1 text-xs font-semibold text-[#a9a59f] transition hover:text-[#f4b06e] sm:flex">
        {action} <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-1" />
      </button>
    </div>
  );
}

function MovieCard({ movie, onSelect, isSaved, onToggleSave }: { movie: Movie; onSelect: () => void; isSaved: boolean; onToggleSave: () => void }) {
  return (
    <article className="group min-w-[144px] flex-1 sm:min-w-[170px]">
      <div className="relative aspect-[2/3] overflow-hidden rounded-[6px] bg-[#1a1a1e] shadow-[0_10px_35px_rgba(0,0,0,0.22)]">
        <img src={movie.poster} alt={movie.title} className="h-full w-full object-cover transition duration-500 ease-out group-hover:scale-[1.05]" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/0 to-black/10 opacity-70" />
        <button aria-label={`Play ${movie.title}`} onClick={onSelect} className="absolute left-1/2 top-1/2 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 scale-90 place-items-center rounded-full bg-[#f7efe4] text-[#101014] opacity-0 shadow-[0_0_0_8px_rgba(247,239,228,0.12)] transition duration-200 group-hover:scale-100 group-hover:opacity-100">
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        </button>
        <button aria-label={isSaved ? `Remove ${movie.title} from list` : `Save ${movie.title}`} onClick={(event) => { event.stopPropagation(); onToggleSave(); }} className={`absolute right-2.5 top-2.5 grid h-8 w-8 place-items-center rounded-full backdrop-blur-md transition ${isSaved ? "bg-[#f4b06e] text-[#111114]" : "bg-black/35 text-white/85 hover:bg-white/20"}`}>
          {isSaved ? <Check className="h-3.5 w-3.5" /> : <Bookmark className="h-3.5 w-3.5" />}
        </button>
        <div className="absolute bottom-3 left-3 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-white/85">
          <Star className="h-3 w-3 fill-[#f4b06e] text-[#f4b06e]" /> {movie.score}
        </div>
      </div>
      <button onClick={onSelect} className="mt-3 block text-left">
        <h3 className="line-clamp-1 text-sm font-semibold text-[#eee9df] transition group-hover:text-[#f4b06e]">{movie.title}</h3>
        <p className="mt-1 text-[11px] text-[#84838a]">{movie.year} <span className="px-1 text-[#4d4d55]">•</span> {movie.genre[0]}</p>
      </button>
    </article>
  );
}

export default function Home() {
  const { user, isAuthenticated, logout } = useAuth();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All films");
  const [activeView, setActiveView] = useState("Explore");
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [savedIds, setSavedIds] = useState<number[]>([4, 7]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const filteredMovies = useMemo(() => {
    const query = search.trim().toLowerCase();
    return movies.filter((movie) => {
      const matchesCategory = activeCategory === "All films" || movie.genre.includes(activeCategory);
      const matchesSearch = matchesMovieSearch(movie, query);
      const matchesView = activeView !== "My list" || savedIds.includes(movie.id);
      return matchesCategory && matchesSearch && matchesView;
    });
  }, [activeCategory, activeView, savedIds, search]);

  const toggleSaved = (movie: Movie) => {
    setSavedIds((current) => current.includes(movie.id) ? current.filter((id) => id !== movie.id) : [...current, movie.id]);
    toast.success(savedIds.includes(movie.id) ? `${movie.title} removed from your list` : `${movie.title} saved to your list`, { duration: 2200 });
  };

  const handleNav = (view: string) => {
    setActiveView(view);
    setMobileNavOpen(false);
    if (view !== "Explore") setActiveCategory("All films");
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#0b0b0e] text-[#f5f1ea] selection:bg-[#f4b06e] selection:text-[#111114]">
      <header className="absolute inset-x-0 top-0 z-40 border-b border-white/[0.07] bg-gradient-to-b from-black/75 to-transparent">
        <div className="mx-auto flex h-[76px] max-w-[1440px] items-center gap-5 px-5 md:px-10">
          <button onClick={() => handleNav("Explore")} className="flex items-center gap-2.5" aria-label="Lenflix home">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[#f4b06e] text-[#171318] shadow-[0_0_24px_rgba(244,176,110,0.28)]"><CirclePlay className="h-4 w-4 fill-current" /></span>
            <span className="font-display text-[17px] font-semibold tracking-[-0.03em]">Lenflix<span className="text-[#f4b06e]">.</span></span>
          </button>
          <nav className="ml-7 hidden items-center gap-7 text-[12px] font-semibold text-[#b6b1ac] md:flex">
            {['Explore', 'New & notable', 'Collections', 'My list'].map((item) => <button key={item} onClick={() => handleNav(item === "New & notable" ? "New" : item)} className={`relative py-2 transition hover:text-white ${activeView === (item === "New & notable" ? "New" : item) ? "text-white" : ""}`}>{item}{activeView === (item === "New & notable" ? "New" : item) && <span className="absolute -bottom-1 left-0 h-px w-full bg-[#f4b06e]" />}</button>)}
          </nav>
          <div className="ml-auto flex items-center gap-2.5">
            <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.055] px-3 py-2 text-[#aaa6a1] transition focus-within:border-[#f4b06e]/60 focus-within:bg-white/[0.08] sm:flex">
              <Search className="h-3.5 w-3.5" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search films, directors..." className="w-[160px] bg-transparent text-xs text-white outline-none placeholder:text-[#77757a]" />
            </div>
            <button onClick={() => setMobileNavOpen(!mobileNavOpen)} className="grid h-9 w-9 place-items-center rounded-full text-[#d4cec6] hover:bg-white/10 md:hidden"><Menu className="h-4 w-4" /></button>
            {isAuthenticated ? <button onClick={() => logout()} className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.07] px-3 py-2 text-xs font-semibold text-[#d9d3cb] transition hover:bg-white/15 sm:flex"><UserRound className="h-3.5 w-3.5" /> {user?.name?.split(" ")[0] ?? "Account"}</button> : <button onClick={() => startLogin()} className="hidden rounded-full bg-[#f4b06e] px-4 py-2 text-xs font-bold text-[#171318] transition hover:bg-[#ffd09e] sm:block">Sign in</button>}
          </div>
        </div>
        {mobileNavOpen && <div className="border-t border-white/10 bg-[#101014]/95 px-5 py-4 backdrop-blur-xl md:hidden"><div className="mb-4 flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-2"><Search className="h-3.5 w-3.5 text-[#aaa6a1]" /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search films..." className="w-full bg-transparent text-xs text-white outline-none placeholder:text-[#77757a]" /></div><div className="grid grid-cols-2 gap-2 text-left text-sm text-[#cfcbc5]">{['Explore', 'New', 'Collections', 'My list'].map((item) => <button key={item} onClick={() => handleNav(item)} className="rounded-lg px-3 py-2.5 text-left hover:bg-white/10">{item === 'New' ? 'New & notable' : item}</button>)}</div></div>}
      </header>

      <main>
        <section className="relative isolate flex min-h-[650px] items-end overflow-hidden pb-16 pt-32 md:min-h-[700px] md:pb-20">
          <div className="absolute inset-0 -z-20 bg-[#171216]" />
          <img src={movies[0].backdrop} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover object-center opacity-70" />
          <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,#0b0b0e_0%,rgba(11,11,14,.82)_27%,rgba(11,11,14,.3)_65%,rgba(11,11,14,.45)_100%)]" />
          <div className="absolute inset-0 -z-10 bg-[linear-gradient(0deg,#0b0b0e_0%,rgba(11,11,14,.1)_55%,rgba(11,11,14,.26)_100%)]" />
          <div className="mx-auto grid w-full max-w-[1440px] grid-cols-1 px-5 md:px-10 lg:grid-cols-[minmax(0,520px)_1fr]">
            <div className="animate-rise">
              <div className="mb-6 flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.23em] text-[#f4b06e]"><span className="h-px w-8 bg-[#f4b06e]" /> Lenflix original <span className="text-[#8c8884]">/</span> 01</div>
              <h1 className="max-w-[530px] font-display text-6xl font-semibold leading-[0.92] tracking-[-0.055em] text-[#f8f2e9] sm:text-7xl md:text-[94px]">After<br /><span className="text-[#f4b06e]">light</span></h1>
              <p className="mt-7 max-w-[390px] text-sm leading-6 text-[#d0cbc4] md:text-[15px]">A lighthouse keeper on the edge of a flooded world receives a signal from a city that disappeared beneath the sea.</p>
              <div className="mt-6 flex flex-wrap items-center gap-3 text-[11px] font-semibold text-[#c1bbb3]"><span className="rounded border border-white/20 px-2 py-1 text-[#f5f1ea]">16+</span><span>2024</span><span className="text-[#6f6b68]">•</span><span>1h 52m</span><span className="text-[#6f6b68]">•</span><span className="flex items-center gap-1"><Star className="h-3 w-3 fill-[#f4b06e] text-[#f4b06e]" /> 8.4</span></div>
              <div className="mt-9 flex flex-wrap gap-3"><button onClick={() => setSelectedMovie(movies[0])} className="group flex items-center gap-2 rounded-full bg-[#f4b06e] px-5 py-3 text-xs font-bold text-[#191418] transition hover:bg-[#ffd09e]"><Play className="h-3.5 w-3.5 fill-current transition group-hover:scale-110" /> Play trailer</button><button onClick={() => toggleSaved(movies[0])} className="flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.06] px-5 py-3 text-xs font-semibold text-[#f3eee7] backdrop-blur-sm transition hover:bg-white/15"><Bookmark className="h-3.5 w-3.5" /> {savedIds.includes(1) ? "Saved" : "Save"}</button></div>
            </div>
            <div className="hidden items-end justify-end pb-3 lg:flex"><div className="max-w-[230px] border-l border-white/20 pl-5 text-xs leading-5 text-[#aaa59e]"><span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.2em] text-[#f4b06e]">The feeling</span>Some stories arrive quietly. Then they change the shape of the world.</div></div>
          </div>
        </section>

        <div className="mx-auto max-w-[1440px] px-5 pb-20 md:px-10">
          <section className="relative z-10 -mt-2 md:-mt-5">
            <div className="mb-8 flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">{categories.map((category) => <button key={category} onClick={() => { setActiveCategory(category); setActiveView("Explore"); }} className={`whitespace-nowrap rounded-full border px-4 py-2 text-[11px] font-semibold transition ${activeCategory === category && activeView === "Explore" ? "border-[#f4b06e] bg-[#f4b06e] text-[#171318]" : "border-white/10 bg-white/[0.035] text-[#a7a39e] hover:border-white/25 hover:text-white"}`}>{category}</button>)}</div>
          </section>

          {activeView === "My list" ? <section className="pt-5"><SectionHeading eyebrow="Your shelf" title="Saved for later" action="" />{filteredMovies.length ? <div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-4 lg:grid-cols-6">{filteredMovies.map((movie) => <MovieCard key={movie.id} movie={movie} onSelect={() => setSelectedMovie(movie)} isSaved={savedIds.includes(movie.id)} onToggleSave={() => toggleSaved(movie)} />)}</div> : <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-6 py-20 text-center"><Bookmark className="mx-auto mb-3 h-6 w-6 text-[#f4b06e]" /><h3 className="font-display text-2xl">Your list is waiting</h3><p className="mx-auto mt-2 max-w-sm text-sm text-[#8f8b86]">Save a few films while you explore and they’ll show up here.</p></div>}</section> : <>
            <section className="pt-5"><SectionHeading eyebrow="Curated for your next watch" title={activeView === "New" ? "New & notable" : "A little different"} /><div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-4 lg:grid-cols-6">{(activeView === "New" ? movies.slice(0, 6) : filteredMovies.slice(0, 6)).map((movie) => <MovieCard key={movie.id} movie={movie} onSelect={() => setSelectedMovie(movie)} isSaved={savedIds.includes(movie.id)} onToggleSave={() => toggleSaved(movie)} />)}</div>{filteredMovies.length === 0 && <div className="py-16 text-center text-sm text-[#8f8b86]">No films match that search yet. Try another title, genre, or director.</div>}</section>

            <section className="mt-16"><SectionHeading eyebrow="Pick up where you left off" title="Continue watching" action="See history" /><div className="grid gap-5 md:grid-cols-2"><button onClick={() => setSelectedMovie(movies[2])} className="group relative flex min-h-[150px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#151519] text-left"><img src={movies[2].backdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40 transition duration-500 group-hover:scale-105 group-hover:opacity-55" /><div className="absolute inset-0 bg-gradient-to-r from-[#101014] via-[#101014]/80 to-transparent" /><div className="relative flex w-full items-center gap-5 p-5"><div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#f4b06e] text-[#171318]"><Play className="ml-0.5 h-4 w-4 fill-current" /></div><div><p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#f4b06e]">Continue watching</p><h3 className="font-display text-2xl">Soft Focus</h3><p className="mt-1 text-xs text-[#aaa5a0]">32 min left <span className="px-1.5 text-[#5f5c5a]">•</span> Episode 01</p><div className="mt-4 h-1 w-44 overflow-hidden rounded-full bg-white/15"><div className="h-full w-[62%] rounded-full bg-[#f4b06e]" /></div></div></div></button><div className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-[#151519] px-5 py-4"><div><p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#9c8ce9]">Tonight's edit</p><h3 className="font-display text-2xl">Slow cinema, warm light</h3><p className="mt-1 max-w-[290px] text-xs leading-5 text-[#8d8984]">Four patient films for when the world feels a little too loud.</p><button onClick={() => { setActiveCategory("Drama"); setActiveView("Explore"); }} className="mt-4 flex items-center gap-2 text-xs font-bold text-[#d6c9ff] transition hover:text-white">Explore the edit <ArrowRight className="h-3.5 w-3.5" /></button></div><div className="hidden h-24 w-20 rotate-6 overflow-hidden rounded-md bg-[#322c42] sm:block"><img src={movies[5].poster} alt="" className="h-full w-full object-cover opacity-80" /></div></div></div></section>

            <section className="mt-16"><SectionHeading eyebrow="Because you watched Afterlight" title="More to get lost in" /><div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-4 lg:grid-cols-6">{movies.slice(2, 8).map((movie) => <MovieCard key={movie.id} movie={movie} onSelect={() => setSelectedMovie(movie)} isSaved={savedIds.includes(movie.id)} onToggleSave={() => toggleSaved(movie)} />)}</div></section>
          </>}
        </div>
      </main>

      <footer className="border-t border-white/[0.07] px-5 py-10 md:px-10"><div className="mx-auto flex max-w-[1440px] flex-col justify-between gap-6 text-xs text-[#77747a] sm:flex-row sm:items-center"><div className="flex items-center gap-2.5 text-[#d6d0c7]"><span className="grid h-6 w-6 place-items-center rounded-full bg-[#f4b06e] text-[#171318]"><CirclePlay className="h-3 w-3 fill-current" /></span><span className="font-display text-sm">Lenflix<span className="text-[#f4b06e]">.</span></span></div><div className="flex flex-wrap gap-5"><span>About</span><span>For filmmakers</span><span>Rights & availability</span><span>Privacy</span></div><span>© 2024 Lenflix</span></div></footer>

      {selectedMovie && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" onClick={() => setSelectedMovie(null)}><div onClick={(event) => event.stopPropagation()} className="relative max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-white/10 bg-[#151519] shadow-2xl sm:rounded-2xl"><div className="relative h-56 overflow-hidden sm:h-72"><img src={selectedMovie.backdrop} alt="" className="h-full w-full object-cover" /><div className="absolute inset-0 bg-gradient-to-t from-[#151519] via-transparent to-black/10" /><button onClick={() => setSelectedMovie(null)} aria-label="Close details" className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-black/35 text-white backdrop-blur-md hover:bg-black/60"><X className="h-4 w-4" /></button><div className="absolute bottom-5 left-6 right-6"><span className="rounded-full bg-[#f4b06e] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[#171318]">{selectedMovie.mood}</span><h2 className="mt-3 font-display text-4xl font-semibold tracking-tight sm:text-5xl">{selectedMovie.title}</h2></div></div><div className="grid gap-8 p-6 sm:grid-cols-[1fr_180px] sm:p-8"><div><div className="flex flex-wrap items-center gap-3 text-xs text-[#a7a29c]"><span className="flex items-center gap-1 text-[#f4b06e]"><Star className="h-3.5 w-3.5 fill-current" /> {selectedMovie.score}</span><span>{selectedMovie.year}</span><span>{selectedMovie.runtime}</span><span className="rounded border border-white/20 px-1.5 py-0.5">{selectedMovie.rating}</span>{selectedMovie.genre.map((genre) => <span key={genre} className="text-[#d2ccc3]">{genre}</span>)}</div><p className="mt-5 max-w-xl text-sm leading-6 text-[#c3beb7]">{selectedMovie.synopsis}</p><p className="mt-4 text-xs text-[#8b8781]">Directed by <span className="text-[#ddd7ce]">{selectedMovie.director}</span></p><div className="mt-7 flex flex-wrap gap-3"><button onClick={() => toast.success("Playback is ready for authorized titles", { duration: 2200 })} className="flex items-center gap-2 rounded-full bg-[#f4b06e] px-5 py-3 text-xs font-bold text-[#171318] hover:bg-[#ffd09e]"><Play className="h-3.5 w-3.5 fill-current" /> Start watching</button><button onClick={() => toggleSaved(selectedMovie)} className="flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-5 py-3 text-xs font-semibold text-[#f1ece4] hover:bg-white/10">{savedIds.includes(selectedMovie.id) ? <Check className="h-3.5 w-3.5" /> : <Bookmark className="h-3.5 w-3.5" />} {savedIds.includes(selectedMovie.id) ? "In your list" : "Add to list"}</button></div></div><div className="hidden space-y-3 sm:block"><div className="rounded-xl border border-white/10 bg-white/[0.035] p-4"><div className="mb-3 flex items-center gap-2 text-xs font-semibold text-[#e5dfd6]"><Info className="h-3.5 w-3.5 text-[#f4b06e]" /> Details</div><dl className="space-y-2 text-[11px] text-[#8f8b86]"><div className="flex justify-between gap-4"><dt>Audio</dt><dd className="text-right text-[#cbc5bd]">English 5.1</dd></div><div className="flex justify-between gap-4"><dt>Subtitles</dt><dd className="text-right text-[#cbc5bd]">EN, ES, FR</dd></div><div className="flex justify-between gap-4"><dt>Availability</dt><dd className="text-right text-[#9fd293]">Streaming now</dd></div></dl></div></div></div></div></div>}
    </div>
  );
}
