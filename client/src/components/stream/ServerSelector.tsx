import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import {
  DEFAULT_STREAM_PROVIDER,
  findStreamProvider,
  providerHost,
} from "@/lib/streamProviders";
import {
  resolveEmbedSources,
  type ResolvedEmbedSource,
} from "@/lib/embedSources";
import { cn } from "@/lib/utils";

/**
 * Permissions every provider frame is given.
 *
 * The `sandbox` attribute is deliberately absent. A sandboxed frame is served a
 * null origin, and these providers answer a null-origin handshake with
 * "This content can't be embedded in a sandboxed frame" — the frame then renders
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
 */
export const EMBED_ALLOW =
  "autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope";

export interface ServerSelectorProps {
  /** Exact TMDB id. Every provider URL is built from it. */
  tmdbId: string;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
  /**
   * The chain to offer. Defaults to every provider in the manifest for this
   * target; the watch page passes the chain the backend actually vetted, so the
   * picker and the resolver agree on order.
   */
  sources?: readonly ResolvedEmbedSource[];
  /** Currently playing source. Uncontrolled when omitted. */
  selectedId?: string;
  onSelect?: (sourceId: string) => void;
  /**
   * The player surface. The watch page passes the real player here so the frame
   * keeps its own poster, loader and failover; without it the selector owns a
   * plain frame, which is all a standalone picker needs.
   */
  frame?: ReactNode;
  /**
   * Whether to render the built-in player frame. Defaults to true, which is what
   * a standalone picker wants.
   *
   * The watch page passes `false` because it renders its own `<EmbedPlayer>`
   * above the picker: with the default left in place, that page would draw a
   * second iframe of the same source underneath the real one, and the viewer
   * would be looking at two players for one title.
   */
  showPlayer?: boolean;
  title?: string;
  className?: string;
}

/** The badge a provider's audience earns: one word, one tint. */
function TypeBadge({ type }: { type: ResolvedEmbedSource["type"] }) {
  if (type === "arabic") {
    return <span className="sv-badge sv-badge-emerald">Intl</span>;
  }
  if (type === "fast") {
    return <span className="sv-badge sv-badge-cyan">Adaptive</span>;
  }
  if (type === "embed") {
    return <span className="sv-badge">Backup</span>;
  }
  return <span className="sv-badge sv-badge-violet">Premium</span>;
}

/**
 * Source picker for a title, and — unless the page supplies its own player —
 * the frame it drives.
 *
 * The provider is one piece of state, so switching sources is a click rather
 * than a resolver round trip: the backend's chain is the *order*, and the
 * picker's job is to say which of those the viewer wants. It also keeps the
 * "which server am I on" answer visible, which is the thing a viewer needs when
 * one mirror is buffering and another is not.
 */
export function ServerSelector({
  tmdbId,
  mediaType,
  season,
  episode,
  sources,
  selectedId,
  onSelect,
  frame,
  showPlayer = true,
  title,
  className,
}: ServerSelectorProps) {
  const chain = useMemo(() => {
    if (sources && sources.length) return sources;
    return resolveEmbedSources({ tmdbId, mediaType, season, episode });
  }, [sources, tmdbId, mediaType, season, episode]);

  const [internalId, setInternalId] = useState<string>(
    () => chain[0]?.id ?? DEFAULT_STREAM_PROVIDER.id
  );
  const [attempt, setAttempt] = useState(0);

  // A title change (new season, new episode, new movie) invalidates the previous
  // pick: the stored id is only honoured when the new chain still carries that
  // provider, so switching episodes starts from the primary source instead of
  // inheriting a mirror chosen for a different title.
  useEffect(() => {
    if (!chain.length) return;
    const stillOffered = chain.some(
      source => source.id === (selectedId ?? internalId)
    );
    if (!stillOffered) setInternalId(chain[0].id);
  }, [chain, selectedId, internalId]);

  const selected =
    chain.find(source => source.id === (selectedId ?? internalId)) ??
    chain[0] ??
    null;

  const select = (source: ResolvedEmbedSource) => {
    if (source.id === selected?.id) return;
    if (onSelect) onSelect(source.id);
    if (selectedId === undefined) setInternalId(source.id);
    // Bumping the key is what makes a stubborn frame reload: some providers
    // cache the document, and re-pointing `src` at the same URL does nothing.
    setAttempt(n => n + 1);
  };

  if (!selected) return null;

  const host = selected.host || providerHost(findStreamProvider(selected.id));

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
          Playback source
        </h3>
        <span className="sv-badge sv-badge-violet">
          Now playing: {selected.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {chain.map(source => {
          const isActive = source.id === selected.id;
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => select(source)}
              aria-pressed={isActive}
              title={source.title}
              className={cn(
                "flex flex-col rounded-xl border p-3 text-left transition-all",
                isActive
                  ? "border-violet-500/70 bg-violet-600/20 text-white shadow-lg shadow-violet-500/15"
                  : "border-white/5 bg-slate-900/40 text-gray-400 hover:border-white/20 hover:text-gray-200"
              )}
            >
              <span className="truncate text-xs font-bold">{source.label}</span>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="truncate text-[10px] text-gray-400">
                  {source.quality ?? host}
                </span>
                {isActive ? (
                  <span className="text-violet-300" aria-hidden>
                    <Check className="h-3 w-3" />
                  </span>
                ) : (
                  <TypeBadge type={source.type} />
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Player frame: this component's own, when it is the player. */}
      {showPlayer && !frame ? (
        <div className="relative mt-4 aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
          <iframe
            key={`${selected.id}-${attempt}`}
            src={selected.url}
            title={title ?? `${selected.label} player`}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
            allow={EMBED_ALLOW}
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        </div>
      ) : null}
    </div>
  );
}

export default ServerSelector;
