import { NextResponse } from "next/server";
import {
  cancelBodyOnAbort,
  memoryGuardResponse,
  upstreamSignal,
} from "@/lib/memory-guard";
import {
  readProxyToken,
  RequestInputError,
} from "@/lib/proxy-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 30_000;

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const;

export async function GET(request: Request) {
  // Checked before the token is even decrypted. This is the hottest route in
  // the app -- one request per media segment, so a two-hour film is a few
  // thousand of them -- and the work below (AES-GCM decryption, a DNS lookup, a
  // TLS handshake, an upstream socket) is exactly the kind that pushes an
  // already-loaded process over the line. Refusing here costs one cheap call.
  const shed = memoryGuardResponse(
    (body, init) => NextResponse.json(body, init)
  );
  if (shed) return shed;

  const token = new URL(request.url).searchParams.get("token") ?? "";
  const { signal, release } = upstreamSignal(request.signal, UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamUrl = readProxyToken(token);
    const range = request.headers.get("range");
    const response = await fetch(upstreamUrl, {
      headers: range ? { Range: range } : undefined,
      cache: "no-store",
      redirect: "error",
      signal,
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
    // Zero-buffer pass-through. The upstream body stream is handed to the
    // response as-is: no `arrayBuffer()`, no `text()`, no chunk accumulation,
    // no string concatenation. A 4-8 MB segment is therefore never resident
    // here as a JS value -- it is relayed chunk by chunk under backpressure,
    // which is what keeps this route's footprint flat regardless of bitrate.
    //
    // The `cancelBodyOnAbort` wrapper is what ties the socket to the tab:
    // without it the fetch has already resolved by this point, so the client
    // going away cannot reach the upstream connection at all.
    return new Response(cancelBodyOnAbort(response.body, request.signal), {
      status: response.status,
      headers,
    });
  } catch (error) {
    if (error instanceof RequestInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[stream.segment] Authorized segment request failed.", error);
    return NextResponse.json(
      { error: "The media segment could not be loaded." },
      { status: 502 }
    );
  } finally {
    // Detaches the client-abort listener and clears the deadline timer on every
    // path, including the error paths. Leaving either attached retains a closure
    // over the request for as long as the process lives.
    release();
  }
}