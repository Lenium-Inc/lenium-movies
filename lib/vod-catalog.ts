import "server-only";
import { getVodCatalog } from "@/lib/proxy-utils";
import type { StreamQuality } from "@/types/stream";

export function getPublicVodCatalog() {
  return getVodCatalog().map(
    ({
      titleId,
      title,
      synopsis,
      kind,
      year,
      rating,
      genres,
      cast,
      posterUrl,
      backdropUrl,
      episodes,
      downloads,
    }) => ({
      titleId,
      title,
      synopsis,
      kind,
      year,
      rating,
      genres,
      cast: cast ?? [],
      posterUrl,
      backdropUrl,
      episodes: episodes ?? [],
      downloadableQualities:
        kind === "movie"
          ? (Object.keys(downloads ?? {}) as StreamQuality[])
          : [],
    })
  );
}
