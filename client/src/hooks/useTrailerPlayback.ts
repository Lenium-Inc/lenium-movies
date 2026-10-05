/**
 * Driving a TMDB-nominated trailer without loading a provider SDK.
 *
 * ## What this is
 *
 * The hero wants a trailer that plays on click and pauses on the next click,
 * with no visible play/pause glyph, no counter, and no toast telling you what
 * just happened. The two ways to get that are a provider SDK or a
 * `postMessage` command, and this is the `postMessage` one: the frame is
 * already given `enablejsapi=1` by `resolveTrailer`, which is what lets the
 * page post `{"event":"command","func":"playVideo"}` at it directly.
 *
 * The SDK route was rejected deliberately. The IFrame API is a ~250KB script
 * pulled from a third-party origin, and loading it on the critical path of
 * every first impression to do the work four string literals already do is a bad
 * trade. The command protocol is a few hundred bytes of our own.
 *
 * ## What this cannot do
 *
 * Only YouTube implements the command protocol. Dailymotion and Vimeo need their
 * own SDKs for equivalent control, so `commandable` is false for them and the
 * caller must not offer a click-to-toggle it cannot honour. Surfacing a toggle
 * that silently does nothing is worse than not offering one.
 *
 * Commands are also fire-and-forget: the protocol lets you *send* `playVideo`
 * but not usefully *observe* playback, so `playing` here is a local echo of
 * what we asked for. If the viewer pauses with the keyboard, or the browser
 * blocks autoplay, our flag drifts out of step with reality. Nothing in the app
 * currently displays that flag -- the spec forbids visible state -- so the drift
 * is inert today. A future visible affordance must not trust it; it needs real
 * state from `onStateChange`, which means the SDK after all.
 */

import { useCallback, useRef, useState } from "react";
import { TRAILER_ORIGINS, type TrailerSite } from "@/lib/tmdbTrailers";

/** Player commands the protocol defines. Only these are valid `func` values. */
type Command = "playVideo" | "pauseVideo" | "stopVideo" | "mute" | "unMute";

export interface TrailerPlayback {
  /** Attach to the `<iframe>` you mount. */
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  /**
   * Whether this provider can be commanded at all.
   *
   * False for Dailymotion and Vimeo; the caller should fall back to artwork or
   * to the provider's own controls rather than wiring a dead toggle.
   */
  commandable: boolean;
  /**
   * Our best understanding of playback state.
   *
   * A local echo of the last command sent, not observed state. See the file
   * header before building anything that displays this.
   */
  playing: boolean;
  /** True once a play command has been sent, i.e. the trailer is engaged. */
  engaged: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
}

/**
 * Post one command to the frame.
 *
 * `targetOrigin` is the provider origin, never `"*"`. A wildcard would let any
 * page that happened to frame this content post commands into it, and
 * `frame.contentWindow.postMessage` is unguarded against the frame having been
 * navigated somewhere else since we built the URL.
 */
function send(
  frame: HTMLIFrameElement | null,
  site: TrailerSite,
  func: Command
) {
  const target = frame?.contentWindow;
  if (!target) return;
  try {
    target.postMessage(
      JSON.stringify({ event: "command", func, args: "" }),
      TRAILER_ORIGINS[site]
    );
  } catch {
    // A cross-origin frame we cannot reach, or a frame torn down mid-navigation.
    // There is nothing to retry: the next click re-issues the command.
  }
}

export function useTrailerPlayback(site: TrailerSite | null): TrailerPlayback {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [engaged, setEngaged] = useState(false);

  const commandable = site === "youtube";

  const play = useCallback(() => {
    if (!commandable || !site) return;
    send(frameRef.current, site, "playVideo");
    setPlaying(true);
    setEngaged(true);
  }, [commandable, site]);

  const pause = useCallback(() => {
    if (!commandable || !site) return;
    send(frameRef.current, site, "pauseVideo");
    setPlaying(false);
  }, [commandable, site]);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [playing, pause, play]);

  return { frameRef, commandable, playing, engaged, play, pause, toggle };
}
