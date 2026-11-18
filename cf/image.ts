/**
 * On-demand image route for Cloudflare Workers.
 *
 * Same contract as `api/image.ts`, minus the resize. Cloudflare's Worker
 * runtime has no `sharp` (it is a native Node addon), and Cloudflare Image
 * Resizing is a zone-level paid feature, so this route does what it can on any
 * plan:
 *
 * - TMDB posters are redirected to the rendition TMDB already exposes. That is
 *   the common case and needs no server work at all.
 * - Any other allowlisted artwork host is streamed through with long-lived
 *   caching. The bytes are not re-encoded, so the caller's `w`/`f` are honoured
 *   only by the browser cache, but the response is a correct, cacheable image
 *   rather than a broken tile.
 *
 * Everything else — the host allowlist as an SSRF boundary, the query shape, the
 * cache headers — matches the Node route.
 */

const ALLOWED_HOST = /(^|\.)aoneroom\.com$/i;
const TMDB_HOST = "image.tmdb.org";
const TMDB_SIZES = [92, 154, 185, 342, 500, 780, 1280];
const CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, stale-while-revalidate=86400, immutable";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function clampWidth(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 500;
  return Math.min(2048, Math.max(64, Math.round(parsed)));
}

function tmdbSize(width: number): number {
  return (
    TMDB_SIZES.find(size => size >= width) ?? TMDB_SIZES[TMDB_SIZES.length - 1]
  );
}

function text(
  body: string,
  status: number,
  extra: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...CORS,
      ...extra,
    },
  });
}

export async function handleImage(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("url");
  if (!raw)
    return text("Missing image url", 400, { "Cache-Control": "no-store" });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return text("Invalid image url", 400, { "Cache-Control": "no-store" });
  }

  const isAllowedHost =
    ALLOWED_HOST.test(target.hostname) || target.hostname === TMDB_HOST;
  if (target.protocol !== "https:" || !isAllowedHost) {
    return text("Image host not allowed", 403, { "Cache-Control": "no-store" });
  }

  if (target.hostname === TMDB_HOST) {
    const size = tmdbSize(clampWidth(url.searchParams.get("w")));
    const redirected = target.href.replace(
      /\/t\/p\/[a-z0-9_]+/i,
      `/t/p/w${size}`
    );
    return new Response(null, {
      status: 307,
      headers: {
        ...CORS,
        Location: redirected,
        "Cache-Control": CACHE_CONTROL,
        Vary: "Accept",
      },
    });
  }

  // One retry covers the transient upstream resets seen when a grid asks for
  // eighteen posters at once. A 4xx will not improve on retry; a 5xx might.
  let upstream: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      upstream = await fetch(target.href, {
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          "User-Agent": "StreamVy/1.0 (+https://streamvy.me)",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      if (attempt === 0) continue;
      return text("Image fetch failed", 502, { "Cache-Control": "no-store" });
    }
    if (upstream.ok || upstream.status < 500) break;
  }

  const contentType = upstream?.headers.get("content-type") ?? "";
  if (!upstream?.ok || !contentType.startsWith("image/")) {
    return text("Image not found", 404, { "Cache-Control": "no-store" });
  }

  const headers = new Headers({
    ...CORS,
    "Content-Type": contentType,
    "Cache-Control": CACHE_CONTROL,
    Vary: "Accept",
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);

  return new Response(upstream.body, { status: 200, headers });
}
