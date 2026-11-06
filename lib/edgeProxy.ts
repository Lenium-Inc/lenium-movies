const MEDIA_REFERER = "https://moviebox.ph/";
const MEDIA_ORIGIN = "https://moviebox.ph";
const MEDIA_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ALLOWED_HOST_SUFFIXES = [
  "hakunaymatata.com",
  "aoneroom.com",
  "moviebox.ph",
  "akamaized.net",
  "cloudfront.net",
  "fastly.net",
];

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers":
    "Range, If-Range, If-None-Match, If-Modified-Since",
  "access-control-expose-headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified",
  "access-control-max-age": "86400",
};

const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function allowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host === "[::1]") return false;
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

function safeFilename(value: string | null, target: string): string {
  const raw = (value || "").trim();
  const candidate =
    raw ||
    decodeURIComponent(new URL(target).pathname.split("/").pop() || "") ||
    "download";
  const cleaned = candidate
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "download";
}

export async function proxyMedia(
  request: Request,
  download: boolean
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ detail: "Method not allowed" }, 405);
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return json({ detail: "Missing url parameter" }, 400);

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(target);
  } catch {
    return json({ detail: "Invalid url parameter" }, 400);
  }

  if (upstreamUrl.protocol !== "https:") {
    return json({ detail: "Only https media URLs are allowed" }, 400);
  }
  if (!allowedHost(upstreamUrl.hostname)) {
    return json({ detail: "Media host is not allowed" }, 400);
  }

  const headers = new Headers({
    Referer: MEDIA_REFERER,
    Origin: MEDIA_ORIGIN,
    "User-Agent": MEDIA_USER_AGENT,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  });

  for (const name of [
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown error";
    return json({ detail: `Upstream fetch failed: ${message}` }, 502);
  }

  if (!upstream.ok && upstream.status !== 206) {
    const text = await upstream.text().catch(() => "");
    return json(
      {
        detail: `Upstream error ${upstream.status}: ${
          text.slice(0, 200) || upstream.statusText
        }`,
      },
      502
    );
  }

  const responseHeaders = new Headers(CORS_HEADERS);
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  if (download) {
    const filename = safeFilename(url.searchParams.get("filename"), target);
    responseHeaders.set(
      "content-disposition",
      `attachment; filename="${filename}"`
    );
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
