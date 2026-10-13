import { useEffect, useRef } from "react";
import { getKeepSignedIn } from "@/services/auth";

/** Ten minutes of no input ends the session. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** How often the idle clock is checked. Well under the timeout, and cheap. */
const CHECK_INTERVAL_MS = 15 * 1000;
/** Resetting a timestamp does not need to run on every pointer sample. */
const MOVE_THROTTLE_MS = 1000;

const INSTANT_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/**
 * Is anything currently playing?
 *
 * A film running on screen is the strongest possible signal that the viewer is
 * present, and it produces no input events -- so without this a two-hour feature
 * would sign its viewer out ten minutes in, which is the exact "left it alone
 * and lost my place" complaint this feature exists to fix. Reading the live
 * `<video>` elements avoids threading playback state up from the player.
 */
function isPlaybackActive(): boolean {
  if (typeof document === "undefined") return false;
  for (const video of Array.from(document.querySelectorAll("video"))) {
    if (!video.paused && !video.ended && video.readyState > 2) return true;
  }
  return false;
}

/**
 * Sign the viewer out after a stretch of inactivity.
 *
 * The check runs on an interval rather than arming a `setTimeout` per event: a
 * single interval cannot be left dangling by an event that never fires, and a
 * background tab clamps both the same way. "Keep me signed in" and live playback
 * both suspend it.
 */
export function useIdleLogout(options: {
  enabled: boolean;
  onIdle: () => void;
}): void {
  const { enabled, onIdle } = options;
  const lastActivityRef = useRef(Date.now());
  const firedRef = useRef(false);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled) return;
    if (getKeepSignedIn()) return;

    lastActivityRef.current = Date.now();
    firedRef.current = false;

    const mark = () => {
      lastActivityRef.current = Date.now();
    };
    let lastMove = 0;
    const markMove = () => {
      const now = Date.now();
      if (now - lastMove < MOVE_THROTTLE_MS) return;
      lastMove = now;
      lastActivityRef.current = now;
    };

    window.addEventListener("pointermove", markMove, { passive: true });
    INSTANT_EVENTS.forEach(event =>
      window.addEventListener(event, mark, { passive: true })
    );

    const timer = window.setInterval(() => {
      if (firedRef.current) return;
      const now = Date.now();
      if (isPlaybackActive()) {
        lastActivityRef.current = now;
        return;
      }
      if (now - lastActivityRef.current >= IDLE_TIMEOUT_MS) {
        firedRef.current = true;
        onIdleRef.current();
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      window.removeEventListener("pointermove", markMove);
      INSTANT_EVENTS.forEach(event => window.removeEventListener(event, mark));
      window.clearInterval(timer);
    };
  }, [enabled]);
}
