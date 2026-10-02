import { NextResponse } from "next/server";
import {
  readProxyToken,
  RequestInputError,
} from "@/lib/proxy-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const;

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    const upstreamUrl = readProxyToken(token);
    const range = request.headers.get("range");
    const response = await fetch(upstreamUrl, {
      headers: range ? { Range: range } : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && response.status !== 206) {
      const status = [401, 403, 404, 416].includes(response.status)
        ? response.status
        : 502;
      return NextResponse.json(
        { error: "The authorized media segment is unavailable." },
        { status }
      );
    }
    if (!response.body) {
      return NextResponse.json(
        { error: "The authorized media segment was empty." },
        { status: 502 }
      );
    }

    const headers = new Headers({
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof RequestInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[stream.segment] Authorized segment request failed.", error);
    return NextResponse.json(
      { error: "The media segment could not be loaded." },
      { status: 502 }
    );
  }
}
