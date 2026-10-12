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
  { label: "480p (SD)", maxHeight: 480 },
  { label: "720p (HD)", maxHeight: 720 },
  { label: "1080p (Full HD)", maxHeight: 1080 },
  { label: "1440p (2K)", maxHeight: 1440 },
  { label: "2160p (4K)", maxHeight: 2160 },
  { label: "4320p (8K)", maxHeight: 4320 },
] as const;

// The resolver's quality labels. "4K"/"8K" are ceiling names, not pixel
// heights, and 2K is 1440p rather than 2×1080 — hence an explicit map.
const K_LABEL_HEIGHT: Record<string, number> = {
  "2K": 1440,
  "4K": 2160,
  "8K": 4320,
};

function heightOf(variant: StreamVariant): number {
  if (variant.height > 0) return variant.height;
  const fromK = K_LABEL_HEIGHT[variant.quality.toUpperCase()];
  if (fromK) return fromK;
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

/**
 * The saveable rungs for a resolved title.
 *
 * The live path is `variant.downloadUrl`: the resolver ships every rendition
 * as an opaque same-origin play handle (`/api/v1/playback/media?token=…`),
 * which is a playlist relay and useless as a download — but it also mints a
 * separate `/api/v1/playback/download?token=…` handle whenever the rendition
 * really is a single file, validated server-side. Trusting that handle skips
 * the client-side container sniffing that could never classify a tokenised
 * URL.
 *
 * The absolute-archive-URL path remains as a fallback for payloads that still
 * carry raw Archive.org links.
 */
export function buildDownloadTiers(variants: StreamVariant[]): DownloadTier[] {
  const directFiles: { height: number; candidate: DownloadCandidate }[] = [];
  for (const variant of variants) {
    const downloadUrl =
      typeof variant.downloadUrl === "string" ? variant.downloadUrl.trim() : "";
    if (downloadUrl) {
      const height = heightOf(variant);
      if (height <= 0) continue;
      // The handle *is* the download URL, so it is carried as the candidate
      // url; the render layer navigates to it directly.
      directFiles.push({
        height,
        candidate: { kind: "progressive", url: downloadUrl },
      });
      continue;
    }
    if (!variant.url || !isArchiveFile(variant.url)) continue;
    const candidate = classifyDownloadUrl(variant.url);
    if (candidate.kind !== "progressive") continue;
    const height = heightOf(variant);
    if (height <= 0) continue;
    directFiles.push({ height, candidate });
  }
  directFiles.sort((a, b) => a.height - b.height);

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
            // A same-origin handle is the download route itself; a raw
            // archive.org URL still needs the relay alias built around it.
            const href = tier.candidate.url.startsWith("/")
              ? tier.candidate.url
              : proxiedDownloadUrl(tier.candidate.url, filename);
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
