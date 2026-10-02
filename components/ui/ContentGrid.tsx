import Link from "next/link";
import type { MediaKind } from "@/types/stream";
import type { StreamQuality } from "@/types/stream";

export interface ContentCardItem {
  titleId: string;
  title: string;
  synopsis: string;
  kind: MediaKind;
  year: number | null;
  rating: string | null;
  genres: string[];
  posterUrl: string;
  downloadableQualities: StreamQuality[];
}

export function ContentGrid({
  title,
  items,
}: {
  title: string;
  items: ContentCardItem[];
}) {
  if (!items.length) return null;
  return (
    <section className="px-5 py-8 sm:px-8 lg:px-12" aria-label={title}>
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/40">
              Your collection
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-white sm:text-2xl">
              {title}
            </h2>
          </div>
          <span className="text-xs text-white/45">
            {items.length} {items.length === 1 ? "title" : "titles"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map(item => (
            <Link
              key={item.titleId}
              href={`/watch/${encodeURIComponent(item.titleId)}`}
              className="group/card min-w-0 overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.025] transition duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200"
            >
              <div className="relative aspect-[2/3] overflow-hidden bg-zinc-900">
                {item.posterUrl ? (
                  <img
                    src={item.posterUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition duration-500 group-hover/card:scale-[1.045]"
                  />
                ) : (
                  <div className="grid h-full place-items-center px-4 text-center font-medium text-white/40">
                    {item.title}
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/30 opacity-80" />
                <div className="absolute left-2 top-2 flex gap-1.5">
                  <span className="rounded bg-white/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-white backdrop-blur-md">
                    {item.kind === "series" ? "Series" : "Film"}
                  </span>
                  {item.rating ? (
                    <span className="rounded bg-white/10 px-2 py-1 text-[10px] text-white backdrop-blur-md">
                      ★ {item.rating}
                    </span>
                  ) : null}
                </div>
                <div className="absolute inset-x-0 bottom-0 p-3">
                  <p className="line-clamp-1 text-sm font-semibold text-white">
                    {item.title}
                  </p>
                  <p className="mt-1 text-[11px] text-white/60">
                    {[item.year, item.genres[0]].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
