import Link from "next/link";
import { ArrowDown, Download, Play, Plus } from "lucide-react";
import type { MediaKind, StreamQuality } from "@/types/stream";

export interface FeaturedTitle {
  titleId: string;
  title: string;
  synopsis: string;
  kind: MediaKind;
  year: number | null;
  rating: string | null;
  genres: string[];
  backdropUrl: string;
  downloadableQualities: StreamQuality[];
}

export function HeroBanner({ title }: { title: FeaturedTitle }) {
  return (
    <section className="relative isolate flex min-h-[600px] items-end overflow-hidden lg:min-h-[82vh]">
      {title.backdropUrl ? (
        <div
          aria-hidden
          className="absolute inset-0 -z-20 bg-cover bg-center"
          style={{ backgroundImage: `url("${title.backdropUrl}")` }}
        />
      ) : null}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-r from-[#0f0f0f] via-black/80 to-transparent"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-t from-[#0b0b0b] via-[#0b0b0b]/25 to-black/10"
      />
      <div className="mx-auto w-full max-w-[1440px] px-5 pb-16 pt-36 sm:px-8 lg:px-12 lg:pb-24">
        <div className="max-w-2xl">
          <p className="mb-5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/90">
            <span className="h-px w-8 bg-cyan-300/70" />
            Tonight’s feature
          </p>
          <h1 className="max-w-xl text-5xl font-semibold leading-[0.96] tracking-[-0.045em] text-white sm:text-6xl lg:text-7xl">
            {title.title}
          </h1>
          <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-white/75">
            {title.year ? <span>{title.year}</span> : null}
            <span className="rounded border border-white/20 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]">
              {title.kind === "series" ? "Series" : "Feature"}
            </span>
            {title.rating ? (
              <span className="rounded bg-white/10 px-2 py-1 text-xs backdrop-blur-md">
                ★ {title.rating}
              </span>
            ) : null}
            {title.genres.slice(0, 3).map(genre => (
              <span key={genre} className="text-white/60">
                {genre}
              </span>
            ))}
          </div>
          <p className="mt-5 max-w-xl text-sm leading-6 text-white/75 sm:text-base sm:leading-7">
            {title.synopsis}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href={`/watch/${encodeURIComponent(title.titleId)}`}
              className="inline-flex min-h-12 items-center gap-2 rounded-md bg-white px-6 text-sm font-bold text-[#111] transition hover:bg-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
            >
              <Play className="h-4 w-4 fill-current" />
              Play
            </Link>
            <Link
              href={`/watch/${encodeURIComponent(title.titleId)}#details`}
              className="inline-flex min-h-12 items-center gap-2 rounded-md border border-white/20 bg-white/10 px-5 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
            >
              <Plus className="h-4 w-4" />
              More info
            </Link>
            {title.downloadableQualities.length ? (
              <a
                href={`/api/v1/download?titleId=${encodeURIComponent(title.titleId)}&quality=${encodeURIComponent(title.downloadableQualities.includes("1080p") ? "1080p" : title.downloadableQualities.includes("720p") ? "720p" : "480p")}`}
                className="inline-flex min-h-12 items-center gap-2 rounded-md border border-white/20 bg-white/[0.06] px-5 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
              >
                <Download className="h-4 w-4" />
                Download
              </a>
            ) : null}
            <a
              href="#catalog"
              className="ml-1 inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/20 text-white/80 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              aria-label="Browse the catalog"
            >
              <ArrowDown className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
