import { useEffect, useRef, useState } from "react";
import { LogOut, Lock, Plus, Settings, ShieldCheck, Users } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import { ProfileAvatar } from "@/components/profile/ProfileAvatar";

/**
 * Top-right profile entry point: renders the active profile avatar and opens a
 * Netflix-style floating dropdown with a profile switcher, manage/account
 * links, and sign out.
 */
export function ProfileMenu() {
  const { user, isLoading, logout } = useAuth();
  const { profiles, activeProfile, selectProfile, unlockProfile } = useActiveProfile();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  // A locked profile is one with a PIN. The switcher used to render those tiles
  // `disabled` with no way to unlock, so a PIN set on a kids profile made it
  // permanently unreachable -- the unlock endpoint existed and had no caller.
  const [unlocking, setUnlocking] = useState<{ id: string; name: string } | null>(null);
  const [pin, setPin] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [open]);

  if (!user) {
    // While the stored session is being validated, render a quiet placeholder
    // instead of flashing "Sign In" at signed-in users.
    if (isLoading) {
      return (
        <div
          aria-hidden
          className="grid h-9 w-9 animate-pulse place-items-center rounded-full border border-white/10 bg-white/10"
        />
      );
    }
    return (
      <Link
        href="/login"
        className="rounded-md bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
      >
        Sign In
      </Link>
    );
  }

  const displayName = activeProfile?.name ?? user.name;

  const handleSwitch = (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    if (profile.isLocked) {
      // Ask for the PIN instead of silently refusing.
      setUnlocking({ id: profile.id, name: profile.name });
      setPin("");
      setPinError(null);
      return;
    }
    selectProfile(profile);
    setOpen(false);
  };

  const submitPin = async () => {
    if (!unlocking || pinBusy) return;
    setPinBusy(true);
    setPinError(null);
    const ok = await unlockProfile(unlocking.id, pin);
    setPinBusy(false);
    if (!ok) {
      setPinError("That PIN did not match.");
      setPin("");
      return;
    }
    const profile = profiles.find((p) => p.id === unlocking.id);
    if (profile) selectProfile(profile);
    setUnlocking(null);
    setPin("");
    setOpen(false);
  };

  const handleSignOut = () => {
    setOpen(false);
    void logout().then(() => navigate("/"));
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close profile menu" : `Profile menu: ${displayName}`}
        className="grid h-9 w-9 place-items-center overflow-hidden rounded-full border border-white/15 bg-white/[0.08] text-white transition hover:bg-white/20"
      >
        {/* One tile, not an image plus a sibling initial: the initials have to
            be a Radix fallback so they appear only when the image fails,
            rather than being an either/or branch that can disagree with it. */}
        <ProfileAvatar
          className="h-9 w-9"
          alt=""
          profile={
            activeProfile ?? { name: displayName, avatar: user.avatar_url ?? null }
          }
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-3 w-56 rounded-xl border border-zinc-800 bg-zinc-900/90 p-2 shadow-2xl backdrop-blur-xl">
          {/* Active identity */}
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <ProfileAvatar
              className="h-10 w-10"
              square
              alt=""
              profile={
                activeProfile ?? { name: displayName, avatar: user.avatar_url ?? null }
              }
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">
                {displayName}
              </p>
              <p className="truncate text-[11px] text-zinc-400">{user.email}</p>
            </div>
          </div>

          {/* Profile switcher */}
          {profiles.length > 0 && (
            <div className="mt-1 border-t border-zinc-800 pt-2">
              <p className="px-2 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                Switch profile
              </p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {profiles.slice(0, 6).map((profile) => {
                  const isActive = profile.id === activeProfile?.id;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => handleSwitch(profile.id)}
                      // A locked profile is a real target now: clicking it opens
                      // the PIN prompt. It was `disabled`, so a profile with a PIN
                      // could never be unlocked from the only place it appears.
                      aria-label={
                        profile.isLocked
                          ? `Unlock ${profile.name}`
                          : `Switch to ${profile.name}`
                      }
                      className={`relative flex flex-col items-center gap-1 rounded-lg border p-2 transition ${
                        isActive
                          ? "border-zinc-600 bg-zinc-800"
                          : "border-zinc-800 bg-zinc-900 hover:border-zinc-600 hover:bg-zinc-800/60"
                      }`}
                    >
                      {/* Was a bare <img> with no fallback, so a profile with a
                          missing or unreachable avatar rendered a broken-image
                          glyph on a bare tile. */}
                      <ProfileAvatar className="h-9 w-9" square alt="" profile={profile} />
                      <span className="w-full truncate text-center text-[10px] leading-3 text-zinc-300">
                        {profile.name}
                      </span>
                      {profile.isLocked && (
                        <Lock
                          className="absolute right-1 top-1 h-3 w-3 text-zinc-400"
                          aria-hidden
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <nav className="mt-1 border-t border-zinc-800 pt-1">
            <Link
              href="/profile#manage-profiles"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 hover:text-white"
            >
              <Users className="h-4 w-4" />
              Manage Profiles
            </Link>
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 hover:text-white"
            >
              <Settings className="h-4 w-4" />
              Account &amp; Settings
            </Link>
            <button
              type="button"
              onClick={() => {
                // Went nowhere before: the handler only closed the menu, so a
                // button labelled "Add Profile" silently did nothing. It goes to
                // the manage-profiles section that actually has the form.
                setOpen(false);
                navigate("/profile#manage-profiles");
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 hover:text-white"
            >
              <Plus className="h-4 w-4" />
              Add Profile
            </button>
            {/* Shown only to accounts on the backend's ADMIN_EMAILS allowlist,
                computed server-side and carried on the signed-in user. Purely a
                convenience: hiding it keeps the link out of a viewer's menu, and
                the endpoint refuses a viewer either way. */}
            {user.is_admin && (
              <Link
                href="/admin/users"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 hover:text-white"
              >
                <ShieldCheck className="h-4 w-4" />
                Accounts
              </Link>
            )}
          </nav>

          <div className="my-1 border-t border-zinc-800" />

          <button
            type="button"
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-500/10 hover:text-red-300"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>

          {unlocking && (
            <div className="mt-2 rounded-lg border border-zinc-700 bg-zinc-800/80 p-3">
              <label
                htmlFor="profile-unlock-pin"
                className="flex items-center gap-2 text-xs font-medium text-zinc-200"
              >
                <Lock className="h-3.5 w-3.5" aria-hidden />
                Enter the PIN for {unlocking.name}
              </label>
              <input
                id="profile-unlock-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                autoFocus
                value={pin}
                onChange={(e) => {
                  setPin(e.target.value.replace(/\D/g, ""));
                  setPinError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitPin();
                  if (e.key === "Escape") setUnlocking(null);
                }}
                aria-invalid={pinError ? true : undefined}
                aria-describedby={pinError ? "profile-unlock-error" : undefined}
                className="mt-2 w-full rounded-md border border-zinc-600 bg-black/40 px-3 py-2 text-sm tracking-[0.3em] text-white outline-none focus:border-violet-500"
              />
              {pinError && (
                <p
                  id="profile-unlock-error"
                  role="alert"
                  className="mt-1.5 text-xs text-red-300"
                >
                  {pinError}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void submitPin()}
                  disabled={pinBusy || pin.length !== 4}
                  className="flex-1 rounded-md bg-white px-3 py-1.5 text-xs font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {pinBusy ? "Checking…" : "Unlock"}
                </button>
                <button
                  type="button"
                  onClick={() => setUnlocking(null)}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}