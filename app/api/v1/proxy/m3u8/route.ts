import { NextResponse } from "next/server";
import {
  memoryGuardResponse,
  upstreamSignal,
} from "@/lib/memory-guard";
import {
  readBoundedText,
  readProxyToken,
  RequestInputError,
  rewriteManifest,
} from "@/lib/proxy-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 12_000;

export async function GET(request: Request) {
  // Same ceiling and same reason as the segment route: a manifest fetch holds
  // the parsed playlist text in memory while it is rewritten, and a player that
  // scrubs seeks through variants constantly. Refusing before the fetch keeps
  // the cost of shedding to one call.
  const shed = memoryGuardResponse(
    (body, init) => NextResponse.json(body, init)
  );
  if (shed) return shed;

  const token = new URL(request.url).searchParams.get("token") ?? "";
  const { signal, release } = upstreamSignal(request.signal, UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamUrl = readProxyToken(token);
    const response = await fetch(upstreamUrl, {
      headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain" },
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: "The authorized manifest is unavailable." },
        { status: 502 }
      );
    }
    // Bounded: `readBoundedText` cancels the reader and throws once the byte
    // ceiling is passed, so an upstream claiming to be a manifest cannot be used
    // to allocate without limit.
    const text = await readBoundedText(response);
    const rewritten = rewriteManifest(text, upstreamUrl);
    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof RequestInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[stream.m3u8] Authorized manifest request failed.", error);
    return NextResponse.json(
      { error: "The stream manifest could not be loaded." },
      { status: 502 }
    );
  } finally {
    release();
  }
}