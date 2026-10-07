import { NextResponse } from "next/server";
import {
  memoryGuardResponse,
  upstreamSignal,
} from "@/lib/memory-guard";
import {
  assertAuthorizedMediaUrl,
  readProxyToken,
  readBoundedText,
  RequestInputError,
} from "@/lib/proxy-utils";
import { toWebVtt } from "@/lib/subtitles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * A ceiling, not a budget. Caption files are tens of kilobytes; anything near
 * this is not a subtitle track, and without the cap this endpoint would be an
 * arbitrary file-fetching primitive aimed at any allowlisted origin.
 */
const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;

/**
 * Same headers on every response, including errors.
 *
 * `Access-Control-Allow-Origin: *` is the point of the route. A `<track>` loads
 * its `src` through CORS, and a cross-origin subtitle file that does not opt in
 * is rejected by the browser before the parser ever sees it -- so a track that
 * is otherwise perfect renders nothing, with no error the player can see.
 * Star is correct here precisely because the response body is public caption
 * text derived from an already-authorized manifest; there is no credential and
 * no per-viewer state in it.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Max-Age": "86400",
} as const;

function vttResponse(body: string, cacheControl: string): Response {
  return new Response(body, {
    headers: {
      // `charset=utf-8` is not decoration. Chrome decodes a `text/vtt` response
      // without it as Latin-1 in some paths, which mangles every non-ASCII cue
      // into mojibake -- and caption text is exactly where non-ASCII lives.
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      ...CORS_HEADERS,
    },
  });
}

export async function GET(request: Request) {
  const shed = memoryGuardResponse(
    (body, init) => NextResponse.json(body, init)
  );
  if (shed) return shed;

  const params = new URL(request.url).searchParams;
  // Two ways to name the track. A `token` is what the resolver hands the player
  // and is preferred, because the browser then never sees an upstream origin at
  // all. A bare `url` stays supported for allowlisted origins so an already
  // deployed manifest or a hand-written `<track>` keeps working.
  const token = params.get("token") ?? "";
  const rawUrl = (params.get("url") ?? "").trim();

  const { signal, release } = upstreamSignal(request.signal, UPSTREAM_TIMEOUT_MS);
  try {
    let subtitleUrl: string;
    try {
      subtitleUrl = token ? readProxyToken(token) : assertAuthorizedMediaUrl(rawUrl).href;
    } catch (error) {
      if (error instanceof RequestInputError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const response = await fetch(subtitleUrl, {
      headers: { Accept: "text/vtt, application/x-subrip, text/plain, */*" },
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      const status = [401, 403, 404].includes(response.status) ? response.status : 502;
      return NextResponse.json(
        { error: "The subtitle track is unavailable." },
        { status }
      );
    }

    // The extension is only a hint: archives routinely serve an `.srt` as
    // `text/plain` and occasionally mislabel the container outright. So the body
    // is sniffed for the `WEBVTT` signature and converted when it is missing,
    // which is also what makes the route safe for a track whose filename lies.
    const raw = await readBoundedText(response, MAX_SUBTITLE_BYTES);
    // Held in memory to be rewritten, so this route is bounded rather than
    // zero-buffer -- a caption file cannot be streamed and converted at the same
    // time. The ceiling above is what keeps that bounded.
    return vttResponse(toWebVtt(raw), "private, max-age=300");
  } catch (error) {
    if (error instanceof RequestInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[subtitles] Authorized subtitle request failed.", error);
    return NextResponse.json(
      { error: "The subtitle track could not be loaded." },
      { status: 502 }
    );
  } finally {
    release();
  }
}

/**
 * A zero-body stream that only exists to satisfy the abort contract on HEAD.
 *
 * Chrome issues `HEAD` against a `<track>` `src` when it is measuring the
 * resource before committing to it, and a 405 there is treated as a missing
 * track. The headers are the answer -- the body is never read.
 */
export async function HEAD(): Promise<Response> {
  return vttResponse("", "private, max-age=300");
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}