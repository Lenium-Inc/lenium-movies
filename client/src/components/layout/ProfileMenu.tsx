import { useEffect, useRef, useState } from "react";
import { ChevronRight, Clock3, Lock, UserRound, LogOut, Bookmark, User } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { useStatsRevision } from "@/hooks/useStats";
import {
  capLimit,
  dayCount,
  dayLocked,
} from "@/services/capGate";
import {
  ACHIEVEMENTS,
  earnedAchievements,
  hoursWatched,
  nextMilestone,
} from "@/services/stats";

const RADIUS = 30;
const CIRC = 2 * Math.PI * RADIUS;

/**
 * Compact circular profile control with a monochrome dropdown.
 * Guest mode: shows "Sign In" button.
 * Authenticated mode: shows avatar with dropdown containing Profile, My List, Sign Out, and stats.
 */
export function ProfileMenu() {
  const { user, isLoading, login, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useStatsRevision();

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

  if (isLoading) {
    return (
      <div className="grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-white/[0.08] text-white/50">
        <div className="h-4 w-4 animate-pulse rounded-full bg-white/30" />
      </div>
    );
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => login()}
        aria-label="Sign In"
        className="grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-white/[0.08] text-white transition hover:bg-white/20 hover:border-white/30"
      >
        <UserRound className="h-4 w-4" />
      </button>
    );
  }

  const hours = hoursWatched();
  const milestone = nextMilestone();
  const count = dayCount();
  const limit = capLimit();
  const locked = dayLocked();
  const earned = earnedAchievements();
  const learned = new Set(earned.map(a => a.id));

  const handleSignOut = () => {
    logout();
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label="Profile"
        className="grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-white/[0.08] text-white transition hover:bg-white/20"
      >
        {user.avatar_url ? (
          <img
            src={user.avatar_url}
            alt=""
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <span className="grid h-9 w-9 place-items-center rounded-full bg-indigo-600 text-white font-bold text-sm">
            {user.name.charAt(0).toUpperCase()}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[19rem] overflow-hidden rounded-xl border border-white/10 bg-[#121212] shadow-2xl">
          <div className="border-b border-white/10 px-4 py-3">
            <div className="flex items-center gap-3">
              {user.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt=""
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <span className="grid h-10 w-10 place-items-center rounded-full bg-indigo-600 text-white font-bold">
                  {user.name.charAt(0).toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">{user.name}</p>
                <p className="text-[11px] text-white/50 truncate">{user.email}</p>
              </div>
            </div>
          </div>

          <div className="border-b border-white/10 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">
              Mindful viewer
            </p>
            <div className="mt-3 flex items-center gap-4">
              <svg viewBox="0 0 100 100" className="h-16 w-16 -rotate-90 shrink-0">
                <circle
                  cx="50"
                  cy="50"
                  r={RADIUS}
                  fill="none"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="7"
                />
                <circle
                  cx="50"
                  cy="50"
                  r={RADIUS}
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={CIRC}
                  strokeDashoffset={CIRC * (1 - (milestone?.fraction ?? 1))}
                />
              </svg>
              <div>
                <p className="text-2xl font-bold tabular-nums text-white">
                  {hours.toFixed(1)}
                  <span className="ml-1 text-xs font-semibold text-white/50">
                    hrs
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] text-[#9a9aa0]">
                  {milestone
                    ? `To your next badge: ${(milestone.target / 3600).toFixed(0)}h`
                    : "All badges earned — truly immersed."}
                </p>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Clock3 className="h-3.5 w-3.5 text-white/50" />
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-white transition-all"
                  style={{ width: `${Math.min(100, (count / limit) * 100)}%` }}
                />
              </div>
              <span className="text-[11px] tabular-nums text-white/70">
                {Math.min(count, limit)}/{limit}
              </span>
              {locked && <Lock className="h-3 w-3 text-white/70" />}
            </div>
          </div>

          <div className="p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">
              Achievements
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {ACHIEVEMENTS.map(achievement => {
                const isEarned = learned.has(achievement.id);
                const Icon = achievement.icon;
                return (
                  <div
                    key={achievement.id}
                    title={isEarned ? achievement.copy : achievement.hint}
                    className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2 text-center ${
                      isEarned
                        ? "border-white/15 bg-white/[0.05]"
                        : "border-white/5 bg-black/20"
                    }`}
                  >
                    <span
                      className={`grid h-8 w-8 place-items-center rounded-full ${
                        isEarned
                          ? "bg-white text-black"
                          : "bg-white/[0.06] text-white/30"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span
                      className={`text-[9px] leading-3 ${
                        isEarned ? "text-white" : "text-white/30"
                      }`}
                    >
                      {achievement.title}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <nav className="px-2 py-1 space-y-1">
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <User className="h-4 w-4" />
              Profile
            </Link>
            <Link
              href="/my-list"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <Bookmark className="h-4 w-4" />
              My List
            </Link>
          </nav>

          <div className="border-t border-white/10 px-4 py-3">
            <button
              type="button"
              onClick={handleSignOut}
              className="flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-500/10 hover:text-red-300"
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