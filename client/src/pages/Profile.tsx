import { useCallback, useEffect, useState } from "react";
import { Plus, Clock, Trash2, X, LogOut, ArrowRight, Play } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import {
  apiHistory,
  apiHistoryClear,
  apiHistoryRemove,
  type RemoteHistoryItem,
} from "@/services/auth";

function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatProgress(item: RemoteHistoryItem): string {
  if (item.duration_seconds && item.progress_seconds) {
    const pct = Math.round((item.progress_seconds / item.duration_seconds) * 100);
    return `${pct}% watched`;
  }
  return "Watched";
}

/**
 * Account & profile management: switch/add/delete profiles, watch history, and
 * sign out. Auth itself lives on /login and /signup.
 */
export default function ProfilePage() {
  const { user, isLoading: authLoading, logout } = useAuth();
  const { profiles, activeProfile, selectProfile, addProfile, deleteProfile } =
    useActiveProfile();
  const [, navigate] = useLocation();

  const [showAddProfile, setShowAddProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileIsKids, setNewProfileIsKids] = useState(false);

  const [history, setHistory] = useState<RemoteHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!user) return;
    setHistoryLoading(true);
    try {
      setHistory(await apiHistory());
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) void loadHistory();
  }, [user, loadHistory]);

  useEffect(() => {
    if (!authLoading && !user) navigate("/login");
  }, [authLoading, user, navigate]);

  const handleAddProfile = () => {
    if (!newProfileName.trim()) return;
    addProfile(newProfileName, newProfileIsKids);
    setShowAddProfile(false);
    setNewProfileName("");
    setNewProfileIsKids(false);
  };

  const handleRemoveHistory = async (movieKey: string) => {
    try {
      await apiHistoryRemove(movieKey);
      setHistory((h) => h.filter((item) => item.movie_key !== movieKey));
    } catch {
      /* ignore */
    }
  };

  const handleClearHistory = async () => {
    try {
      await apiHistoryClear();
      setHistory([]);
    } catch {
      /* ignore */
    }
  };

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050505]">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-white" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#050505] text-white">
      {/* Ambient backdrop glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.18),transparent)] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full bg-[radial-gradient(closest-side,rgba(217,70,239,0.10),transparent)] blur-3xl"
      />

      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#050505]/70 backdrop-blur-[16px]">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-1.5 text-white" aria-label="Stream Vy home">
            <Play className="h-4 w-4" />
            <span className="text-base font-black tracking-tight">Stream Vy</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/profiles"
              className="hidden items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] py-1.5 pl-1 pr-3 text-sm font-medium text-white/80 transition hover:bg-white/15 sm:flex"
            >
              {activeProfile?.avatar ? (
                <img
                  src={activeProfile.avatar}
                  alt=""
                  className="h-7 w-7 rounded-full object-cover"
                />
              ) : (
                <span className="grid h-7 w-7 place-items-center rounded-full bg-white text-xs font-black text-black">
                  {(activeProfile?.name ?? user.name).charAt(0).toUpperCase()}
                </span>
              )}
              {activeProfile?.name ?? user.name}
            </Link>
            <button
              onClick={() => void logout()}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-white/15 px-3.5 py-2 text-xs font-semibold text-white/70 transition hover:border-white/40 hover:text-white"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Account */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-xl sm:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              {user.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt=""
                  className="h-14 w-14 rounded-2xl object-cover ring-1 ring-white/15"
                />
              ) : (
                <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-white to-white/60 text-xl font-black text-black">
                  {user.name.charAt(0).toUpperCase()}
                </span>
              )}
              <div>
                <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
                  {user.name}
                </h1>
                <p className="mt-0.5 text-sm text-white/50">{user.email}</p>
                {activeProfile && activeProfile.name !== user.name && (
                  <p className="mt-1 text-xs text-white/40">
                    Active profile: {activeProfile.name}
                  </p>
                )}
              </div>
            </div>
            <Link
              href="/profiles"
              className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white/80 transition hover:border-white/50 hover:text-white"
            >
              Switch profile
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>

        {/* Manage profiles */}
        <section className="mt-10">
          <h2 className="text-lg font-bold text-white">Manage Profiles</h2>
          <p className="mt-1 text-sm text-white/40">
            Profiles keep everyone's watchlist and history separate.
          </p>

          {showAddProfile ? (
            <div className="mt-6 max-w-md">
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-xl">
                <h3 className="text-lg font-bold text-white">Create Profile</h3>
                <input
                  id="profile-name"
                  type="text"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  placeholder="Profile name"
                  autoFocus
                  maxLength={20}
                  className="mt-4 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-white/30 outline-none transition focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30"
                />
                <label
                  htmlFor="profile-kids"
                  className="mt-4 flex cursor-pointer items-center gap-3 text-sm text-white/70"
                >
                  <input
                    id="profile-kids"
                    type="checkbox"
                    checked={newProfileIsKids}
                    onChange={(e) => setNewProfileIsKids(e.target.checked)}
                    className="h-4 w-4 rounded border-white/30 bg-black/20 accent-indigo-500"
                  />
                  Kids profile (restricted titles)
                </label>
                <div className="mt-6 flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddProfile(false);
                      setNewProfileName("");
                      setNewProfileIsKids(false);
                    }}
                    className="flex-1 rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-white/60 transition hover:border-white/40 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleAddProfile}
                    disabled={!newProfileName.trim()}
                    className="flex-1 rounded-xl bg-white py-3 text-sm font-bold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {profiles.map((profile) => {
                const isActive = profile.id === activeProfile?.id;
                return (
                  <div key={profile.id} className="group">
                    <button
                      type="button"
                      onClick={() => {
                        if (profile.isLocked) return;
                        selectProfile(profile);
                      }}
                      className={`relative w-full overflow-hidden rounded-xl bg-white/[0.04] ring-1 transition ${
                        isActive
                          ? "ring-white/60"
                          : "ring-white/10 group-hover:ring-white/40"
                      } ${profile.isLocked ? "cursor-not-allowed opacity-50" : ""}`}
                      aria-label={isActive ? `${profile.name} — active profile` : `Switch to ${profile.name}`}
                    >
                      <div className="relative aspect-square w-full">
                        <img
                          src={profile.avatar}
                          alt={profile.name}
                          className="h-full w-full object-cover"
                        />
                        {profile.isKids && (
                          <span className="absolute left-1.5 top-1.5 rounded bg-amber-500/80 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-black">
                            Kids
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteProfile(profile.id);
                          }}
                          aria-label={`Delete ${profile.name}`}
                          className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white/70 opacity-0 transition group-hover:opacity-100 hover:bg-violet-500 hover:text-white"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </button>
                    <p className="mt-2 truncate text-center text-sm text-white/60">
                      {profile.name}
                      {isActive ? (
                        <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-white/40">
                          Active
                        </span>
                      ) : null}
                    </p>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={() => setShowAddProfile(true)}
                className="group"
                aria-label="Add profile"
              >
                <div className="grid aspect-square w-full place-items-center rounded-xl border border-dashed border-white/15 text-white/40 transition group-hover:border-white/40 group-hover:text-white">
                  <Plus className="h-8 w-8" />
                </div>
                <p className="mt-2 text-center text-sm text-white/40 transition group-hover:text-white">
                  Add Profile
                </p>
              </button>
            </div>
          )}
        </section>

        {/* Watch history */}
        <section className="mt-10">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold text-white">
              <Clock className="h-5 w-5 text-white/50" />
              Watch History
            </h2>
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => void handleClearHistory()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/50 transition hover:border-violet-500/50 hover:text-violet-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear History
              </button>
            )}
          </div>

          <div className="mt-4">
            {historyLoading ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 text-center backdrop-blur-xl">
                <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
              </div>
            ) : history.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 text-center text-white/40 backdrop-blur-xl">
                Nothing watched yet. Titles you play will show up here.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {history.map((item) => (
                  <div
                    key={item.movie_key}
                    className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 backdrop-blur-xl"
                  >
                    {item.poster ? (
                      <img
                        src={item.poster}
                        alt={item.title}
                        className="h-16 w-11 shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <div className="grid h-16 w-11 shrink-0 place-items-center rounded-md bg-white/10">
                        <span className="text-xs font-bold text-white/50">
                          {item.title.slice(0, 1)}
                        </span>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">
                        {item.title}
                      </p>
                      {item.year ? (
                        <p className="mt-0.5 text-xs text-white/40">{item.year}</p>
                      ) : null}
                      <div className="mt-1 flex items-center gap-2 text-xs text-white/40">
                        <span>{formatProgress(item)}</span>
                        <span className="text-white/20">·</span>
                        <span>{formatTimestamp(item.watched_at)}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRemoveHistory(item.movie_key)}
                      className="shrink-0 rounded-lg p-2 text-white/40 transition hover:bg-violet-500/10 hover:text-violet-400"
                      aria-label={`Remove ${item.title} from history`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}