/**
 * Trailer lookup for the title page.
 *
 * The catalogue carries neither a TMDB id nor a playable trailer, so this route
 * asks TMDB directly: a `title`/`year` search (or a numeric `id`) is resolved to
 * a TMDB record, then its `videos` sub-resource is ranked for a YouTube trailer.
 * The API key stays server-side and the answer is cached at the edge, so the
 * client makes one small same-origin request per title.
 */

export const config = { runtime: "edge" };

const TMDB_BASE = "https://api.themoviedb.org/3";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Accept",
};

type TmdbVideo = {
  key?: string;
  name?: string;
  site?: string;
  type?: string;
  official?: boolean;
  iso_639_1?: string;
};

type TmdbSearchResult = {
  id?: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Cache-Control":
        status === 200
          ? "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800"
          : "no-store",
    },
  });
}

function norm(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function yearOf(result: TmdbSearchResult): string {
  return (result.release_date || result.first_air_date || "").slice(0, 4);
}

/**
 * Best available trailer, not merely the first video.
 *
 * TMDB lists clips, featurettes, teasers and trailers in arbitrary order. An
 * official trailer in the requested language is the one a viewer expects; a
 * teaser is an acceptable fallback; anything else (a clip, a bloopers reel) is
 * not what the button promises.
 */
function pickTrailer(videos: TmdbVideo[]): TmdbVideo | null {
  const playable = videos.filter(
    video =>
      video.site === "YouTube" &&
      typeof video.key === "string" &&
      (video.type === "Trailer" || video.type === "Teaser")
  );
  const rank = (video: TmdbVideo, index: number) => {
    let score = 0;
    if (video.type === "Trailer") score -= 4;
    if (video.official) score -= 2;
    if (video.iso_639_1 === "en") score -= 1;
    return score + index / 100;
  };
  return (
    playable
      .map((video, index) => ({ video, index }))
      .sort((a, b) => rank(a.video, a.index) - rank(b.video, b.index))[0]
      ?.video ?? null
  );
}

async function fetchVideos(id: string, type: "movie" | "tv", key: string) {
  const response = await fetch(
    `${TMDB_BASE}/${type}/${id}/videos?api_key=${encodeURIComponent(key)}&language=en-US`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as { results?: TmdbVideo[] };
  return payload.results ?? [];
}

async function searchId(
  title: string,
  year: string,
  type: "movie" | "tv",
  key: string
): Promise<string | null> {
  const query = new URLSearchParams({
    api_key: key,
    query: title,
    language: "en-US",
  });
  if (year) {
    query.set(type === "tv" ? "first_air_date_year" : "year", year);
  }
  const response = await fetch(
    `${TMDB_BASE}/search/${type}?${query.toString()}`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!response.ok) return null;
  const payload = (await response.json()) as { results?: TmdbSearchResult[] };
  const results = (payload.results ?? []).filter(
    result => typeof result.id === "number"
  );
  const wanted = norm(title);
  const exact = results.find(
    result =>
      norm(result.title ?? result.name) === wanted &&
      (!year || yearOf(result) === year)
  );
  const sameName = results.find(
    result => norm(result.title ?? result.name) === wanted
  );
  const chosen = exact ?? sameName ?? results[0];
  return chosen?.id ? String(chosen.id) : null;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const params = new URL(request.url).searchParams;
  const type = params.get("type") === "tv" ? "tv" : "movie";
  const idParam = (params.get("id") ?? "").trim();
  const title = (params.get("title") ?? "").trim();
  const year = (params.get("year") ?? "").trim();

  let id = /^\d+$/.test(idParam) ? idParam : null;
  if (!id && !title) {
    return json({ trailer: null });
  }

  const key = process.env.TMDB_API_KEY;
  if (!key) {
    return json({ error: "trailer service unavailable" }, 503);
  }

  try {
    if (!id) {
      id = await searchId(title, year, type, key);
      if (!id) return json({ trailer: null });
    }

    const videos = await fetchVideos(id, type, key);
    const chosen = pickTrailer(videos);
    if (!chosen?.key) return json({ trailer: null });

    return json({
      trailer: {
        provider: "youtube",
        id: chosen.key,
        title: chosen.name?.trim() || "Official trailer",
        embed_url: `https://www.youtube-nocookie.com/embed/${chosen.key}`,
        thumb_url: `https://i.ytimg.com/vi/${chosen.key}/hqdefault.jpg`,
      },
    });
  } catch {
    // TMDB being slow or rate-limited is "no trailer" for the viewer, not an
    // error the title page should surface.
    return json({ trailer: null });
  }
}
