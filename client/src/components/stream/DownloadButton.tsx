import { ChevronDown, Download } from "lucide-react";
import {
  proxiedDownloadUrl,
  type StreamVariant,
} from "@/services/api";
import {
  buildDownloadFilename,
  classifyDownloadUrl,
  type DownloadCandidate,
} from "@/lib/downloadSource";

interface DownloadButtonProps {
  title: string;
  year?: number | null;
  variants: StreamVariant[];
}

interface DownloadTier {
  label: string;
  maxHeight: number;
  candidate: DownloadCandidate;
}

const QUALITY_TIERS = [
  { label: "360p (Data Saver)", maxHeight: 360 },
  { label: "720p (HD)", maxHeight: 720 },
  { label: "1080p (Full HD)", maxHeight: 1080 },
] as const;

function heightOf(variant: StreamVariant): number {
  if (variant.height > 0) return variant.height;
  if (variant.quality === "4K") return 2160;
  const match = /^(\d+)p$/.exec(variant.quality);
  return match ? Number(match[1]) : 0;
}

function isArchiveFile(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "archive.org" ||
        parsed.hostname.endsWith(".archive.org"))
    );
  } catch {
    return false;
  }
}

export function buildDownloadTiers(variants: StreamVariant[]): DownloadTier[] {
  const directFiles = variants
    .filter(variant => variant.url && isArchiveFile(variant.url))
    .map(variant => ({
      variant,
      candidate: classifyDownloadUrl(variant.url),
      height: heightOf(variant),
    }))
    .filter(
      file => file.candidate.kind === "progressive" && file.height > 0
    )
    .sort((a, b) => a.height - b.height);

  const seenUrls = new Set<string>();
  const tiers: DownloadTier[] = [];
  for (const tier of QUALITY_TIERS) {
    const selected = directFiles
      .filter(file => file.height <= tier.maxHeight)
      .at(-1);
    if (!selected || seenUrls.has(selected.candidate.url)) continue;
    seenUrls.add(selected.candidate.url);
    tiers.push({ ...tier, candidate: selected.candidate });
  }
  return tiers;
}

export function DownloadButton({
  title,
  year,
  variants,
}: DownloadButtonProps) {
  const tiers = buildDownloadTiers(variants);

  return (
    <details className="group relative">
      <summary
        className={`list-none [&::-webkit-details-marker]:hidden ${
          tiers.length ? "cursor-pointer" : "cursor-not-allowed"
        }`}
        aria-label={tiers.length ? "Download options" : "Download unavailable"}
        onClick={event => {
          if (!tiers.length) event.preventDefault();
        }}
      >
        <span
          aria-disabled={!tiers.length}
          className={`inline-flex items-center gap-2 rounded-md border border-white/15 px-4 py-3 text-sm font-medium text-white transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${
            tiers.length
              ? "hover:bg-white/10"
              : "cursor-not-allowed opacity-50"
          }`}
        >
          <Download className="h-4 w-4" />
          <span>Download</span>
          <ChevronDown
            aria-hidden
            className="h-4 w-4 transition-transform group-open:rotate-180"
          />
        </span>
      </summary>

      {tiers.length ? (
        <div className="absolute right-0 z-30 mt-2 w-64 rounded-xl border border-white/10 bg-zinc-900/95 p-2 shadow-2xl backdrop-blur-xl">
          {tiers.map(tier => {
            const filename = buildDownloadFilename(
              { title, year },
              tier.candidate
            );
            const href = proxiedDownloadUrl(tier.candidate.url, filename);
            return (
              <a
                key={tier.label}
                href={href}
                download={filename}
                onClick={event => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}
                className="block rounded-lg px-3 py-2.5 text-sm font-medium text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
              >
                {tier.label}
              </a>
            );
          })}
          <p className="px-3 pb-1 pt-2 text-[11px] leading-4 text-white/45">
            Uses the closest available file at or below the selected quality.
          </p>
        </div>
      ) : null}
    </details>
  );
}
