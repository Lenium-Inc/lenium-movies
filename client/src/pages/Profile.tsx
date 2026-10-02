import { useCallback, useEffect, useState } from "react";
import { Plus, Clock, Trash2, X, PenLine, UserX } from "lucide-react";
import { Link, useLocation } from "wouter";
import { BrandLockup } from "@/components/brand/Brand";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
import { AddProfileForm } from "@/components/profile/AddProfileForm";
import { EditProfileModal } from "@/components/profile/EditProfileModal";
import { ProfileAvatar } from "@/components/profile/ProfileAvatar";
import {
  apiDeleteAccount,
  apiHistory,
  apiHistoryClear,
  apiHistoryRemove,
  AuthApiError,
  type RemoteHistoryItem,
} from "@/services/auth";
import type { ProfileData } from "@/services/profiles";

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
    const pct = Math.round(
      (item.progress_seconds / item.duration_seconds) * 100
    );
    return `${pct}% watched`;
  }
  return "Watched";
}

/**
 * Account & profile management: switch/add/delete profiles, watch history, and
 * sign out. Auth itself lives on /login and /signup.
 */
export default function ProfilePage() {
  const { user, isLoading: authLoading } = useAuth();
  const { profiles, activeProfile, selectProfile, deleteProfile } =
    useActiveProfile();
  const [location, navigate] = useLocation();

  const [showAddProfile, setShowAddProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ProfileData | null>(
    null
  );

  const [history, setHistory] = useState<RemoteHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Account deletion. The panel is closed by default and requires typing the
  // account email plus the password, because the endpoint asks for both and
  // because this is the one irreversible control on the page.
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

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

  // The profile dropdown links here as /profile#manage-profiles. Wouter
  // handles the route client-side, so the browser never performs its own
  // fragment jump and the grid has to be scrolled to explicitly.
  useEffect(() => {
    if (location !== "/profile") return;
    if (window.location.hash !== "#manage-profiles") return;
    document
      .getElementById("manage-profiles")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [location]);

  const handleRemoveHistory = async (movieKey: string) => {
    try {
      await apiHistoryRemove(movieKey);
      setHistory(h => h.filter(item => item.movie_key !== movieKey));
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

  const closeDeleteAccount = () => {
    setShowDeleteAccount(false);
    setDeleteEmail("");
    setDeletePassword("");
    setDeleteError(null);
  };

  const handleDeleteAccount = async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDeleteAccount({
        email: deleteEmail.trim(),
        password: deletePassword,
      });
      // On success every session is already revoked server-side, so there is
      // nothing to clean up but this page's state.
      closeDeleteAccount();
      navigate("/");
    } catch (error) {
      // The endpoint's message is the useful one -- wrong password, wrong
      // address, or a transient failure -- so it is shown rather than replaced
      // with a generic apology.
      setDeleteError(
        error instanceof AuthApiError
          ? error.message
          : "Could not delete the account. Try again."
      );
    } finally {
      setDeleteBusy(false);
    }
  };

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-white" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="relative min-h-screen overflow-hidden text-white">
      {/* Ambient backdrop glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.18),transparent)] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full bg-[radial-gradient(closest-side,rgba(217,70,239,0.10),transparent)] blur-3xl"
      />

      <header className="sv-chrome sticky top-0 z-40 border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="shrink-0 rounded-md text-white"
            aria-label="Stream Vy home"
          >
            <BrandLockup size="sm" />
          </Link>
          {/* Same single avatar + dropdown as the app navbar, so profile
              controls are not duplicated on this page. */}
          <ProfileMenu />
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Account */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-xl sm:p-8">
          <div className="flex flex-wrap items-center gap-4">
            {/* Account avatar. Always renders through the same component as
                profile avatars so the initials fallback appears on a failed
                image load, not only when `avatar_url` is absent. */}
            <ProfileAvatar
              className="h-14 w-14 ring-1 ring-white/15"
              square
              alt=""
              profile={{ name: user.name, avatar: user.avatar_url ?? null }}
            />
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
            <div className="ml-auto">
              <button
                type="button"
                onClick={() =>
                  showDeleteAccount
                    ? closeDeleteAccount()
                    : setShowDeleteAccount(true)
                }
                aria-expanded={showDeleteAccount}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/50 transition hover:border-red-500/50 hover:text-red-400"
              >
                <UserX className="h-3.5 w-3.5" />
                {showDeleteAccount ? "Cancel" : "Delete account"}
              </button>
            </div>
          </div>

          {/* Deletion is destructive and irreversible, so it is behind its own
              disclosure and asks for both the account email and the password.
              The endpoint requires the same pair: the session token is a
              long-lived bearer credential, so a token alone must not be able to
              destroy someone's history. */}
          {showDeleteAccount ? (
            <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/[0.06] p-5">
              <h2 className="text-sm font-bold text-white">
                Delete this account permanently
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-white/60">
                This erases your account and everything attached to it: every
                profile, watch history entry, My List item, taste signal used
                for recommendations, referral code and shared list membership.
                It cannot be undone, and we cannot restore it.
              </p>
              <div className="mt-4 grid gap-3 sm:max-w-md">
                <label className="block">
                  <span className="text-xs font-semibold text-white/70">
                    Confirm your email
                  </span>
                  <input
                    type="email"
                    value={deleteEmail}
                    onChange={event => setDeleteEmail(event.target.value)}
                    placeholder={user.email}
                    autoComplete="username"
                    className="mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-red-400/60 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold text-white/70">
                    Your password
                  </span>
                  <input
                    type="password"
                    value={deletePassword}
                    onChange={event => setDeletePassword(event.target.value)}
                    autoComplete="current-password"
                    className="mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white focus:border-red-400/60 focus:outline-none"
                  />
                </label>
              </div>
              {deleteError ? (
                <p
                  role="alert"
                  className="mt-3 text-xs font-medium text-red-400"
                >
                  {deleteError}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void handleDeleteAccount()}
                disabled={deleteBusy || !deleteEmail.trim() || !deletePassword}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
              >
                <Trash2 className="h-4 w-4" />
                {deleteBusy ? "Deleting…" : "Delete my account"}
              </button>
            </div>
          ) : null}
        </section>

        {/* Manage profiles */}
        <section id="manage-profiles" className="mt-10 scroll-mt-20">
          <h2 className="text-lg font-bold text-white">Manage Profiles</h2>
          <p className="mt-1 text-sm text-white/40">
            Profiles keep everyone's watchlist and history separate.
          </p>

          {showAddProfile ? (
            <div className="mt-6 max-w-2xl">
              <button
                type="button"
                onClick={() => setShowAddProfile(false)}
                className="mb-4 inline-flex items-center gap-2 text-sm text-white/50 transition hover:text-white"
              >
                <X className="h-4 w-4" />
                Cancel
              </button>
              {/* Shared with the /profiles gate so profile creation -- including
                  the avatar picker -- has exactly one implementation. */}
              <AddProfileForm onDone={() => setShowAddProfile(false)} />
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {profiles.map(profile => {
                const isActive = profile.id === activeProfile?.id;
                return (
                  <div key={profile.id} className="group relative">
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
                      aria-label={
                        isActive
                          ? `${profile.name} — active profile`
                          : `Switch to ${profile.name}`
                      }
                    >
                      <div className="relative aspect-square w-full">
                        <ProfileAvatar
                          className="h-full w-full rounded-xl"
                          square
                          alt=""
                          profile={profile}
                        />
                        {profile.isKids && (
                          <span className="absolute left-1.5 top-1.5 rounded bg-amber-500/80 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-black">
                            Kids
                          </span>
                        )}
                      </div>
                    </button>
                    {/* Siblings of the tile button, not children of it: a button
                        nested inside a button is invalid HTML, and browsers
                        reparent it, which breaks the tile's own click target. */}
                    <button
                      type="button"
                      onClick={() => setEditingProfile(profile)}
                      aria-label={`Edit ${profile.name}`}
                      className="absolute left-1.5 top-1.5 z-10 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white/70 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/30 hover:text-white"
                    >
                      <PenLine className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteProfile(profile.id)}
                      aria-label={`Delete ${profile.name}`}
                      className="absolute right-1.5 top-1.5 z-10 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white/70 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:bg-red-500 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
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
                {history.map(item => (
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
                        <p className="mt-0.5 text-xs text-white/40">
                          {item.year}
                        </p>
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

      {editingProfile ? (
        <EditProfileModal
          profile={editingProfile}
          onClose={() => setEditingProfile(null)}
        />
      ) : null}
    </div>
  );
}
