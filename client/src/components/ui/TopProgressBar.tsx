import { useEffect, useState } from "react";

/**
 * Global loading indicator: a lamp beam running across the top of the frame.
 *
 * Two things this fixes over the bar it replaces:
 *
 * 1. It told a lie. Progress advanced by `Math.random() * 15` on a timer, so
 *    the number under `aria-valuenow` was fiction and jumped around between
 *    identical waits. Progress here advances on a fixed curve toward 90% and
 *    then *stops* — the remaining 10% is only travelled once the real work
 *    finishes, so the bar never promises something that hasn't happened.
 * 2. It leaked. Completion ran an interval created inside a state updater and
 *    cleared from a different one, on every render where progress crossed 90.
 *    There is one timer now, and its cleanup is unambiguous.
 *
 * A warm flare leads the bar: light travelling ahead of the shutter.
 */
const KEYFRAMES = [
  { at: 140, to: 8 },
  { at: 420, to: 22 },
  { at: 800, to: 38 },
  { at: 1300, to: 52 },
  { at: 2000, to: 64 },
  { at: 3000, to: 76 },
  { at: 4500, to: 85 },
  { at: 7000, to: 90 },
];

function progressAt(elapsed: number): number {
  if (elapsed <= 0) return 0;
  for (let i = 0; i < KEYFRAMES.length; i += 1) {
    if (elapsed < KEYFRAMES[i].at) {
      const previous = i === 0 ? { at: 0, to: 0 } : KEYFRAMES[i - 1];
      const span = KEYFRAMES[i].at - previous.at;
      const t = (elapsed - previous.at) / span;
      return previous.to + (KEYFRAMES[i].to - previous.to) * t;
    }
  }
  return 90;
}

export function TopProgressBar({ isLoading }: { isLoading: boolean }) {
  const [progress, setProgress] = useState(0);
  // `visible` outlives the state by one frame so the bar can finish its travel
  // instead of vanishing the instant the work completes.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isLoading) return;
    setProgress(0);
    setVisible(true);

    const startedAt = performance.now();
    const tick = 100;
    const id = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      // Slow to 90% on the curve above, then hold. Holding reads as "still
      // working" rather than "nearly done", which is the honest state.
      setProgress(elapsed < 40 ? 4 : progressAt(elapsed));
    }, tick);

    return () => window.clearInterval(id);
  }, [isLoading]);

  useEffect(() => {
    if (isLoading) return;
    if (!visible) return;
    // Travel the last 10% quickly and then clear, so completion reads as an
    // arrival rather than a cut.
    setProgress(100);
    const id = window.setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 320);
    return () => window.clearTimeout(id);
  }, [isLoading, visible]);

  if (!visible) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-px"
      role="progressbar"
      aria-valuenow={Math.round(progress)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Loading"
    >
      {/* The beam. */}
      <div
        className="h-full origin-left bg-gradient-to-r from-[#ffae5c] via-[#ffe7c2] to-[#ffae5c] transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${progress / 100})` }}
      />
      {/* Light running ahead of the leading edge. */}
      {progress > 0 && progress < 100 && (
        <div
          className="absolute top-0 h-px w-16 bg-gradient-to-r from-transparent via-[#ffe7c2] to-transparent opacity-80 motion-reduce:hidden"
          style={{ left: `calc(${progress}% - 2rem)` }}
        />
      )}
    </div>
  );
}

/**
 * Hook to manage global loading state across the app.
 *
 * Counting concurrent operations rather than storing a boolean means two
 * overlapping requests cannot switch the bar off while one is still running.
 */
export function useTopProgress() {
  const [loadingCount, setLoadingCount] = useState(0);

  const startLoading = () => setLoadingCount(c => c + 1);
  const stopLoading = () => setLoadingCount(c => Math.max(0, c - 1));

  return {
    isLoading: loadingCount > 0,
    startLoading,
    stopLoading,
  };
}
