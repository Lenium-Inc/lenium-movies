import { useEffect, useRef, useState } from "react";
import { LogOut, Plus, Settings, Users } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";

/**
 * Top-right profile entry point: renders the active profile avatar and opens a
 * Netflix-style floating dropdown with a profile switcher, manage/account
 * links, and sign out.
 */
export function ProfileMenu() {
  const { user, isLoading, logout } = useAuth();
  const { profiles, activeProfile, selectProfile } = useActiveProfile();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
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
  const avatar = activeProfile?.avatar;

  const handleSwitch = (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile || profile.isLocked) return;
    selectProfile(profile);
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
        aria-label={open ? "Close profile menu" : "Profile menu"}
        className="grid h-9 w-9 place-items-center overflow-hidden rounded-full border border-white/15 bg-white/[0.08] text-white transition hover:bg-white/20"
      >
        {avatar ? (
          <img src={avatar} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center bg-white text-base font-black text-black">
            {displayName.charAt(0).toUpperCase()}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-3 w-[19rem] overflow-hidden rounded-2xl border border-white/10 bg-[#0d0d0f]/95 shadow-2xl backdrop-blur-xl">
          {/* Active identity */}
          <div className="border-b border-white/10 px-4 py-3">
            <div className="flex items-center gap-3">
              {avatar ? (
                <img
                  src={avatar}
                  alt=""
                  className="h-10 w-10 rounded-lg object-cover"
                />
              ) : (
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-white text-base font-black text-black">
                  {displayName.charAt(0).toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {displayName}
                </p>
                <p className="truncate text-[11px] text-white/50">{user.email}</p>
              </div>
            </div>
          </div>

          {/* Profile switcher */}
          {profiles.length > 0 && (
            <div className="border-b border-white/10 px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">
                Switch profile
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {profiles.slice(0, 6).map((profile) => {
                  const isActive = profile.id === activeProfile?.id;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => handleSwitch(profile.id)}
                      disabled={profile.isLocked}
                      className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition ${
                        isActive
                          ? "border-white/40 bg-white/[0.08]"
                          : "border-white/10 bg-black/20 hover:border-white/30 hover:bg-white/[0.05]"
                      } disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      <img
                        src={profile.avatar}
                        alt=""
                        className="h-9 w-9 rounded-md object-cover"
                      />
                      <span className="w-full truncate text-center text-[10px] leading-3 text-white/80">
                        {profile.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <nav className="px-2 py-2">
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <Users className="h-4 w-4" />
              Manage Profiles
            </Link>
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <Settings className="h-4 w-4" />
              Account Settings
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <Plus className="h-4 w-4" />
              Add Profile
            </button>
          </nav>

          <div className="border-t border-white/10 px-4 py-3">
            <button
              type="button"
              onClick={handleSignOut}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-violet-400 transition hover:bg-violet-500/10 hover:text-violet-300"
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}