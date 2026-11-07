import sharp from "sharp";

/**
 * On-demand image optimisation for the catalogue.
 *
 * The MovieBox CDN serves one rendition per asset and its posters are often
 * 3840px / multi-megabyte files, even when a card paints them into a 191px
 * slot. The app therefore asks this route for a small WebP/AVIF version and
 * this route is the only place that pays for the downscale. The answer is
 * immutable and content-addressed by the source URL + width, so the Vercel CDN
 * serves every later viewer without waking the function.
 *
 * TMDB URLs are not proxied at all: they already expose a width segment, so
 * this route answers with a redirect to the correct rendition and lets the
 * browser talk to image.tmdb.org directly.
 *
 * Only artwork hosts are allowed. Accepting a caller-supplied URL that is
 * fetched server-side is an SSRF primitive, so the allowlist is the security
 * boundary rather than a convenience.
 */

const ALLOWED_HOST = /(^|\.)aoneroom\.com$/i;
const TMDB_HOST = "image.tmdb.org";
const TMDB_SIZES = [92, 154, 185, 342, 500, 780, 1280];
const CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, stale-while-revalidate=86400, immutable";

type NodeResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): NodeResponse;
  send(body: Buffer | string): void;
  end(): void;
};

type HandlerRequest = {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined> & {
    get?: (name: string) => string | null;
  };
};

function header(req: HandlerRequest, name: string): string {
  const value = req.headers?.[name] ?? req.headers?.get?.(name);
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : "";
}

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

function respond(
  res: NodeResponse | undefined,
  status: number,
  body: Buffer | string,
  headers: Record<string, string>
): Response | void {
  if (res && typeof res.status === "function") {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    res.status(status).send(body);
    return;
  }
  return new Response(
    typeof body === "string" ? body : new Uint8Array(body),
    { status, headers }
  );
}

export default async function handler(
  req: HandlerRequest,
  res?: NodeResponse
): Promise<Response | void> {
  const url = new URL(req.url ?? "", "https://streamvy.local");
  const allowOrigin = { "Access-Control-Allow-Origin": "*" };

  if (req.method === "OPTIONS") {
    return respond(res, 204, "", { ...allowOrigin, "Access-Control-Allow-Methods": "GET, OPTIONS" });
  }

  const raw = url.searchParams.get("url");
  if (!raw) {
    return respond(res, 400, "Missing image url", { ...allowOrigin, "Cache-Control": "no-store" });
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return respond(res, 400, "Invalid image url", { ...allowOrigin, "Cache-Control": "no-store" });
  }

  const isAllowedHost =
    ALLOWED_HOST.test(target.hostname) || target.hostname === TMDB_HOST;
  if (target.protocol !== "https:" || !isAllowedHost) {
    return respond(res, 403, "Image host not allowed", {
      ...allowOrigin,
      "Cache-Control": "no-store",
    });
  }

  const width = clampWidth(url.searchParams.get("w"));
  // An explicit `f` wins: the app asks for WebP on purpose (it encodes much
  // faster than AVIF at these sizes), so a browser's `Accept` header must not
  // silently turn every tile into a slower AVIF transcode.
  const requestedFormat = url.searchParams.get("f");
  const wantsAvif = requestedFormat
    ? requestedFormat === "avif"
    : header(req, "accept").includes("image/avif");
  const format = wantsAvif ? "avif" : "webp";
  const quality = Math.min(90, Math.max(40, Number(url.searchParams.get("q")) || 72));

  if (target.hostname === TMDB_HOST) {
    const size = tmdbSize(width);
    const redirected = target.href.replace(
      /\/t\/p\/[a-z0-9_]+/i,
      `/t/p/w${size}`
    );
    return respond(res, 307, "", {
      ...allowOrigin,
      Location: redirected,
      "Cache-Control": CACHE_CONTROL,
    });
  }

  // One retry covers the transient upstream resets that showed up when the
  // grid asked for 18 posters at once. Reading the body is inside the same
  // guard: `arrayBuffer()` rejects on a mid-stream reset, and an unhandled
  // rejection here is a 500, not a retryable 502.
  let input: Buffer;
  let contentType: string;
  try {
    let upstream: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        upstream = await fetch(target.href, {
          headers: {
            Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
            "User-Agent": "StreamVy/1.0 (+https://streamvy.me)",
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // A reset throws rather than returning 5xx; retry it once too.
        if (attempt === 0) continue;
        throw new Error("image fetch failed");
      }
      // A 4xx will not improve on retry; a 5xx might.
      if (upstream.ok || upstream.status < 500) break;
    }

    contentType = upstream?.headers.get("content-type") ?? "";
    if (!upstream?.ok || !contentType.startsWith("image/")) {
      return respond(res, 404, "Image not found", {
        ...allowOrigin,
        "Cache-Control": "no-store",
      });
    }

    input = Buffer.from(await upstream.arrayBuffer());
  } catch {
    return respond(res, 502, "Image fetch failed", {
      ...allowOrigin,
      "Cache-Control": "no-store",
    });
  }

  try {
    const pipeline = sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width, withoutEnlargement: true });
    const output =
      format === "avif"
        ? await pipeline.avif({ quality, effort: 4 }).toBuffer()
        : await pipeline.webp({ quality, effort: 4 }).toBuffer();

    return respond(res, 200, output, {
      ...allowOrigin,
      "Content-Type": `image/${format}`,
      "Cache-Control": CACHE_CONTROL,
      Vary: "Accept",
    });
  } catch {
    // A format sharp cannot decode (an odd SVG, a truncated body) still reaches
    // the viewer as the original bytes rather than as a broken tile.
    return respond(res, 200, input, {
      ...allowOrigin,
      "Content-Type": contentType,
      "Cache-Control": CACHE_CONTROL,
    });
  }
}
