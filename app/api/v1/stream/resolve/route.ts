import { NextResponse } from "next/server";
import {
  createProxyToken,
  findVodTitle,
  parseMasterAudio,
  parseMasterQualities,
  parseMasterSubtitles,
  readBoundedText,
  RequestInputError,
} from "@/lib/proxy-utils";
import type { StreamPayload } from "@/types/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const titleId = params.get("titleId")?.trim() ?? "";
  if (!titleId) return jsonError("titleId is required.", 400);

  try {
    const item = findVodTitle(titleId);
    if (!item) return jsonError("Title not found.", 404);
    const rawSeason = params.get("season");
    const rawEpisode = params.get("episode");
    const season = rawSeason ? Number(rawSeason) : undefined;
    const episode = rawEpisode ? Number(rawEpisode) : undefined;
    const selectedEpisode =
      season !== undefined && episode !== undefined
        ? item.episodes?.find(
            candidate =>
              candidate.season === season && candidate.episode === episode
          )
        : item.kind === "series"
          ? item.episodes?.[0]
          : undefined;
    if (item.kind === "series" && !selectedEpisode) {
      return jsonError("A valid episode is required for this series.", 400);
    }
    const masterPlaylist =
      selectedEpisode?.playlistUrl ?? item.masterPlaylist;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let response: Response;
    try {
      response = await fetch(masterPlaylist, {
        headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain" },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      return jsonError("The authorized stream is temporarily unavailable.", 502);
    }
    // Bounded: the manifest is capped, so a hostile or broken origin cannot turn
    // this endpoint into an unbounded allocation.
    const manifestText = await readBoundedText(response);
    const qualities = parseMasterQualities(manifestText, masterPlaylist);
    // Audio renditions are parsed here rather than left to the player. An HLS
    // master carries them as `EXT-X-MEDIA` entries on sub-playlists, and an
    // English dub for a foreign-language release exists only as one of those --
    // so a resolver that reads only `EXT-X-STREAM-INF` resolves the video ladder
    // perfectly and silently offers no way to hear the film in English.
    const audio = parseMasterAudio(
      manifestText,
      masterPlaylist,
      item.originalLanguage
    );
    const subtitleTracks = parseMasterSubtitles(manifestText, masterPlaylist);

    const payload: StreamPayload = {
      titleId: item.titleId,
      title: item.title,
      kind: item.kind,
      masterUrl: `/api/v1/proxy/m3u8?token=${encodeURIComponent(createProxyToken(masterPlaylist))}`,
      fallbackMasterUrls: (item.fallbackPlaylists ?? []).map(playlist => {
        const token = createProxyToken(playlist);
        return `/api/v1/proxy/m3u8?token=${encodeURIComponent(token)}`;
      }),
      subtitles: subtitleTracks,
      audio,
      qualities,
      episodes: item.episodes ?? [],
      downloadableQualities: Object.keys(
        selectedEpisode?.downloads ?? item.downloads ?? {}
      ) as StreamPayload["downloadableQualities"],
      ...(selectedEpisode
        ? {
            selectedEpisode: {
              season: selectedEpisode.season,
              episode: selectedEpisode.episode,
              title: selectedEpisode.title,
            },
          }
        : {}),
    };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof RequestInputError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof Error && error.name === "AbortError") {
      return jsonError("Stream resolution timed out.", 504);
    }
    console.error("[stream.resolve] Failed to resolve authorized media.", error);
    return jsonError("Could not resolve this title.", 500);
  }
}
