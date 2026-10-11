/**
 * Provider chain for the embed player.
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
 * This module is the client-side half of that contract, and it is now one-way:
 * it reads the chain the server sent and turns it into something the picker can
 * render. It no longer builds provider URLs of its own. `/api/v1/playback/init`
 * answers with tokenised frame handles (`/api/v1/playback/frame?token=...`),
 * never raw third-party URLs, so a locally-built URL would be a *different*
 * thing from what the server vetted -- one that skips the backend's health
 * record, its bench cooldowns, and its ordering, and that points the browser at
 * a host this deploy may no longer serve. When the payload carries no chain,
 * the honest answer is "nothing to walk", not a guess.
 *
 * The manifest metadata (`EMBED_SOURCES`) is kept: it is what labels the picker
 * tabs and what `EMBED_HOSTS` recognises a frame host from. It is asserted
 * against the Python manifest in `embedSources.test.ts`.
 */

import {
  STREAM_PROVIDERS,
  STREAM_PROVIDER_HOSTS,
  type StreamProvider,
} from "@/lib/streamProviders";

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
 * One entry of the `providers` array `/api/v1/playback/init` returns.
 *
 * The backend sends this shape rather than its internal provider records because
 * the client's only job with the chain is to walk it in order: it needs a name
 * to show if it ever has to, a URL to load, and whether the URL is a frame or a
 * file. Anything richer would be a second contract to keep in step with the
 * resolver. `url` is a tokenised handle on this origin, not a provider URL.
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
 * probed in, and reversing it would put a host it already ruled out first. This
 * is the only source of chain entries: nothing is appended from the local
 * manifest, because a manifest entry has no token behind it and therefore no
 * frame the browser is allowed to load.
 *
 * Each URL is matched back to its manifest entry -- by the label the server
 * sent first, then by host -- so the id and audience badge come from one place
 * rather than from whatever string the payload happened to carry. The label is
 * tried first because a tokenised handle has no host to read: it is a path on
 * this origin, and the provider it will redirect to is opaque. A URL naming no
 * known provider is kept anyway: the resolver may know about a host this
 * deploy's manifest does not, and dropping its URL would throw away a candidate
 * the server offered. Entries the backend marked as files rather than frames
 * are skipped -- a progressive URL belongs in the direct player, not in an
 * `<iframe>`.
 */
export function chainFromBackend(
  providers: readonly BackendProviderCandidate[] | null | undefined
): ResolvedEmbedSource[] {
  const out: ResolvedEmbedSource[] = [];
  const seenUrls = new Set<string>();
  const seenIds = new Set<string>();

  for (const entry of providers ?? []) {
    if (entry?.is_embed === false) continue;
    const url = entry?.url?.trim();
    if (!url) continue;
    if (seenUrls.has(url)) continue;

    const label = entry?.name?.trim() || "";
    const urlHost = hostOf(url);
    const known =
      EMBED_SOURCES.find(source => source.label === label) ??
      (urlHost ? EMBED_SOURCES.find(source => source.host === urlHost) : undefined);
    const id = known?.id ?? `server-${out.length}`;
    if (seenIds.has(id)) continue;

    const resolvedLabel = label || known?.label || "Alternate source";
    seenUrls.add(url);
    seenIds.add(id);
    out.push({
      id,
      label: resolvedLabel,
      title: resolvedLabel,
      host: known?.host || urlHost,
      quality: known?.quality ?? null,
      type: known?.type ?? "embed",
      url,
    });
  }

  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
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

export interface ResolvedEmbedSource extends EmbedSource {
  url: string;
}

/**
 * The manifest, as picker metadata. Order matters: the first source is
 * preselected and the backend's failover chain follows the same order, so the
 * most reliable provider is first and the shakiest last.
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
    host: provider.host,
    quality: provider.quality,
    type: provider.type,
  }))
);

export const EMBED_HOSTS: readonly string[] = STREAM_PROVIDER_HOSTS;
