import { Link } from "wouter";
import { Bookmark, Film, Plus } from "lucide-react";
import { useLocalSession } from "@/context/LocalSessionContext";
import { useEffect, useState } from "react";
import {
  hasRemoteSession,
  pushRemoveToRemote,
  syncSavedFromRemote,
} from "@/services/lists";

export default function MyList() {
  const { hydrated, isAuthenticated, getMyList, removeFromMyList } = useLocalSession();
  const [listFilter, setListFilter] = useState<"all" | "plan" | "favorites" | "watched">("all");
  const [, setRev] = useState(0);

  useEffect(() => {
    const unsub = () => setRev(r => r + 1);
    window.addEventListener("freestream:state-change", unsub);
    return () => window.removeEventListener("freestream:state-change", unsub);
  }, []);

  // Merge the account's Postgres-backed saved_media into the local list once
  // we're signed in and hydrated, so remote saves show up here too.
  const remoteCapable = hasRemoteSession();
  const [syncedRemote, setSyncedRemote] = useState(false);
  useEffect(() => {
    if (!hydrated || !remoteCapable || syncedRemote) return;
    setSyncedRemote(true);
    void syncSavedFromRemote().then(() => setRev(r => r + 1));
  }, [hydrated, remoteCapable, syncedRemote]);

  const list = getMyList().filter(entry => {
    if (listFilter === "all") return true;
    return (entry as any).tag === listFilter;
  });

  if (!hydrated) {
    return (
      <div className="min-h-screen bg-[#050505] text-[#FFFFFF] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#050505] text-[#FFFFFF]">
        <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="text-center">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
              <Bookmark className="h-8 w-8 text-white/50" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              My List
            </h1>
            <p className="mt-4 text-lg text-white/60 max-w-md mx-auto">
              Sign in to save movies and shows to your personal list. Your saved
              titles are stored locally in this browser.
            </p>
            <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => {
                  const { signInDemo } = useLocalSession();
                  signInDemo();
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-indigo-500"
              >
                Continue as Viewer
              </button>
              <Link
                href="/"
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-6 py-3 text-sm font-semibold text-white/80 transition hover:border-white/30 hover:bg-white/5"
              >
                <Film className="h-4 w-4" />
                Browse Catalog
              </Link>
            </div>
            <p className="mt-6 text-sm text-white/40">
              This is a local demo — your data stays in this browser.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-[#FFFFFF]">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white">
                My List
              </h1>
              <p className="mt-1 text-white/50">
                {list.length} title{list.length !== 1 ? "s" : ""} saved
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(["plan", "favorites", "watched"] as const).map(tag => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setListFilter(tag)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    listFilter === tag
                      ? "bg-indigo-600 text-white"
                      : "border border-white/10 text-white/60 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {tag === "plan" ? "Plan to Watch" : tag === "favorites" ? "Favorites" : "Watched"}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setListFilter("all")}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  listFilter === "all"
                    ? "bg-indigo-600 text-white"
                    : "border border-white/10 text-white/60 hover:bg-white/5 hover:text-white"
                }`}
              >
                All
              </button>
            </div>
          </div>
        </header>

        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-12 text-center">
            <Film className="mx-auto h-12 w-12 text-white/30" />
            <h2 className="mt-4 text-xl font-semibold text-white">
              No saved titles yet
            </h2>
            <p className="mt-2 text-white/50 max-w-md mx-auto">
              Start exploring the catalog and save movies or shows to your list.
            </p>
            <Link
              href="/"
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" />
              Browse Catalog
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {list.map((entry: any) => (
              <article
                key={entry.id}
                className="flex gap-4 rounded-xl border border-white/10 bg-white/5 transition hover:border-white/20"
              >
                <Link
                  href={`/watch/${entry.providerId ?? entry.id}`}
                  className="relative shrink-0 overflow-hidden rounded-lg bg-white/10"
                  style={{ width: 112, height: 168 }}
                >
                  {entry.poster ? (
                    <img
                      src={entry.poster}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-white/5 text-white/30">
                      <Film className="h-8 w-8" />
                    </div>
                  )}
                </Link>
                <div className="flex-1 min-w-0 flex flex-col justify-between py-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-white truncate">
                        {entry.title}
                      </h3>
                      {entry.year && (
                        <span className="shrink-0 text-sm text-white/40">
                          {entry.year}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-white/50">
                      {(entry as any).tag &&
                        (["plan", "favorites", "watched"] as const).find(t => t === (entry as any).tag)
                          ? (entry as any).tag
                          : "Plan to Watch"}
                    </p>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        removeFromMyList(entry.id);
                        void pushRemoveToRemote(Number(entry.id ?? entry.providerId ?? 0));
                      }}
                      aria-label={`Remove ${entry.title} from My List`}
                      className="grid h-7 w-7 place-items-center rounded-full text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}