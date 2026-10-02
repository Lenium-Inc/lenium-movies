import { NextResponse } from "next/server";
import {
  readBoundedText,
  readProxyToken,
  RequestInputError,
  rewriteManifest,
} from "@/lib/proxy-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    const upstreamUrl = readProxyToken(token);
    const response = await fetch(upstreamUrl, {
      headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: "The authorized manifest is unavailable." },
        { status: 502 }
      );
    }
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
  }
}
