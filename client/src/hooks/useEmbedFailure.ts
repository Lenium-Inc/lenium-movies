import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Player error codes that mean "this video cannot play in this embed".
 *
 * YouTube reports the reason a background trailer breaks through postMessage
 * rather than through any DOM event, because the failure happens inside a
 * cross-origin document we cannot inspect. Left unhandled it is invisible: the
 * iframe still mounts, so the hero renders its title and ratings cleanly while
 * YouTube paints "Video unavailable" *behind* them, inside the same box.
 *
 *   2   invalid player parameter
 *   5   HTML5 player error
 *   100 video removed, private, or nonexistent
 *   101 owner has not allowed this video to be played in embedded players
 *   150 same as 101, returned for embed-blocked videos
 *   153 embedding disabled for this video
 */
const FATAL_YOUTUBE_CODES = new Set([2, 5, 100, 101, 150, 153]);

/** Origins the player may legitimately post from. */
const TRUSTED_ORIGINS = new Set([
  "https://www.youtube-nocookie.com",
  "https://www.youtube.com",
  "https://www.dailymotion.com",
]);

/**
 * True when a message from a trusted player origin reports a video that cannot
 * play.
 *
 * Returns a discriminated result rather than a boolean so the caller can tell
 * "this player is alive and healthy" from "this message means nothing to us" --
 * only the former should stand down the init watchdog. A blanket
 * "any message counts as life" would let an unrelated chatter event mask a
 * player that never booted.
 *
 * Exported for direct testing: the message shape is the part most likely to be
 * broken by a provider change, and it is otherwise only reachable through a
 * live cross-origin iframe.
 */
export function classifyEmbedMessage(data: unknown): "failed" | "alive" | "ignore" {
  if (!data || typeof data !== "object") return "ignore";

  const payload = data as { event?: unknown; info?: unknown; type?: unknown };
  const event = typeof payload.event === "string" ? payload.event : "";

  if (event === "onError") {
    // The code must be a real number, not merely coercible to one: `Number()`
    // turns the string "100" into 100, so a numeric-looking string from some
    // other message shape would be read as a genuine "removed or private"
    // verdict and would unmount a perfectly good player.
    const code = payload.info;
    if (typeof code !== "number" || !Number.isFinite(code)) return "ignore";
    return FATAL_YOUTUBE_CODES.has(code) ? "failed" : "ignore";
  }

  // Dailymotion reports failure as a message type rather than an event name.
  if (event === "videoError" || payload.type === "video_error") return "failed";

  // Anything else from a trusted origin -- `onReady`, `infoDelivery`, state
  // updates -- proves the player initialised.
  return event ? "alive" : "ignore";
}

/** True when `origin` is a player we are willing to accept messages from. */
export function isTrustedEmbedOrigin(origin: string): boolean {
  return TRUSTED_ORIGINS.has(origin);
}

/**
 * How long to wait for the first sign of life from the player before assuming
 * it will never initialise. A blocked embed that reports no error still has to
 * be caught somehow, and a player that has initialised clears this.
 */
const INIT_TIMEOUT_MS = 8000;

/**
 * Detects when a background trailer embed is unplayable so the caller can
 * unmount the iframe and fall back to artwork.
 *
 * The embed URL must carry `enablejsapi=1`; without it YouTube never posts
 * player state and there is nothing here to listen for. This hook only listens
 * for messages whose `source` is the exact iframe it owns, so several embeds
 * can be alive on one page without stealing each other's failures.
 */
export function useEmbedFailure(mediaKey: string | null) {
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const sawSignOfLife = useRef(false);

  // A new trailer deserves a fresh attempt. Without this, one unplayable video
  // would permanently disable the background for every title that follows.
  useEffect(() => {
    setFailed(false);
    sawSignOfLife.current = false;
  }, [mediaKey]);

  useEffect(() => {
    if (!mediaKey) return;

    const fail = () => setFailed(true);

    const onMessage = (event: MessageEvent) => {
      // Scoped to the exact iframe this hook owns, so several embeds on one
      // page cannot fail each other.
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!isTrustedEmbedOrigin(event.origin)) return;

      const verdict = classifyEmbedMessage(event.data);
      if (verdict === "failed") fail();
      // Only a genuine player event proves initialisation. Treating noise as
      // life would disarm the watchdog for a player that never booted.
      if (verdict === "alive") sawSignOfLife.current = true;
    };

    window.addEventListener("message", onMessage);

    const timer = window.setTimeout(() => {
      // No message at all: blocked, throttled, or the player never booted.
      if (!sawSignOfLife.current) fail();
    }, INIT_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [mediaKey]);

  const setRef = useCallback((node: HTMLIFrameElement | null) => {
    frameRef.current = node;
  }, []);

  return { failed, frameRef: setRef };
}
