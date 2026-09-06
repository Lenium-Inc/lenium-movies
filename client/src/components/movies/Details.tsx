import { Bookmark, Check, Play, Star, X } from "lucide-react";
import { toast } from "sonner";
import { getPlaybackUnavailableState } from "../../../../shared/playback";
import { trpc } from "@/lib/trpc";
import type { Movie } from "./types";

interface DetailsProps {
  movie: Movie;
  onClose: () => void;
  onSave: () => void;
  saved: boolean;
}

/**
 * Bottom-sheet style modal that shows a movie's metadata plus its verified
 * official trailer (fetched on demand through the catalog router) and
 * playback / save actions.
 */
export function Details({ movie, onClose, onSave, saved }: DetailsProps) {
  const trailer = trpc.catalog.trailer.useQuery(
    { movieId: movie.id },
    { retry: false }
  );
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${movie.title} details`}
      onClick={onClose}
    >
      <div
        onClick={event => event.stopPropagation()}
        className="max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-t-xl border border-white/10 bg-[#151519] shadow-2xl sm:rounded-xl"
      >
        <div className="relative h-44 overflow-hidden sm:h-56">
          {movie.backdrop && (
            <img
              src={movie.backdrop}
              alt=""
              className="h-full w-full object-cover"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#151519] to-transparent" />
          <button
            onClick={onClose}
            aria-label="Close details"
            className="absolute right-3 top-3 rounded-full bg-black/60 p-2 text-white"
          >
            <X className="h-4 w-4" />
          </button>
          <h2 className="absolute bottom-5 left-5 text-2xl font-bold sm:text-3xl">
            {movie.title}
          </h2>
        </div>
        <div className="p-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#aaa9ae]">
            <span>{movie.year ?? "Year unavailable"}</span>
            <span>·</span>
            <span>{movie.runtime}</span>
            <span>·</span>
            <span>{movie.genre.join(" · ")}</span>
            {movie.score !== null && (
              <span className="flex items-center gap-1 text-[#d7d7d3]">
                <Star className="h-3.5 w-3.5 fill-current" />
                {movie.score}
              </span>
            )}
          </div>
          <p className="mt-4 text-sm leading-6 text-[#c5c5c1]">
            {movie.synopsis}
          </p>
          {trailer.isLoading ? (
            <div className="mt-5 rounded-md border border-white/10 bg-white/[0.03] p-4 text-xs text-[#99999d]">
              Checking for an official trailer…
            </div>
          ) : trailer.data?.asset ? (
            <div className="mt-5 overflow-hidden rounded-lg border border-white/10 bg-black">
              <div className="aspect-video">
                <iframe
                  title={`${movie.title} official trailer`}
                  src={trailer.data.asset.embedUrl}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              </div>
              <div className="flex items-center justify-between gap-3 px-3 py-2 text-[11px] text-[#99999d]">
                <span className="line-clamp-1">{trailer.data.asset.name}</span>
                <a
                  href={trailer.data.asset.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-[#d7d7d3] hover:text-white"
                >
                  Open on YouTube
                </a>
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-md border border-white/10 bg-white/[0.03] p-4 text-xs leading-5 text-[#99999d]">
              No verified official trailer is available. This does not affect
              streaming availability.
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={() =>
                toast.info(getPlaybackUnavailableState().message, {
                  duration: 3000,
                })
              }
              className="flex items-center gap-2 rounded-md border border-white/15 px-4 py-2.5 text-xs font-semibold hover:bg-white/10"
            >
              <Play className="h-3.5 w-3.5" /> Playback unavailable
            </button>
            <button
              onClick={onSave}
              className="flex items-center gap-2 rounded-md bg-[#d7d7d3] px-4 py-2.5 text-xs font-bold text-[#0b0b0e] hover:bg-white"
            >
              {saved ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Bookmark className="h-3.5 w-3.5" />
              )}{" "}
              {saved ? "In My List" : "Add to My List"}
            </button>
          </div>
          <div className="mt-5 rounded-md border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-[#99999d]">
            TMDB supplies metadata and this verified trailer only. Streaming
            rights, captions, availability, and playback are separate
            capabilities.
          </div>
        </div>
      </div>
    </div>
  );
}
