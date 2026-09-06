import { useMemo, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import {
  Bookmark,
  Check,
  ChevronRight,
  CirclePlay,
  Filter,
  Info,
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
import { getPlaybackUnavailableState } from "../../../shared/playback";

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
};

const img = (id: string, width = 900) => {
  const requestedWidth = width <= 620 ? 420 : 1280;
  const quality = width <= 620 ? 68 : 78;
  return `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${requestedWidth}&q=${quality}`;
};

const movies: Movie[] = [
  { id: 1, title: "Afterlight", year: 2024, runtime: "1h 52m", rating: "16+", score: 8.4, genre: ["Sci-fi", "Drama"], poster: img("photo-1534447677768-be436bb09401", 620), backdrop: img("photo-1518709268805-4e9042af9f23", 1600), synopsis: "A lighthouse keeper on the edge of a flooded world receives a signal from a city that disappeared beneath the sea.", director: "Mara Voss", mood: "Quietly epic" },
  { id: 2, title: "The Last Broadcast", year: 2023, runtime: "1h 38m", rating: "13+", score: 8.1, genre: ["Mystery", "Thriller"], poster: img("photo-1489599849927-2ee91cede3ba", 620), backdrop: img("photo-1478720568477-152d9b164e26", 1600), synopsis: "On the final night of local television, a producer uncovers a story hidden in the static.", director: "Jules Anwar", mood: "Slow-burn" },
  { id: 3, title: "Soft Focus", year: 2024, runtime: "1h 46m", rating: "13+", score: 7.9, genre: ["Romance", "Indie"], poster: img("photo-1496440737103-cd596325d314", 620), backdrop: img("photo-1524985069026-dd778a71c7b4", 1600), synopsis: "Two strangers meet in the projection booth of a cinema that is closing for good.", director: "Nina Sol", mood: "Warm & wry" },
  { id: 4, title: "Into the Blue", year: 2022, runtime: "2h 08m", rating: "16+", score: 8.7, genre: ["Adventure", "Drama"], poster: img("photo-1500534623283-312aade485b7", 620), backdrop: img("photo-1507525428034-b723cf961d3e", 1600), synopsis: "A marine biologist returns to the coast she left behind to follow a pod that should not exist.", director: "Eli Hart", mood: "Oceanic" },
  { id: 5, title: "Night Shift", year: 2024, runtime: "1h 29m", rating: "18+", score: 8.0, genre: ["Crime", "Noir"], poster: img("photo-1515886657613-9f3515b0c78f", 620), backdrop: img("photo-1519608487953-e999c86e7455", 1600), synopsis: "A night-shift paramedic has one hour to choose between the truth and the person who saved her life.", director: "Owen Price", mood: "Neon noir" },
  { id: 6, title: "The Orchard", year: 2021, runtime: "1h 41m", rating: "13+", score: 8.2, genre: ["Family", "Drama"], poster: img("photo-1500530855697-b586d89ba3ee", 620), backdrop: img("photo-1500534314209-a25ddb2bd429", 1600), synopsis: "When an old orchard is threatened, three siblings come home to decide what is worth keeping.", director: "Amara Kent", mood: "Tender" },
  { id: 7, title: "Static Bloom", year: 2023, runtime: "1h 34m", rating: "13+", score: 7.8, genre: ["Music", "Drama"], poster: img("photo-1501386761578-eac5c94b800a", 620), backdrop: img("photo-1492684223066-81342ee5ff30", 1600), synopsis: "A bedroom musician gets one strange summer to turn a bedroom recording into a real song.", director: "Rae Okafor", mood: "Electric" },
  { id: 8, title: "Dust & Signal", year: 2022, runtime: "1h 57m", rating: "16+", score: 8.5, genre: ["Western", "Mystery"], poster: img("photo-1473448912268-2022ce9509d8", 620), backdrop: img("photo-1470252649378-9c29740c9fa8", 1600), synopsis: "A cartographer follows a radio signal across an unmarked desert and finds a town that refuses to appear on maps.", director: "Theo Ramires", mood: "Haunting" },
];

const genres = ["All", "Sci-fi", "Drama", "Mystery", "Romance", "Crime", "Documentary", "Family"];
const moods = ["Something funny", "Something scary", "Something romantic", "Something intense", "Something intelligent", "Something nostalgic", "Under 90 minutes", "Surprise me"];

function SectionRow({ title, eyebrow, items, onSelect, savedIds, onToggleSave }: { title: string; eyebrow?: string; items: Movie[]; onSelect: (movie: Movie) => void; savedIds: number[]; onToggleSave: (movie: Movie) => void }) {
  return (
    <section className="mb-9">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          {eyebrow && <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#a7a7a3]">{eyebrow}</p>}
          <h2 className="text-lg font-bold tracking-tight text-[#f4f4f1] sm:text-xl">{title}</h2>
        </div>
        <button className="hidden items-center gap-1 text-xs font-semibold text-[#aaa9a5] transition hover:text-white sm:flex">View all <ChevronRight className="h-3.5 w-3.5" /></button>
      </div>
      <div className="catalog-row">
        {items.map((movie) => (
          <article key={`${title}-${movie.id}`} className="catalog-card group">
            <button onClick={() => onSelect(movie)} className="relative block w-full text-left">
              <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-[#18181c]">
                <img loading="lazy" decoding="async" src={movie.poster} alt={movie.title} className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.04]" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/10 opacity-70" />
                <span className="absolute bottom-2 left-2 flex items-center gap-1 text-[10px] font-semibold text-white"><Star className="h-3 w-3 fill-[#d7d7d3] text-[#d7d7d3]" /> {movie.score}</span>
                <span className="absolute right-2 top-2 rounded-full bg-black/55 p-1.5 text-white opacity-0 backdrop-blur transition group-hover:opacity-100"><Play className="h-3 w-3 fill-current" /></span>
              </div>
              <h3 className="mt-2 line-clamp-1 text-xs font-semibold text-[#eee]">{movie.title}</h3>
              <p className="mt-1 text-[10px] text-[#8d8d91]">{movie.year} · {movie.genre[0]}</p>
            </button>
            <button onClick={() => onToggleSave(movie)} aria-label={savedIds.includes(movie.id) ? `Remove ${movie.title}` : `Save ${movie.title}`} className={`absolute right-2 top-2 rounded-full p-1.5 backdrop-blur transition ${savedIds.includes(movie.id) ? "bg-[#d7d7d3] text-[#0b0b0e]" : "bg-black/50 text-white opacity-0 group-hover:opacity-100"}`}>
              {savedIds.includes(movie.id) ? <Check className="h-3 w-3" /> : <Bookmark className="h-3 w-3" />}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  const { user, isAuthenticated, logout } = useAuth();
  const [search, setSearch] = useState("");
  const [activeGenre, setActiveGenre] = useState("All");
  const [activeView, setActiveView] = useState("Movies");
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [savedIds, setSavedIds] = useState<number[]>([4, 7]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);

  const filteredMovies = useMemo(() => movies.filter((movie) => {
    const matchesGenre = activeGenre === "All" || movie.genre.includes(activeGenre);
    return matchesGenre && matchesMovieSearch(movie, search.trim().toLowerCase());
  }), [activeGenre, search]);

  const toggleSaved = (movie: Movie) => {
    setSavedIds((current) => current.includes(movie.id) ? current.filter((id) => id !== movie.id) : [...current, movie.id]);
    toast.info("Saved in this preview only; persistent watchlists are not connected.", { duration: 2200 });
  };

  const showMood = (mood: string) => {
    if (mood === "Under 90 minutes") setSearch("Night Shift");
    else if (mood === "Something romantic") setActiveGenre("Romance");
    else if (mood === "Something intense") setActiveGenre("Crime");
    else setSearch("");
    setDiscoverOpen(false);
  };

  const rowSets = [
    { title: "Trending Now", items: filteredMovies },
    { title: "Popular on LeNium", items: [...movies].sort((a, b) => b.score - a.score) },
    { title: "Recently Added", items: [...movies].sort((a, b) => b.year - a.year) },
    { title: "Because You Watched…", items: movies.slice(2).concat(movies.slice(0, 2)) },
    { title: "Top Rated", items: [...movies].sort((a, b) => b.score - a.score) },
    { title: "Hidden Gems", items: movies.filter((movie) => movie.score < 8.2).concat(movies.slice(0, 2)) },
    { title: "Classic Cinema", items: movies.filter((movie) => movie.year < 2023).concat(movies.slice(0, 2)) },
    { title: "Independent Films", items: movies.filter((movie) => movie.genre.includes("Indie") || movie.id % 2 === 1) },
    { title: "Documentaries", items: movies.filter((movie) => movie.genre.includes("Documentary")) },
    { title: "Short Films", items: movies.filter((movie) => movie.runtime.includes("1h 2") || movie.runtime.includes("1h 3")).concat(movies.slice(0, 2)) },
  ];

  return (
    <div className="min-h-screen bg-[#0b0b0e] text-[#f1f1ee]">
      <div className="border-b border-white/10 bg-[#d7d7d3] px-4 py-1.5 text-center text-[9px] font-bold uppercase tracking-[0.16em] text-[#0b0b0e]">Preview only · Fixture catalogue · No real ratings, rights, or playback</div>
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0b0b0e]/95 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1480px] items-center gap-5 px-4 sm:px-6 lg:px-8">
          <button onClick={() => { setActiveView("Movies"); setSearch(""); }} className="flex shrink-0 items-center gap-2" aria-label="LeNium home"><span className="grid h-8 w-8 place-items-center rounded-full bg-[#d7d7d3] text-[#0b0b0e]"><CirclePlay className="h-4 w-4 fill-current" /></span><span className="text-base font-bold tracking-tight">LeNium<span className="text-[#d7d7d3]">.</span></span></button>
          <nav className="hidden items-center gap-5 text-xs font-semibold text-[#aaa9a5] md:flex"><button onClick={() => setActiveView("Movies")} className={activeView === "Movies" ? "text-white" : "hover:text-white"}>Movies</button><button onClick={() => setDiscoverOpen(true)} className="hover:text-white">Discover</button><button onClick={() => setActiveView("Collections")} className={activeView === "Collections" ? "text-white" : "hover:text-white"}>Collections</button></nav>
          <div className="ml-auto flex items-center gap-2"><div className="hidden items-center gap-2 rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-[#aaa9a5] focus-within:border-white/30 sm:flex"><Search className="h-3.5 w-3.5" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search movies, people, genres" className="w-44 bg-transparent text-xs text-white outline-none placeholder:text-[#77777d]" /></div><button onClick={() => setDiscoverOpen(true)} className="grid h-9 w-9 place-items-center rounded-md border border-white/10 text-[#aaa9a5] hover:text-white md:hidden" aria-label="Open navigation"><Menu className="h-4 w-4" /></button>{isAuthenticated ? <button onClick={() => logout()} className="hidden items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-[#ddd] hover:bg-white/10 sm:flex"><UserRound className="h-3.5 w-3.5" />{user?.name?.split(" ")[0] ?? "Account"}</button> : <button onClick={() => startLogin()} className="rounded-md bg-[#d7d7d3] px-3 py-2 text-xs font-bold text-[#0b0b0e] hover:bg-white">Sign in</button>}</div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] px-4 pb-16 sm:px-6 lg:px-8">
        <section className="relative mt-5 h-[310px] overflow-hidden rounded-xl border border-white/10 bg-[#151519] sm:h-[360px] lg:h-[390px]">
          <img loading="eager" fetchPriority="high" decoding="async" src={movies[0].backdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-55" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#0b0b0e] via-[#0b0b0e]/75 to-transparent" /><div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0e]/75 via-transparent to-transparent" />
          <div className="relative flex h-full max-w-xl flex-col justify-end p-5 pb-7 sm:p-8 lg:p-10"><span className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#d7d7d3]">Featured preview</span><h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Afterlight</h1><div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#d0d0cc]"><span>2024</span><span>·</span><span>1h 52m</span><span>·</span><span>Sci-fi · Drama</span><span className="rounded border border-white/20 px-1.5 py-0.5">16+</span></div><p className="mt-3 max-w-md text-sm leading-5 text-[#c0c0bd]">A lighthouse keeper receives a signal from a city that disappeared beneath the sea.</p><div className="mt-5 flex gap-2"><button onClick={() => setSelectedMovie(movies[0])} className="flex items-center gap-2 rounded-md bg-[#d7d7d3] px-4 py-2.5 text-xs font-bold text-[#0b0b0e] hover:bg-white"><Info className="h-3.5 w-3.5" /> View details</button><button onClick={() => toggleSaved(movies[0])} className="flex items-center gap-2 rounded-md border border-white/20 bg-black/20 px-4 py-2.5 text-xs font-semibold text-white hover:bg-white/10"><Bookmark className="h-3.5 w-3.5" /> Save</button></div></div>
        </section>

        <section className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-2 overflow-x-auto no-scrollbar">{genres.map((genre) => <button key={genre} onClick={() => setActiveGenre(genre)} className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition ${activeGenre === genre ? "bg-[#d7d7d3] text-[#0b0b0e]" : "border border-white/10 text-[#aaa9a5] hover:border-white/25 hover:text-white"}`}>{genre}</button>)}</div><button onClick={() => setDiscoverOpen(true)} className="flex shrink-0 items-center justify-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-[#c4c4c0] hover:bg-white/10"><SlidersHorizontal className="h-3.5 w-3.5" /> Discover filters</button></section>

        {search && <div className="mt-6 flex items-center justify-between rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-[#c4c4c0]"><span>Showing preview results for <strong className="text-white">{search}</strong></span><button onClick={() => setSearch("")} className="text-[#d7d7d3] hover:text-white">Clear</button></div>}

        <div className="mt-8">{activeView === "Collections" ? <section><div className="mb-5 flex items-end justify-between"><div><p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#a7a7a3]">Browse by feeling</p><h2 className="text-2xl font-bold">Collections</h2></div></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{["Classic Cinema", "90-Minute Movies", "Mind-Bending", "Crime", "Great African Cinema", "Hidden Gems", "Award Winners", "Feel-Good", "Late Night", "Weekend Movies"].map((collection, index) => <button key={collection} onClick={() => { setActiveView("Movies"); setSearch(index % 2 ? "" : collection.split(" ")[0]); }} className="group relative h-32 overflow-hidden rounded-lg border border-white/10 bg-[#17171b] p-4 text-left hover:border-white/25"><img loading="lazy" src={movies[index % movies.length].backdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25 transition group-hover:scale-105 group-hover:opacity-40" /><span className="relative text-sm font-bold">{collection}</span><span className="absolute bottom-3 right-3 text-[#d7d7d3]"><ChevronRight className="h-4 w-4" /></span></button>)}</div></section> : (search || activeGenre !== "All" ? [{ title: search ? "Search results" : `${activeGenre} movies`, items: filteredMovies }] : rowSets).map((row, index) => <SectionRow key={row.title} title={row.title} eyebrow={index === 0 ? "Find something worth watching" : undefined} items={row.items} onSelect={setSelectedMovie} savedIds={savedIds} onToggleSave={toggleSaved} />)}</div>
        {filteredMovies.length === 0 && <div className="py-20 text-center"><Search className="mx-auto mb-3 h-7 w-7 text-[#77777d]" /><h2 className="text-lg font-bold">No preview matches</h2><p className="mt-2 text-sm text-[#8d8d91]">Try another title, director, or genre.</p></div>}
      </main>

      <footer className="border-t border-white/10 px-4 py-8 text-xs text-[#77777d]"><div className="mx-auto flex max-w-[1480px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><span>LeNium preview experience</span><span>Real catalogue, rights, and playback integrations are not connected.</span></div></footer>

      {discoverOpen && <div className="fixed inset-0 z-50 bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Discover films" onClick={() => setDiscoverOpen(false)}><div onClick={(event) => event.stopPropagation()} className="mx-auto mt-20 max-w-2xl rounded-xl border border-white/10 bg-[#151519] p-5 shadow-2xl"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#d7d7d3]">Discovery</p><h2 className="mt-1 text-xl font-bold">What are you in the mood for?</h2></div><button onClick={() => setDiscoverOpen(false)} aria-label="Close discovery" className="rounded-md p-2 text-[#aaa9a5] hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button></div><div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">{moods.map((mood) => <button key={mood} onClick={() => showMood(mood)} className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-left text-xs font-semibold text-[#ddd] transition hover:border-white/25 hover:bg-white/10"><Sparkles className="mb-3 h-4 w-4 text-[#d7d7d3]" />{mood}</button>)}</div><div className="mt-5 grid grid-cols-2 gap-2 text-xs text-[#aaa9a5]"><div className="rounded-lg border border-white/10 p-3"><Filter className="mb-2 h-4 w-4" />Genre, year, runtime</div><div className="rounded-lg border border-white/10 p-3"><Search className="mb-2 h-4 w-4" />Movies, actors, directors</div></div></div></div>}

      {selectedMovie && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={`${selectedMovie.title} preview details`} onClick={() => setSelectedMovie(null)}><div onClick={(event) => event.stopPropagation()} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-xl border border-white/10 bg-[#151519] shadow-2xl sm:rounded-xl"><div className="relative h-48 overflow-hidden sm:h-60"><img loading="lazy" src={selectedMovie.backdrop} alt="" className="h-full w-full object-cover" /><div className="absolute inset-0 bg-gradient-to-t from-[#151519] to-transparent" /><button onClick={() => setSelectedMovie(null)} aria-label="Close details" className="absolute right-3 top-3 rounded-full bg-black/50 p-2 text-white"><X className="h-4 w-4" /></button><h2 className="absolute bottom-5 left-5 text-3xl font-bold">{selectedMovie.title}</h2></div><div className="p-5"><div className="flex flex-wrap items-center gap-2 text-xs text-[#aaa9a5]"><span className="flex items-center gap-1 text-[#d7d7d3]"><Star className="h-3.5 w-3.5 fill-current" /> Preview score {selectedMovie.score}</span><span>·</span><span>{selectedMovie.year}</span><span>·</span><span>{selectedMovie.runtime}</span><span className="rounded border border-white/20 px-1.5">Preview rating {selectedMovie.rating}</span></div><p className="mt-4 text-sm leading-6 text-[#c5c5c1]">{selectedMovie.synopsis}</p><p className="mt-3 text-xs text-[#8e8e92]">Preview director: <span className="text-[#ddd]">{selectedMovie.director}</span> · {selectedMovie.genre.join(" · ")}</p><div className="mt-5 flex flex-wrap gap-2"><button onClick={() => toast.info(getPlaybackUnavailableState().message, { duration: 3000 })} className="flex items-center gap-2 rounded-md border border-white/15 px-4 py-2.5 text-xs font-semibold hover:bg-white/10"><Play className="h-3.5 w-3.5" /> Playback unavailable</button><button onClick={() => toggleSaved(selectedMovie)} className="flex items-center gap-2 rounded-md bg-[#d7d7d3] px-4 py-2.5 text-xs font-bold text-[#0b0b0e] hover:bg-white"><Bookmark className="h-3.5 w-3.5" /> Save in preview</button></div><div className="mt-5 grid grid-cols-3 gap-2 text-[11px] text-[#8e8e92]"><div className="rounded-md border border-white/10 p-3">Audio<br /><strong className="text-[#ddd]">Not configured</strong></div><div className="rounded-md border border-white/10 p-3">Subtitles<br /><strong className="text-[#ddd]">Not configured</strong></div><div className="rounded-md border border-white/10 p-3">Availability<br /><strong className="text-[#ddd]">Not available</strong></div></div></div></div></div>}
    </div>
  );
}
