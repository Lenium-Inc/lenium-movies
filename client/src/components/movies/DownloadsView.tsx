import { useEffect, useState } from "react";
import { Download, ExternalLink, Play, Trash2, Film, Clock } from "lucide-react";
import {
  clearDownloads,
  getDownloads,
  removeDownload,
  subscribeDownloads,
  type DownloadEntry,
} from "@/services/downloads";
import { useLocation } from "wouter";

interface DownloadsViewProps {
  onOpen?: (entry: DownloadEntry) => void;
}

function formatAddedAt(epochMs: number): string {
  const date = new Date(epochMs);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function DownloadsView({ onOpen }: DownloadsViewProps) {
  const [, navigate] = useLocation();
  const [entries, setEntries] = useState<DownloadEntry[]>(() => getDownloads());

  useEffect(() => subscribeDownloads(() => setEntries(getDownloads())), []);

  const handlePlay = (entry: DownloadEntry) => {
    const url = `/watch/${entry.key}`;
    navigate(url);
  };

  const handleOpen = (entry: DownloadEntry) => {
    if (onOpen) onOpen(entry);
    window.open(entry.proxyUrl, "_blank", "noopener,noreferrer");
  };

  if (entries.length === 0) {
    return (
      <section className="py-16">
        <div className="mx-auto max-w-md text-center">
          <div className="mx-auto grid h-20 w-20 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-indigo-700/20">
            <Download className="h-9 w-9 text-indigo-400" />
          </div>
          <h1 className="mt-6 text-2xl font-bold text-white">Downloads</h1>
          <p className="mt-2 text-sm leading-6 text-[#99999d]">
            Title-by-title video downloads appear here once you save them from a
            watch page or title details.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b8b90]">
            Downloaded for offline viewing
          </p>
          <h1 className="mt-1 text-2xl font-bold text-white">Downloads</h1>
        </div>
        <button
          onClick={clearDownloads}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-3.5 py-2 text-xs font-semibold text-[#d0d0cc] transition hover:border-red-500/40 hover:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear All
        </button>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <div
            key={entry.key}
            className="group relative overflow-hidden rounded-xl border border-white/10 bg-[#121216] transition hover:border-white/20"
          >
            <div className="aspect-video bg-zinc-900">
              {entry.poster ? (
                <img
                  src={entry.poster}
                  alt={entry.title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full w-full place-items-center">
                  <Film className="h-8 w-8 text-zinc-700" />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
              <span className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white/80 backdrop-blur-sm">
                {entry.quality ?? "Download"}
              </span>
            </div>
            <div className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-white">
                    {entry.title}
                  </h3>
                  <div className="mt-1 flex items-center gap-2 text-xs text-[#8b8b90]">
                    {entry.year ? <span>{entry.year}</span> : null}
                    {entry.sizeBytes ? (
                      <>
                        <span>·</span>
                        <span>{formatSize(entry.sizeBytes)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <button
                  onClick={() => removeDownload(entry.key)}
                  aria-label={`Remove ${entry.title} from downloads`}
                  className="shrink-0 rounded-lg p-2 text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={() => handlePlay(entry)}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-white px-4 py-2 text-xs font-bold text-black transition hover:bg-white/90"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  Play
                </button>
                <button
                  onClick={() => handleOpen(entry)}
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-white/15 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/10"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open
                </button>
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-[11px] text-[#8b8b90]">
                <Clock className="h-3 w-3" />
                Saved {formatAddedAt(entry.addedAt)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}