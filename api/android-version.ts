/**
 * The Android self-update manifest, served same-origin.
 *
 * The APK workflow publishes `android-version.json` next to the APK on the
 * rolling `android-latest` GitHub release. The app could read that asset
 * directly, but the download host is cross-origin and its CORS behaviour is
 * not something an updater should depend on. This route reads it server-side,
 * adds CORS, and caches the answer at the edge so the update check is one small
 * same-origin request.
 */

export const config = { runtime: "edge" };

const MANIFEST_URL =
  "https://github.com/Lenium-Inc/lenium-movies/releases/download/android-latest/android-version.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
};

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const upstream = await fetch(MANIFEST_URL, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });

    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: "manifest unavailable" }), {
        status: 404,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const manifest = await upstream.text();
    return new Response(manifest, {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "manifest unavailable" }), {
      status: 404,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}
