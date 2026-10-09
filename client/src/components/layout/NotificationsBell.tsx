import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellRing, CalendarClock, Trash2, X } from "lucide-react";
import { Link } from "wouter";
import { tmdbImage } from "@/lib/tmdbImages";
import {
  clearReminders,
  daysUntil,
  formatReleaseShort,
  getReminders,
  isUpcoming,
  removeReminder,
  subscribeReminders,
  type Reminder,
} from "@/services/notifications";

/**
 * Nav-bar entry point for the local "reminders" list. Shows a live count and a
 * dropdown of the titles a viewer asked to be told about, soonest first.
 *
 * This is the read side of `services/notifications.ts`; the write side is
 * `RemindMeButton` on the watch page. Both subscribe to the same store, so
 * setting a reminder anywhere updates the badge everywhere.
 */
export function NotificationsBell() {
  const [reminders, setReminders] = useState<Reminder[]>(() => getReminders());
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return subscribeReminders(() => setReminders(getReminders()));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = reminders.length;
  // Split so the panel can say "Upcoming" before anything has actually landed.
  const { upcoming, released } = useMemo(() => {
    const up: Reminder[] = [];
    const out: Reminder[] = [];
    for (const reminder of reminders) {
      (isUpcoming(reminder.releaseDate) ? up : out).push(reminder);
    }
    return { upcoming: up, released: out };
  }, [reminders]);

  const renderRow = (reminder: Reminder) => {
    const days = daysUntil(reminder.releaseDate);
    const upcoming = Number.isFinite(days) && days > 0;
    const meta = upcoming
      ? `${formatReleaseShort(reminder.releaseDate)} · ${
          days === 1 ? "tomorrow" : `in ${days} days`
        }`
      : `${formatReleaseShort(reminder.releaseDate)} · out now`;
    const poster = tmdbImage(reminder.poster, "w92");
    return (
      <li key={reminder.id} className="group flex items-center gap-3">
        <Link
          href={`/watch/${encodeURIComponent(reminder.id)}`}
          onClick={() => setOpen(false)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 transition hover:bg-zinc-800"
        >
          <span className="grid h-14 w-10 shrink-0 place-items-center overflow-hidden rounded-md border border-white/10 bg-white/5">
            {poster ? (
              <img
                src={poster}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <CalendarClock className="h-4 w-4 text-zinc-500" aria-hidden />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-white">
              {reminder.title}
            </span>
            <span
              className={`mt-0.5 flex items-center gap-1 text-[11px] ${
                upcoming ? "text-violet-300" : "text-emerald-300"
              }`}
            >
              {upcoming && <CalendarClock className="h-3 w-3" aria-hidden />}
              {meta}
            </span>
          </span>
        </Link>
        <button
          type="button"
          onClick={() => removeReminder(reminder.id)}
          aria-label={`Remove reminder for ${reminder.title}`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-500 opacity-0 transition hover:bg-zinc-700 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </li>
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label={
          count > 0 ? `Notifications, ${count} reminders` : "Notifications"
        }
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-lg border border-white/10 text-white/70 transition hover:bg-white/10 hover:text-white"
      >
        {count > 0 ? (
          <BellRing className="h-4 w-4" />
        ) : (
          <Bell className="h-4 w-4" />
        )}
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-violet-600 px-1 text-[10px] font-bold leading-none text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-3 w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-800 bg-zinc-900/95 p-2 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between px-2 py-1.5">
            <p className="text-sm font-semibold text-white">Reminders</p>
            {count > 0 && (
              <button
                type="button"
                onClick={() => clearReminders()}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400 transition hover:text-white"
              >
                <Trash2 className="h-3 w-3" aria-hidden />
                Clear all
              </button>
            )}
          </div>

          {count === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <Bell className="h-6 w-6 text-zinc-600" aria-hidden />
              <p className="text-sm text-zinc-400">No reminders yet</p>
              <p className="text-xs text-zinc-500">
                Tap “Notify me” on an upcoming title and it will show up here.
              </p>
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              {upcoming.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                    Upcoming
                  </p>
                  <ul className="space-y-0.5">
                    {upcoming.map(renderRow)}
                  </ul>
                </>
              )}
              {released.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                    Now available
                  </p>
                  <ul className="space-y-0.5">{released.map(renderRow)}</ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationsBell;
