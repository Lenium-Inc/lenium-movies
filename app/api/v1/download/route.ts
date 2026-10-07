import { NextResponse } from "next/server";
import {
  cancelBodyOnAbort,
  memoryGuardResponse,
  upstreamSignal,
} from "@/lib/memory-guard";
import {
  assertAuthorizedMediaUrl,
  findVodTitle,
  RequestInputError,
  sanitizeFilename,
} from "@/lib/proxy-utils";
import type { StreamQuality } from "@/types/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".mkv", ".mov"]);
const QUALITY_OPTIONS: StreamQuality[] = ["1080p", "720p", "480p"];
const UPSTREAM_TIMEOUT_MS = 30_000;

export async function GET(request: Request) {
  // A whole-file download is the largest single response this service emits, so
  // it is the most likely to be what tips a loaded instance over. Shedding it
  // costs a 503 and a retry; being OOM-killed costs every concurrent viewer on
  // the process, including the segment traffic that was still healthy.
  const shed = memoryGuardResponse(
    (body, init) => NextResponse.json(body, init)
  );
  if (shed) return shed;

  const params = new URL(request.url).searchParams;
  const titleId = params.get("titleId") ?? "";
  const quality = params.get("quality") as StreamQuality | null;
  const season = Number(params.get("season"));
  const episode = Number(params.get("episode"));
  if (!titleId || !quality || !QUALITY_OPTIONS.includes(quality)) {
    return NextResponse.json(
      { error: "A valid titleId and quality are required." },
      { status: 400 }
    );
  }

  const { signal, release } = upstreamSignal(request.signal, UPSTREAM_TIMEOUT_MS);
  try {
    const title = findVodTitle(titleId);
    if (!title) {
      return NextResponse.json({ error: "Title not found." }, { status: 404 });
    }
    const selectedEpisode =
      title.kind === "series"
        ? title.episodes?.find(
            item => item.season === season && item.episode === episode
          )
        : undefined;
    if (title.kind === "series" && !selectedEpisode) {
      return NextResponse.json(
        { error: "Select a valid episode before downloading." },
        { status: 400 }
      );
    }
    const asset = (selectedEpisode?.downloads ?? title.downloads)?.[quality];
    if (!asset) {
      return NextResponse.json(
        { error: "This title has no authorized file download at that quality." },
        { status: 404 }
      );
    }
    const originUrl = assertAuthorizedMediaUrl(asset).href;
    const extension = new URL(originUrl).pathname.match(/\.[a-z0-9]{2,5}$/i)?.[0].toLowerCase();
    if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
      return NextResponse.json(
        { error: "The authorized asset is not a downloadable media file." },
        { status: 415 }
      );
    }
    const range = request.headers.get("range");
    const upstream = await fetch(originUrl, {
      headers: range ? { Range: range } : undefined,
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json(
        { error: "The authorized download is temporarily unavailable." },
        { status: 502 }
      );
    }
    if (!upstream.body) {
      return NextResponse.json(
        { error: "The authorized download was empty." },
        { status: 502 }
      );
    }
    const episodeLabel = selectedEpisode
      ? ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      : "";
    const filename = sanitizeFilename(`${title.title}${episodeLabel} ${quality}${extension}`);
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const encodedFilename = encodeURIComponent(filename).replace(
      /[!'()*]/g,
      character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    const headers = new Headers({
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodedFilename}`,
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of ["accept-ranges", "content-length", "content-range"] as const) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    // Zero-buffer relay of the file body: the upstream stream is handed straight
    // to the response rather than collected, so a multi-gigabyte 1080p file is
    // never held in this process. Aborting with the client closes the upstream
    // socket instead of leaving it to drain into a dead tab.
    return new Response(cancelBodyOnAbort(upstream.body, request.signal), {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    if (error instanceof RequestInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[download] Authorized download failed.", error);
    return NextResponse.json(
      { error: "Could not start the authorized download." },
      { status: 500 }
    );
  } finally {
    release();
  }
}
