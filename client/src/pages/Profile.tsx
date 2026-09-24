import { useCallback, useEffect, useState } from "react";
import { Plus, Lock, User, Settings, X, Clock, Trash2, LogIn, UserPlus } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import {
  apiHistory,
  apiHistoryClear,
  apiHistoryRemove,
  type RemoteHistoryItem,
} from "@/services/auth";

interface ProfileData {
  id: string;
  name: string;
  avatar: string;
  isKids: boolean;
  isLocked: boolean;
}

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

export default function ProfilePage() {
  const { user, isLoading: authLoading, login, signup, logout } = useAuth();
  const [location, navigate] = useLocation();
  const [profiles, setProfiles] = useState<ProfileData[]>([]);
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileIsKids, setNewProfileIsKids] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    if (!authLoading && user) {
      const stored = localStorage.getItem(`lenium-profiles-${user.id}`);
      if (stored) {
        try {
          setProfiles(JSON.parse(stored));
        } catch {
          setProfiles([]);
        }
      }
      void loadHistory();
    }
  }, [user, authLoading, loadHistory]);

  const saveProfiles = (newProfiles: ProfileData[]) => {
    if (user) {
      localStorage.setItem(`lenium-profiles-${user.id}`, JSON.stringify(newProfiles));
      setProfiles(newProfiles);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setAuthError("Enter a valid email address");
      return;
    }
    if (password.length < 8) {
      setAuthError("Password must be at least 8 characters");
      return;
    }
    if (authMode === "signup" && name.trim().length === 0) {
      setAuthError("Enter your name");
      return;
    }
    setIsSubmitting(true);
    try {
      if (authMode === "signup") {
        await signup({ name: name.trim(), email, password });
      } else {
        await login({ email, password });
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSelectProfile = (profile: ProfileData) => {
    if (profile.isLocked) return;
    localStorage.setItem(`lenium-active-profile-${user?.id}`, JSON.stringify(profile));
    navigate("/");
  };

  const handleAddProfile = () => {
    if (!newProfileName.trim() || isCreating) return;
    setIsCreating(true);
    const newProfile: ProfileData = {
      id: crypto.randomUUID(),
      name: newProfileName.trim(),
      avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(newProfileName.trim())}`,
      isKids: newProfileIsKids,
      isLocked: false,
    };
    const updated = [...profiles, newProfile];
    saveProfiles(updated);
    setShowAddProfile(false);
    setNewProfileName("");
    setNewProfileIsKids(false);
    setIsCreating(false);
  };

  const handleDeleteProfile = (profileId: string) => {
    const updated = profiles.filter(p => p.id !== profileId);
    saveProfiles(updated);
  };

  const handleRemoveHistory = async (movieKey: string) => {
    try {
      await apiHistoryRemove(movieKey);
      setHistory(h => h.filter((item) => item.movie_key !== movieKey));
    } catch {
      // ignore
    }
  };

  const handleClearHistory = async () => {
    try {
      await apiHistoryClear();
      setHistory([]);
    } catch {
      // ignore
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="text-center mb-10">
            <div className="mx-auto w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center mb-6">
              <span className="text-2xl font-black text-white">L</span>
            </div>
            <h1 className="text-3xl font-bold text-white">Welcome to Lenium Movies</h1>
            <p className="mt-2 text-zinc-400">Sign in or create an account to continue</p>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-sm p-6">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-950/60 p-1 mb-6">
              <button
                type="button"
                onClick={() => { setAuthMode("signin"); setAuthError(null); }}
                className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold transition ${
                  authMode === "signin" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"
                }`}
              >
                <LogIn className="h-4 w-4" />
                Sign In
              </button>
              <button
                type="button"
                onClick={() => { setAuthMode("signup"); setAuthError(null); }}
                className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold transition ${
                  authMode === "signup" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"
                }`}
              >
                <UserPlus className="h-4 w-4" />
                Sign Up
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {authMode === "signup" && (
                <div>
                  <label htmlFor="auth-name" className="block text-sm font-medium text-zinc-300 mb-2">
                    Display Name
                  </label>
                  <input
                    id="auth-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="How should we address you?"
                    autoComplete="name"
                    className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/50 px-4 py-3 text-white placeholder-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    autoFocus
                    maxLength={40}
                  />
                </div>
              )}
              <div>
                <label htmlFor="auth-email" className="block text-sm font-medium text-zinc-300 mb-2">
                  Email
                </label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/50 px-4 py-3 text-white placeholder-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  autoFocus={authMode === "signin"}
                  maxLength={254}
                />
              </div>
              <div>
                <label htmlFor="auth-password" className="block text-sm font-medium text-zinc-300 mb-2">
                  Password
                </label>
                <input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                  className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/50 px-4 py-3 text-white placeholder-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  maxLength={128}
                />
              </div>

              {authError && (
                <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {authError}
                </p>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Please wait...
                  </>
                ) : authMode === "signup" ? "Create Account" : "Sign In"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur sticky top-0 z-40">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-xl font-black text-white ring-1 ring-inset ring-white/20">
                L
              </span>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">Profile</h1>
              <p className="mt-0.5 truncate text-sm text-zinc-500">{user.name} · {user.email}</p>
            </div>
          </div>
          <button
            onClick={() => void logout()}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-zinc-700/70 px-3.5 py-2 text-xs font-semibold text-zinc-300 transition hover:border-zinc-500 hover:bg-white/5 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
            Sign Out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">Who is watching today?</h2>
          <p className="mt-2 text-zinc-400">Pick a profile to start streaming</p>
        </div>

        {showAddProfile ? (
          <div className="max-w-md mx-auto">
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-sm p-6">
              <h3 className="text-lg font-bold text-white mb-6">Create New Profile</h3>
              <div className="space-y-4">
                <div>
                  <label htmlFor="profile-name" className="block text-sm font-medium text-zinc-300 mb-2">
                    Profile Name
                  </label>
                  <input
                    id="profile-name"
                    type="text"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    placeholder="Enter name"
                    className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/50 px-4 py-3 text-white placeholder-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    autoFocus
                    maxLength={20}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <input
                    id="profile-kids"
                    type="checkbox"
                    checked={newProfileIsKids}
                    onChange={(e) => setNewProfileIsKids(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500"
                  />
                  <label htmlFor="profile-kids" className="text-sm font-medium text-zinc-300 cursor-pointer">
                    Kids Profile
                  </label>
                  {newProfileIsKids && (
                    <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-amber-500/20 border border-amber-500/30 rounded text-amber-400">
                      Content restricted
                    </span>
                  )}
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => { setShowAddProfile(false); setNewProfileName(""); setNewProfileIsKids(false); }}
                    className="flex-1 rounded-lg border border-zinc-700/60 px-4 py-3 text-sm font-semibold text-zinc-300 transition hover:border-zinc-500 hover:bg-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddProfile}
                    disabled={!newProfileName.trim() || isCreating}
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isCreating ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4" />
                        Create Profile
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  onClick={() => handleSelectProfile(profile)}
                  disabled={profile.isLocked}
                  className={`relative group aspect-square rounded-2xl overflow-hidden border-2 transition-all duration-300 ${
                    profile.isLocked
                      ? "border-zinc-700/50 opacity-60 cursor-not-allowed"
                      : "border-zinc-800 hover:border-indigo-500/50 hover:shadow-[0_0_30px_rgba(99,102,241,0.3)]"
                  }`}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  <img
                    src={profile.avatar}
                    alt={profile.name}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
                  <div className="absolute bottom-0 left-0 right-0 p-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-bold text-white">{profile.name}</h3>
                      {profile.isKids && (
                        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-amber-500/20 border border-amber-500/30 rounded-full text-amber-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                          Kids
                        </span>
                      )}
                    </div>
                    {profile.isLocked && (
                      <div className="mt-2 flex items-center gap-1.5 text-zinc-400">
                        <Lock className="h-3.5 w-3.5" />
                        <span className="text-sm">Locked</span>
                      </div>
                    )}
                  </div>
                  {!profile.isLocked && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteProfile(profile.id);
                      }}
                      className="absolute top-2 right-2 p-1.5 rounded-full bg-black/60 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400 hover:bg-red-500/20"
                      aria-label="Delete profile"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </button>
              ))}

              <button
                onClick={() => setShowAddProfile(true)}
                className="relative aspect-square rounded-2xl border-2 border-dashed border-zinc-700/50 hover:border-indigo-500/50 hover:bg-white/5 transition-all duration-300 flex flex-col items-center justify-center gap-3"
              >
                <div className="grid h-16 w-16 place-items-center rounded-xl bg-white/5 border border-white/10">
                  <Plus className="h-7 w-7 text-zinc-400 group-hover:text-indigo-400 transition-colors" />
                </div>
                <span className="text-lg font-semibold text-zinc-300 group-hover:text-white transition-colors">
                  Add Profile
                </span>
              </button>
            </div>

            {profiles.length === 0 && (
              <div className="mt-12 text-center">
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-sm p-12 max-w-md mx-auto">
                  <div className="mx-auto w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-indigo-700/20 flex items-center justify-center mb-6">
                    <User className="h-10 w-10 text-indigo-400" />
                  </div>
                  <h3 className="text-xl font-bold text-white">No profiles yet</h3>
                  <p className="mt-2 text-zinc-400">Create your first profile to start watching</p>
                  <button
                    onClick={() => setShowAddProfile(true)}
                    className="mt-6 inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-indigo-500"
                  >
                    <Plus className="h-5 w-5" />
                    Create Profile
                  </button>
                </div>
              </div>
            )}

            <div className="mt-12 pt-8 border-t border-zinc-800/50">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  Watch History
                </h3>
                {history.length > 0 && (
                  <button
                    onClick={() => void handleClearHistory()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/70 px-3 py-1.5 text-xs font-semibold text-zinc-400 transition hover:border-red-500/50 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear History
                  </button>
                )}
              </div>

              {historyLoading ? (
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-sm p-8 text-center">
                  <div className="mx-auto h-6 w-6 border-2 border-zinc-700 border-t-white rounded-full animate-spin" />
                </div>
              ) : history.length === 0 ? (
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-sm p-8 text-center">
                  <p className="text-zinc-400">Nothing watched yet. Titles you play will show up here.</p>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {history.map((item) => (
                    <div
                      key={item.movie_key}
                      className="flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-sm p-3"
                    >
                      {item.poster ? (
                        <img
                          src={item.poster}
                          alt={item.title}
                          className="h-16 w-11 shrink-0 rounded-md object-cover"
                        />
                      ) : (
                        <div className="h-16 w-11 shrink-0 rounded-md bg-zinc-800 grid place-items-center">
                          <span className="text-xs font-bold text-zinc-500">{item.title.slice(0, 1)}</span>
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-white">{item.title}</p>
                        {item.year ? (
                          <p className="mt-0.5 text-xs text-zinc-500">{item.year}</p>
                        ) : null}
                        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                          <span>{formatProgress(item)}</span>
                          <span className="text-zinc-600">·</span>
                          <span>{formatTimestamp(item.watched_at)}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveHistory(item.movie_key)}
                        className="shrink-0 p-2 rounded-lg text-zinc-500 transition hover:text-red-400 hover:bg-red-500/10"
                        aria-label={`Remove ${item.title} from history`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-12 pt-8 border-t border-zinc-800/50">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Parental Settings
              </h3>
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-sm p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-lg bg-zinc-800/50">
                      <Lock className="h-5 w-5 text-zinc-400" />
                    </div>
                    <div>
                      <p className="font-semibold text-white">Profile Lock</p>
                      <p className="text-sm text-zinc-400">Require PIN to switch profiles</p>
                    </div>
                  </div>
                  <button
                    onClick={() => {}}
                    className="relative h-6 w-11 shrink-0 rounded-full bg-zinc-700/60 transition-colors"
                    aria-label="Profile lock toggle"
                  >
                    <span className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-all" />
                  </button>
                </div>
                <p className="mt-4 text-sm text-zinc-500">
                  Set a PIN in account settings to enable profile locking for kids profiles.
                </p>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}