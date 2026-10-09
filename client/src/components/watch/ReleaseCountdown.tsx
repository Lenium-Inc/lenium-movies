import type { Movie } from "@/components/movies/types";
import { RemindMeButton } from "@/components/movies/RemindMeButton";
import {
  formatReleaseMonthDay,
  releaseCountdownLabel,
} from "@/services/notifications";

interface ReleaseCountdownProps {
  movie: Movie;
  /** Extra spacing below the stack, for the hero variant. */
  className?: string;
}

/**
 * The watch artboard's unreleased state: what fills the player frame when a
 * title has no stream because it has not come out yet.
 *
 * Deliberately the same three lines as the mockup -- a small caps countdown,
 * the release day at display size, the year -- and the notify pill. No
 * progress bar: the only number a viewer can act on is the day count, and a
 * bar whose "start" is an invented announcement date would be decoration
 * pretending to be information.
 */
export function ReleaseCountdown({
  movie,
  className = "",
}: ReleaseCountdownProps) {
  const releaseDate = movie.releaseDate;
  if (!releaseDate) return null;
  const label = releaseCountdownLabel(releaseDate);
  const year = /^\d{4}/.exec(releaseDate)?.[0] ?? "";

  return (
    <div
      className={
        "flex flex-col items-center gap-2.5 text-center text-white " + className
      }
    >
      {label ? (
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-[#aab3c7]">
          {label}
        </p>
      ) : null}
      <p className="text-[clamp(34px,4.2vw,60px)] font-light leading-[1.05] tracking-[-0.02em]">
        {formatReleaseMonthDay(releaseDate)}
      </p>
      {year ? <p className="text-sm text-[#aab3c7]">{year}</p> : null}
      <div className="mt-3">
        <RemindMeButton movie={movie} />
      </div>
    </div>
  );
}

export default ReleaseCountdown;
