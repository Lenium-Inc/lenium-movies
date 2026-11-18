/**
 * The Android playback bridge.
 *
 * The website can only browse: MovieBox's CDN requires a player-page Referer
 * and a Chrome TLS fingerprint, neither of which a browser can supply. The
 * native Android client has both, so playback is handed to a small WebView
 * surface that resolves the signed stream inside the player page and then
 * mounts its own <video> element.
 *
 * The plugin is registered lazily because a web build must not fail when the
 * native class is absent.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

interface NativePlaybackOptions {
  subjectId: string;
  detailPath: string;
  season?: number;
  episode?: number;
  title?: string;
}

interface StreamVyPlayerPlugin {
  play(options: NativePlaybackOptions): Promise<void>;
}

const StreamVyPlayer = registerPlugin<StreamVyPlayerPlugin>("StreamVyPlayer");

export function canPlayNative(): boolean {
  return (
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
  );
}

export async function playNative(
  options: NativePlaybackOptions
): Promise<void> {
  if (!canPlayNative()) {
    throw new Error("Native playback is only available in the Android app");
  }
  if (!options.subjectId?.trim() || !options.detailPath?.trim()) {
    throw new Error("This title is missing its playback id");
  }
  await StreamVyPlayer.play({
    ...options,
    subjectId: options.subjectId.trim(),
    detailPath: options.detailPath.trim(),
    season: options.season ?? 1,
    episode: options.episode ?? 1,
  });
}

/** `streamvy://watch/<detailPath>?...` for the website's "Open in app" link. */
export function watchDeepLink(detailPath: string, search = ""): string {
  const path = detailPath.replace(/^\/+/, "");
  const query = search.startsWith("?") ? search : search ? `?${search}` : "";
  return `streamvy://watch/${encodeURIComponent(path)}${query}`;
}
