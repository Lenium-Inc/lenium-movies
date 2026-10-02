import { describe, expect, it } from "vitest";
import type { StreamVariant } from "@/services/api";
import { buildDownloadTiers } from "./DownloadButton";

const variant = (
  quality: StreamVariant["quality"],
  height: number,
  file: string
): StreamVariant => ({
  quality,
  height,
  width: Math.round((height * 16) / 9),
  size: 1,
  url: `https://archive.org/download/public-film/${file}`,
});

describe("buildDownloadTiers", () => {
  it("offers only distinct available progressive Archive.org files", () => {
    const tiers = buildDownloadTiers([
      variant("320p", 360, "small.mp4"),
      variant("720p", 720, "hd.mp4"),
      variant("1080p", 1080, "full-hd.mp4"),
      variant("4K", 2160, "4k.mp4"),
    ]);

    expect(tiers.map(tier => tier.label)).toEqual([
      "360p (Data Saver)",
      "720p (HD)",
      "1080p (Full HD)",
    ]);
    expect(tiers.map(tier => tier.candidate.url)).toEqual([
      "https://archive.org/download/public-film/small.mp4",
      "https://archive.org/download/public-film/hd.mp4",
      "https://archive.org/download/public-film/full-hd.mp4",
    ]);
  });

  it("does not offer external or playlist URLs for download", () => {
    const tiers = buildDownloadTiers([
      {
        ...variant("720p", 720, "embed.mp4"),
        url: "https://player.example/embed/movie/1",
      },
      {
        ...variant("1080p", 1080, "playlist.mp4"),
        url: "https://archive.org/download/public-film/master.m3u8",
      },
    ]);

    expect(tiers).toEqual([]);
  });

  it("does not duplicate the same file across quality choices", () => {
    const file = variant("320p", 360, "same.mp4");
    const tiers = buildDownloadTiers([
      file,
      { ...file, quality: "720p", height: 720 },
      { ...file, quality: "1080p", height: 1080 },
    ]);

    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.label).toBe("360p (Data Saver)");
  });
});
