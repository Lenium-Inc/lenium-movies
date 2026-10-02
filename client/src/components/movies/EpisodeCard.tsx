import { useState } from "react";
import { Star } from "lucide-react";
import { ErrorBoundary, ErrorFallback } from "@/components/ErrorBoundary";
import type { SeasonEpisode } from "@/services/api";

interface EpisodeCardProps {
  episode: SeasonEpisode;
  showName: string;
  /** Resume fraction for this exact episode, or null when it is unwatched. */
  resume?: number | null;
  onPlay: () => void;
}

/**
 * One episode, as a card.
 *
 * The still is 16:9 and the poster beneath it is 2:3, so this is not a
 * `MovieCard` with different text on it -- a shelf of 2:3 posters would not read
 * as "recently released episodes", which is the one thing this shelf has to
 * communicate at a glance.
 *
 * The `S1 · E5` badge is permanent rather than hover-revealed for the same
 * reason: an episode is identified by its position in a season, and that is the
 * first thing a viewer needs, not something to reward a hover.
 */
export const EpisodeCard: React.FC<EpisodeCardProps> = ({
  episode,
  showName,
  resume,
  onPlay,
}) => {
  const [stillFailed, setStillFailed] = useState(false);
  // Remounts the card on retry, which also clears the failed-still flag: the
  // still URL is deterministic, but a transient network failure on the image is
  // the common case here and a retry should give it another chance.
  const [retryKey, setRetryKey] = useState(0);
  const hasStill = Boolean(episode.still_url) && !stillFailed;
  const resumePct =
    typeof resume === "number" && resume > 0
      ? Math.min(100, Math.round(resume * 100))
      : 0;

  return (
    <article className="group relative w-full">
      <ErrorBoundary
        key={retryKey}
        fallback={
          <ErrorFallback
            aspect="aspect-video"
            retry={() => {
              setStillFailed(false);
              setRetryKey(k => k + 1);
            }}
          />
        }
      >
        <button
          type="button"
          onClick={onPlay}
          className="block w-full cursor-pointer overflow-hidden rounded-xl border border-white/5 bg-zinc-900/50 text-left transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-white/20"
          aria-label={`Play ${showName} season ${episode.season} episode ${episode.number}, ${episode.title}`}
        >
          <div className="relative aspect-video w-full overflow-hidden bg-zinc-800">
            {hasStill ? (
              <img
                src={episode.still_url}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
                onError={() => setStillFailed(true)}
              />
            ) : (
              /* Many episodes genuinely have no still on TMDB. A typographic
                 placeholder keeps the shelf's rhythm intact where a third-party
                 placeholder image would break it with a different aspect ratio. */
              <span
                aria-hidden
                className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-950 px-3 text-center font-display text-sm font-bold text-white/50"
              >
                {showName}
              </span>
            )}

            <span className="absolute left-2 top-2 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white backdrop-blur-sm">
              S{episode.season} · E{episode.number}
            </span>

            {episode.vote_average ? (
              <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-black text-black">
                <Star className="h-2.5 w-2.5 fill-current" />
                {episode.vote_average.toFixed(1)}
              </span>
            ) : null}

            {resumePct > 0 ? (
              <div
                className="absolute inset-x-0 bottom-0 h-1 bg-white/15"
                role="progressbar"
                aria-valuenow={resumePct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${resumePct}% watched`}
              >
                <div
                  className="h-full bg-gradient-to-r from-violet-500 to-cyan-400"
                  style={{ width: `${resumePct}%` }}
                />
              </div>
            ) : null}
          </div>

          <div className="p-2.5">
            <h3 className="line-clamp-1 text-xs font-semibold text-white">
              {episode.title}
            </h3>
            <p className="mt-1 line-clamp-1 text-[11px] text-zinc-500">
              {showName}
              {episode.air_date ? ` · ${formatAirDate(episode.air_date)}` : ""}
            </p>
          </div>
        </button>
      </ErrorBoundary>
    </article>
  );
};

/**
 * Aired "3 days ago" rather than "2026-09-28".
 *
 * This shelf exists to answer "what is new", and an ISO date makes the viewer do
 * the subtraction.
 *
 * `days` is negative for the past -- it is `airDate - now` -- so every branch
 * below reads its sign carefully. The window is one week in each direction: TMDB
 * pre-dates an episode by a day or two either way, and a countdown is useful that
 * close to the air date. Further out than a week a date is printed instead,
 * because "in 34 days" is a worse answer than "Nov 12" and reads as a promise the
 * date will not keep if an episode moves.
 */
export function formatAirDate(airDate: string): string {
  const parsed = Date.parse(`${airDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) return airDate;

  const now = new Date();
  const nowUtcDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const airDateUtcDay = Date.UTC(
    new Date(parsed).getUTCFullYear(),
    new Date(parsed).getUTCMonth(),
    new Date(parsed).getUTCDate(),
  );
  const days = Math.round((airDateUtcDay - nowUtcDay) / 86_400_000);

  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days < 0 && days >= -7) return `${Math.abs(days)} days ago`;
  if (days === 1) return "tomorrow";
  if (days > 1 && days <= 7) return `in ${days} days`;

  return new Date(parsed).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default EpisodeCard;
