/**
 * Provider chain for the embed player, derived from the StreamVy manifest.
 *
 * Playback is tiered:
 *
 *   1. `direct` — Archive.org-backed catalog entries. Real HLS/MP4 URLs the
 *      native player boots directly. Preferred: no third-party frame in the
 *      path, and quality variants come along as mirrors.
 *   2. `embed` — the providers in `@/lib/streamProviders`, always addressable
 *      from a valid TMDB id. They are the terminal fallback, so a title the
 *      direct catalog does not carry still plays.
 *
 * The backend walks the whole chain server-side and returns the first provider
 * that yields a playable source, plus the remaining candidates in priority
 * order for client-side failover if that URL dies mid-play. A request only
 * fails once every enabled provider has been attempted.
 *
 * This module is the client-side half of that contract: it turns a manifest
 * entry into a concrete URL for a given title, and hands the player a
 * ready-made failover chain when the backend has not supplied one. The two
 * manifests are asserted identical in `embedSources.test.ts`, so a provider
 * cannot exist on only one side.
 */

import {
  STREAM_PROVIDERS,
  STREAM_PROVIDER_HOSTS,
  safeStreamId,
  type StreamProvider,
} from "@/lib/streamProviders";

export type EmbedMedia = "movie" | "tv";

/**
 * Permissions every provider frame is granted.
 *
 * The `sandbox` attribute is deliberately absent. A sandboxed frame is served a
 * null origin, and these providers answer a null-origin handshake with "This
 * content can't be embedded in a sandboxed frame" -- the frame then renders
 * nothing at all, so the viewer sees an empty black rectangle with no error and
 * no way to tell a dead source from a broken page. Every provider here is a
 * distinct origin from this app, so the frame is isolated by origin policy
 * rather than by a sandbox the providers refuse to load inside.
 *
 * `autoplay`, `encrypted-media` and `fullscreen` are all required: without the
 * first the player cannot start itself, without the second an encrypted HLS
 * stream refuses to play, and without the third the provider's own fullscreen
 * button is inert. `picture-in-picture` and the sensor tokens are harmless on
 * desktop and required on mobile, where a provider hands playback to the OS.
 *
 * It lives here rather than on a component because it is part of the provider
 * contract, not of any one player's markup.
 */
export const EMBED_ALLOW =
  "autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope";

/**
 * One entry of the `providers` array `/api/movies/resolve` returns.
 *
 * The backend sends this shape rather than its internal provider records because
 * the client's only job with the chain is to walk it in order: it needs a name
 * to show if it ever has to, a URL to load, and whether the URL is a frame or a
 * file. Anything richer would be a second contract to keep in step with the
 * resolver.
 */
export interface BackendProviderCandidate {
  name?: string | null;
  url?: string | null;
  is_embed?: boolean | null;
}

/**
 * Turn the backend's `providers` array into a playable chain.
 *
 * Order is the backend's decision and is preserved exactly -- it is the order it
 * probed in, and reversing it would put a host it already ruled out first.
 *
 * Each URL is matched back to its manifest entry by host so the label and
 * audience type come from one place rather than from whatever string the server
 * happened to send. A URL naming no known provider is kept anyway: the resolver
 * may know about a host this deploy's manifest does not, and dropping its URL
 * would throw away a candidate the server offered.
 *
 * `fallback` (the manifest chain for this target) is appended for any provider
 * the backend did not mention. Those were never vetted, but they are addressable
 * and cost nothing to try, and a chain that shrinks when the resolver is unsure
 * is a chain with nowhere left to go.
 */
export function chainFromBackend(
  providers: readonly BackendProviderCandidate[] | null | undefined,
  fallback: readonly ResolvedEmbedSource[]
): ResolvedEmbedSource[] {
  const out: ResolvedEmbedSource[] = [];
  const seenUrls = new Set<string>();
  const seenIds = new Set<string>();

  for (const entry of providers ?? []) {
    const url = entry?.url?.trim();
    if (!url) continue;
    if (seenUrls.has(url)) continue;

    const host = hostOf(url);
    const known = fallback.find(source => source.host === host);
    const id = known?.id ?? `server-${out.length}`;
    if (seenIds.has(id)) continue;

    seenUrls.add(url);
    seenIds.add(id);
    out.push(
      known
        ? { ...known, url }
        : {
            id,
            label: entry?.name?.trim() || "Alternate source",
            title: entry?.name?.trim() || "Alternate source",
            host,
            url,
            quality: null,
            type: "embed",
          }
    );
  }

  for (const source of fallback) {
    if (seenIds.has(source.id)) continue;
    seenIds.add(source.id);
    out.push(source);
  }

  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export interface EmbedSource {
  /** Stable id used for state and React keys. */
  id: string;
  /** Short label for the switcher. */
  label: string;
  /** Longer label used in the a11y title attribute. */
  title: string;
  /** Which host this provider needs allowlisted for the frame to load. */
  host: string;
  /** Quality tier and audience, for the picker's badges. */
  quality: string | null;
  /**
   * Provider audience, for the picker's badges. `embed` is the marker for a
   * mirror the backend named but the manifest does not carry, which the picker
   * renders without an audience badge rather than guessing one.
   */
  type: StreamProvider["type"] | "embed";
}

export interface EmbedTarget {
  tmdbId?: number | string | null;
  mediaType: EmbedMedia;
  season?: number;
  episode?: number;
}

export interface ResolvedEmbedSource extends EmbedSource {
  url: string;
}

/**
 * Order matters: the first source is preselected and the backend's failover
 * chain follows the same order, so the most reliable provider is first and the
 * shakiest last.
 *
 * These ids and hosts mirror `movie-backend/stream_providers.py`, which is the
 * authority for which provider actually served a title. The two are asserted
 * against each other in `embedSources.test.ts`, because a provider added on
 * one side and not the other is how a title ends up reported as playable by a
 * host the client does not recognise as an embed.
 */
export const EMBED_SOURCES: readonly EmbedSource[] = Object.freeze(
  STREAM_PROVIDERS.map(provider => ({
    id: provider.id,
    label: provider.name,
    title: provider.name,
    host: new URL(provider.getUrl("1", "movie")).hostname,
    quality: provider.quality,
    type: provider.type,
  }))
);

export const EMBED_HOSTS: readonly string[] = STREAM_PROVIDER_HOSTS;

/**
 * Every provider in the manifest is keyed on TMDB, so `tmdb=` is the only key
 * that is read. A target that cannot be placed in a URL path yields no
 * candidates at all rather than a chain of URLs that 404 or — worse — point
 * somewhere unintended.
 */
function buildUrl(
  provider: StreamProvider,
  target: EmbedTarget
): string | null {
  const tmdb = safeStreamId(target.tmdbId);
  if (!tmdb) return null;
  const isTv = target.mediaType === "tv";
  const season = Number.isFinite(target.season) ? Number(target.season) : 1;
  const episode = Number.isFinite(target.episode) ? Number(target.episode) : 1;
  return provider.getUrl(tmdb, isTv ? "tv" : "movie", season, episode);
}

/**
 * Resolve every provider that can serve this target, in failover order.
 * Providers that can't address the target are dropped rather than rendered
 * as a broken tab.
 */
export function resolveEmbedSources(
  target: EmbedTarget
): ResolvedEmbedSource[] {
  const out: ResolvedEmbedSource[] = [];
  for (const provider of STREAM_PROVIDERS) {
    const url = buildUrl(provider, target);
    if (!url) continue;
    const meta = EMBED_SOURCES.find(source => source.id === provider.id);
    if (!meta) continue;
    out.push({ ...meta, url });
  }
  return out;
}
