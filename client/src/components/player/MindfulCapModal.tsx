import { useEffect, useState } from "react";
import { MoonStar } from "lucide-react";
import {
  capLimit,
  dayCount,
  resetCap,
  subscribeCap,
} from "@/services/capGate";
import { secondsToReset } from "@/services/stats";

function formatCountdown(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}

const RADIUS = 42;
const CIRC = 2 * Math.PI * RADIUS;

/**
 * Non-intrusive, elegant lock screen shown when the daily viewing cap (8/8)
 * is reached. Renders a monochrome progress ring, the mindful message, and a
 * live countdown to the reset at local midnight.
 */
export function MindfulCapModal() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [tick, setTick] = useState(secondsToReset());

  useEffect(() => {
    const unsubscribe = subscribeCap((locked, plays) => {
      setOpen(locked);
      if (locked) {
        setCount(plays);
        setTick(secondsToReset());
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setTick(secondsToReset()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  const fraction = Math.min(1, count / capLimit());

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Daily viewing limit reached"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-[#121212] p-8 text-center shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="relative mx-auto grid h-28 w-28 place-items-center">
          <svg viewBox="0 0 100 100" className="h-28 w-28 -rotate-90">
            <circle
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="6"
            />
            <circle
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - fraction)}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            <MoonStar className="h-6 w-6 text-white/80" />
          </div>
        </div>

        <p className="mt-6 font-display text-lg font-semibold text-white">
          {count}/{capLimit()} — you&apos;ve hit your mindful daily cinematic
          limit
        </p>
        <p className="mt-2 text-sm leading-6 text-[#9a9aa0]">
          Time to step away and digest. Your next viewing window opens at
          midnight.
        </p>

        <div className="mt-6 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 font-mono text-sm tabular-nums text-white/80">
          Resets in {formatCountdown(tick)}
        </div>

        <button
          onClick={() => setOpen(false)}
          className="mt-5 w-full rounded-full border border-white/10 bg-white/[0.06] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-white/15"
        >
          Close
        </button>

        <button
          onClick={() => {
            resetCap();
            setOpen(false);
          }}
          className="mt-2 w-full rounded-full border border-white/20 bg-white/10 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-white/20"
        >
          Reset limit
        </button>
      </div>
    </div>
  );
}