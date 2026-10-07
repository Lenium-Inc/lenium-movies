/**
 * The one place in the app that knows how a trailer gets played.
 *
 * ## Why this file exists
 *
 * Trailers used to be wired up inline, at each call site: a template literal in
 * `MediaCard`, a different template literal in `Details`, each one branching on
 * a `provider` string and each one spelling out its own query parameters. Two
 * copies of the same URL meant two places to fix when a parameter was wrong,
 * and both were assembling a YouTube embed by hand.
 *
 * The rule now is: **TMDB is the source of trailers, and nothing else is.**
 * Nothing in this app searches YouTube, hardcodes a YouTube id, or builds a
 * YouTube URL. The catalog asks TMDB's `videos` sub-resource for a title, TMDB
 * names the official trailer, and this module turns that one answer into a
 * player URL.
 *
 * ## The honest caveat
 *
 * TMDB does not host trailer files. The `videos` sub-resource returns entries
 * carrying a `site` and a `key`, and for trailers that site is overwhelmingly
 * YouTube -- TMDB is an index, not a CDN. So "never YouTube" cannot mean "the
 * bytes never come from a YouTube origin"; it means *we never choose YouTube*.
 * We do not search it, we do not rank its results, we do not embed a link a
 * user brought us. We play the trailer TMDB nominated. Callers must therefore
 * treat every failure as expected -- the file may be unembeddable, region-
 * locked, or simply gone -- and fall back to artwork, never to a dead frame.
 *
 * Because that failure is routine rather than exceptional, `TRAILER_ORIGINS` is
 * exported for the CSP: if the site ever needs to lock trailers down to one
 * origin, that list is the thing to edit.
 */

import type { TrailerInfo } from "@/services/api";

/**
 * Where a resolved trailer can be framed from. Kept as a closed set rather than
 * a free `string` so a typo in the backend's `provider` field surfaces at the
 * type level instead of falling through to a default branch at runtime.
 */
export type TrailerSite = "youtube" | "dailymotion" | "vimeo";

/** Player origins, in the order they are allowed for a frame. */
export const TRAILER_ORIGINS: Record<TrailerSite, string> = {
  // `youtube-nocookie` rather than `youtube`: it sets no cookies until the
  // viewer interacts, so hovering a shelf does not mint a tracking cookie for
  // every tile it passes over.
  youtube: "https://www.youtube-nocookie.com",
  dailymotion: "https://www.dailymotion.com",
  vimeo: "https://player.vimeo.com",
};

/**
 * Narrows the backend's free-form `provider` string to a site we can frame.
 *
 * Returns null rather than guessing: an unknown site means we do not know how to
 * build a player for it, and a wrong guess is a broken frame behind the title.
 */
function toSite(provider: string | undefined | null): TrailerSite | null {
  switch ((provider ?? "").trim().toLowerCase()) {
    case "youtube":
    case "yt":
      return "youtube";
    case "dailymotion":
    case "dailymotion.com":
      return "dailymotion";
    case "vimeo":
      return "vimeo";
    default:
      return null;
  }
}

/** A resolved, playable trailer. */
export interface ResolvedTrailer {
  /** The frame src. The only URL of its kind in the codebase. */
  src: string;
  /** The site it came from, for CSP and for the failure message. */
  site: TrailerSite;
  /**
   * The provider's own title for the clip, e.g. "Official Trailer".
   *
   * Used as the frame's accessible name, so a screen reader announces
   * "Official Trailer" rather than an unlabelled video region.
   */
  label: string;
}

/**
 * The page origin, or `undefined` when there is no document.
 *
 * `origin` is only required because `enablejsapi=1` asks the player to post
 * messages back, which it will only do to the origin it was told about. Reading
 * `window` unguarded throws under SSR, in a prerender, or in a unit test -- and a
 * trailer resolver that cannot be called outside a browser is a resolver that
 * gets special-cased at every call site, which is the thing this file exists to
 * prevent. Absent, the parameter is simply omitted and the player falls back to
 * its own default.
 */
function currentOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location?.origin;
}

function params(site: TrailerSite, id: string, opts: PreviewOptions): string {
  const origin = opts.origin ?? currentOrigin();

  switch (site) {
    case "youtube": {
      // `loop=1` needs `playlist` set to the same id, or YouTube loops a
      // one-item playlist and drops it after the first play. `iv_load_policy=3`
      // keeps the iframe out of the page's viewability metrics. `rel=0` drops
      // the end-screen suggestions. `playsinline` stops iOS from hijacking the
      // card into fullscreen on autoplay.
      //
      // `enablejsapi=1` is what makes the hero trailer controllable by
      // `postMessage` without loading the IFrame API script -- see
      // `useTrailerPlayback`. It is required, not optional, for that path.
      const query = new URLSearchParams({
        autoplay: "1",
        mute: "1",
        controls: opts.controls ? "1" : "0",
        loop: opts.loop ? "1" : "0",
        playlist: id,
        playsinline: "1",
        iv_load_policy: "3",
        modestbranding: "1",
        rel: "0",
        enablejsapi: "1",
        // Retained because the hero spec calls for it. YouTube deprecated
        // `showinfo` years ago and ignores it -- the title overlay it once
        // suppressed is now cropped out with `scale-125` instead, which is the
        // only thing that actually removes it. Kept as a defence in depth for
        // any embed that still honours it.
        showinfo: "0",
      });
      if (origin) query.set("origin", origin);
      return query.toString();
    }

    case "dailymotion":
      return new URLSearchParams({
        autoplay: "1",
        muted: "1",
        loop: opts.loop ? "1" : "0",
        controls: opts.controls ? "1" : "0",
        enablejsapi: "1",
      }).toString();

    case "vimeo":
      return new URLSearchParams({
        autoplay: "1",
        muted: "1",
        loop: opts.loop ? "1" : "0",
        controls: opts.controls ? "1" : "0",
        dnt: "1",
      }).toString();
  }
}

export interface PreviewOptions {
  /** Loop the clip. On for a hover preview, off for a watched trailer. */
  loop?: boolean;
  /** Show the provider's controls. On for a dedicated player, off for a preview. */
  controls?: boolean;
  /**
   * The `origin` parameter some players require before they will play.
   *
   * Read from the live window rather than passed in, because it is only ever
   * the current document and threading it through every call site invites a
   * stale value after a client-side navigation.
   */
  origin?: string;
}

/**
 * Turns a backend trailer pointer into a frame src.
 *
 * Returns null when the provider is not one we can frame, so a caller can fall
 * back to artwork instead of mounting an iframe with a broken src.
 *
 * When the backend has already built a base URL (`embed_url`) it wins. That
 * keeps the provider table in one module rather than two: the backend knows
 * which sites can be framed and how each is spelled, while this file knows only
 * what this particular embed is doing -- autoplay, mute, loop, `enablejsapi`.
 * The base is used and the playback parameters are appended, because they are a
 * property of the embed, not of the site.
 */
export function resolveTrailer(
  trailer: TrailerInfo | null | undefined,
  opts: PreviewOptions = {}
): ResolvedTrailer | null {
  if (!trailer?.id) return null;
  const site = toSite(trailer.provider);
  if (!site) return null;

  const options: PreviewOptions = { loop: true, controls: false, ...opts };
  const query = params(site, trailer.id, options);
  const base = serverBase(trailer, site);

  return {
    src: appendQuery(base, query),
    site,
    label: trailer.title?.trim() || "Official trailer",
  };
}

/**
 * The site's embed URL, preferring the backend's spelling.
 *
 * The backend's URL carries no query string today, but appending with `&` when
 * one appears is cheaper than trusting that detail to stay true -- otherwise a
 * future `?rel=0` from the server would silently drop every parameter set here,
 * including the autoplay the hero depends on.
 */
function serverBase(trailer: TrailerInfo, site: TrailerSite): string {
  const fromServer = trailer.embed_url?.trim();
  if (fromServer) return fromServer;
  switch (site) {
    case "vimeo":
      return `${TRAILER_ORIGINS.vimeo}/video/${trailer.id}`;
    case "dailymotion":
      return `${TRAILER_ORIGINS.dailymotion}/embed/video/${trailer.id}`;
    case "youtube":
      return `${TRAILER_ORIGINS.youtube}/embed/${trailer.id}`;
  }
}

function appendQuery(base: string, query: string): string {
  if (!query) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

/**
 * A poster frame for a trailer, from the site that hosts it.
 *
 * Used as the frame's `background-image` so the black letterbox of a loading
 * embed is never what the viewer sees first.
 *
 * The backend's `thumb_url` wins when present. Beyond keeping one table, it
 * corrects a mistake the fallback still has to carry: `TRAILER_ORIGINS` lists
 * frame origins for the CSP, and `youtube-nocookie.com/vi/...` is not an image
 * host, so the legacy fallback can produce a URL that never resolves.
 */
export function trailerThumbnail(
  trailer: TrailerInfo | null | undefined
): string | null {
  const fromServer = trailer?.thumb_url?.trim();
  if (fromServer) return fromServer;

  const site = toSite(trailer?.provider);
  if (!site || !trailer?.id) return null;
  switch (site) {
    case "youtube":
      return `https://i.ytimg.com/vi/${trailer.id}/hqdefault.jpg`;
    case "dailymotion":
      return `https://www.dailymotion.com/thumbnail/video/${trailer.id}`;
    case "vimeo":
      // Vimeo exposes no public thumbnail endpoint; the clip loads from black,
      // which is acceptable behind a card that is already crossfading.
      return null;
  }
}
