import { Link } from "wouter";
import { Bookmark, Film, UserRound, Plus } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { sortedEntries, subscribeList, type ListTag, type ListEntry } from "@/services/lists";
import { LIST_TAGS } from "@/services/lists";
import { useEffect, useState } from "react";

/**
 * My List page — shows saved titles for authenticated users.
 * Guest mode: shows an inline placeholder with "Sign in to save movies to your list" and a Sign In CTA.
 */
export default function MyList() {
  const { user, isLoading, login } = useAuth();
  const [listFilter, setListFilter] = useState<ListTag | "all">("all");
  const [, setRev] = useState(0);

  useEffect(() => {
    const unsub = subscribeList(() => setRev(r => r + 1));
    return () => unsub();
  }, []);

  const list = sortedEntries(listFilter);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#050505] text-[#FFFFFF] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (!user) {
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
              Sign in to save movies and shows to your personal list. Your saved titles sync across devices and are always ready to watch.
            </p>
            <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => login()}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-indigo-500"
              >
                <UserRound className="h-4 w-4" />
                Sign In
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
              Already have an account? Your list will be waiting for you.
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
              {LIST_TAGS.map(tag => (
                <button
                  key={tag.value}
                  type="button"
                  onClick={() => setListFilter(tag.value)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    listFilter === tag.value
                      ? "bg-indigo-600 text-white"
                      : "border border-white/10 text-white/60 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {tag.label}
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
              Each title can be tagged as Plan to Watch, Favorites, or Watched.
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
            {list.map((entry: ListEntry) => (
              <article
                key={entry.id}
                className="flex gap-4 rounded-xl border border-white/10 bg-white/5 transition hover:border-white/20"
              >
                <Link
                  href={`/watch/${entry.id}`}
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
                      {entry.tag && LIST_TAGS.find(t => t.value === entry.tag)?.label}
                    </p>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    {LIST_TAGS.map(tag => (
                      <button
                        key={tag.value}
                        type="button"
                        onClick={() => setListFilter(tag.value)}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-[0.1em] transition ${
                          entry.tag === tag.value
                            ? "bg-indigo-600 text-white"
                            : "border border-white/10 text-white/50 hover:bg-white/5 hover:text-white"
                        }`}
                      >
                        {tag.label}
                      </button>
                    ))}
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