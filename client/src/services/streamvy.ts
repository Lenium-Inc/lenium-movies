/**
 * Transport, wire shapes and the video proxy for the headless Streamvy API.
 *
 * Why this file exists
 * --------------------
 * The app used to talk to one Flask service that answered search, metadata,
 * feeds, playback and image proxying from a single origin. The service that
 * serves the catalogue now is a different, headless one: ten read-only
 * endpoints, no auth, no image relay, and every media leg handed back as a raw
 * third-party URL. Keeping that inside `services/api.ts` would have meant a
 * 1600-line file with two base URLs and two error vocabularies in it, so the
 * raw half lives here and `api.ts` keeps the app's own types and mappers.
 *
 * The rule this module holds: **one place knows where the media API is, and
 * one place knows how a media URL becomes playable.**
 */

import { parseSubtitleFile } from "@/lib/subtitleFile";

/**
 * An HTTP-level failure from the media API, carrying the status code.
 *
 * Callers need to tell a rate limit (429) apart from a genuine outage, and
 * matching on message text is not a distinction -- it is a coin flip that
 * changes when someone rewords an error string.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, context: string) {
    super(`${context} failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

/** True when the backend refused because we exceeded its rate limit. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

/**
 * True when `value` is a Streamvy subject id the rest of the app can use.
 *
 * Subject ids are ~19-digit integers, so they land well above `2**53` and lose
 * precision the moment they pass through `Number`. Anything that treats one as
 * a number -- a route param, a dedupe key, a provider id -- therefore has to
 * keep it as a string, and the first defence is refusing the shapes that are
 * obviously not one.
 *
 * The digit floor also does useful work for `/search/suggest`, which returns
 * the literal string `"None"` in this field: it is dropped rather than woven
 * into a link that resolves to nothing.
 */
export function isUsableSubjectId(value: unknown): value is string {
  return typeof value === "string" && /^\d{12,}$/.test(value.trim());
}

/**
 * The media API's origin.
 *
 * Resolution order:
 *
 * 1. `VITE_STREAMVY_API_BASE_URL` -- the media API's own variable, so the
 *    catalogue and the account service can be pointed at different hosts.
 * 2. `https://streamvy-api.onrender.com` -- the deployed headless API. It is a
 *    hardcoded *product* origin rather than someone's token, so shipping it by
 *    default is safe; a build that never configures the variable still has a
 *    catalogue rather than a blank page.
 *
 * Trailing slashes are stripped so `streamvyUrl("/search")` never produces a
 * double-slash path.
 */
const DEFAULT_STREAMVY_ORIGIN = "https://streamvy-api.onrender.com";

const CONFIGURED_STREAMVY_ORIGIN = (
  import.meta.env.VITE_STREAMVY_API_BASE_URL || ""
).trim();

export const STREAMVY_API_BASE_URL = (
  CONFIGURED_STREAMVY_ORIGIN || DEFAULT_STREAMVY_ORIGIN
).replace(/\/+$/, "");

/**
 * True when this build carries no configured media origin and is therefore
 * talking to the hardcoded default above. Reported rather than logged, for the
 * same reason `MOVIE_API_BASE_URL` reports rather than logs.
 */
export const USING_FALLBACK_STREAMVY_ORIGIN = !CONFIGURED_STREAMVY_ORIGIN;

/** Build a full URL against the media API origin. */
export function streamvyUrl(path: string): string {
  return `${STREAMVY_API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * How long a single media-API call may take before it is aborted.
 *
 * The catalog endpoints answer in well under a second on a warm instance, but
 * this is a Render free-tier service that scales to zero: a cold start eats
 * 15-20s before the request reaches the app at all. 25s clears boot with room
 * to spare while still bounding a genuinely hung request.
 */
export const STREAMVY_TIMEOUT_MS = 25_000;

/** Attempts after the first for a call the server throttled. */
const RATE_LIMIT_RETRIES = 2;

const RATE_LIMIT_BASE_DELAY_MS = 750;

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface StreamvyGetOptions {
  params?: Record<string, string | number | undefined | null>;
  timeoutMs?: number;
  /** Label used in the thrown error's message. Defaults to the path. */
  context?: string;
}

function buildQuery(
  params: StreamvyGetOptions["params"]
): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * One GET against the media API.
 *
 * Retries a 429 with the server's own `Retry-After` when it sent one: the
 * service rate-limits per IP, and a fixed backoff that lands inside a single
 * empty window re-429s every attempt while accruing the abuse score the limiter
 * exists to protect. The body is read as text before it is parsed so a proxy's
 * HTML error page surfaces as a status error rather than as a JSON parse
 * failure that no classifier can reason about.
 */
async function streamvyGet<T>(
  path: string,
  options: StreamvyGetOptions = {}
): Promise<T> {
  const url = `${streamvyUrl(path)}${buildQuery(options.params)}`;
  const timeoutMs = options.timeoutMs ?? STREAMVY_TIMEOUT_MS;
  const context = options.context ?? path;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`${context} did not respond within ${timeoutMs / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await sleep(retryAfterMs(response) ?? RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new ApiError(response.status, context);

    const raw = await response.text();
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`${context} responded with status ${response.status} and a non-JSON body`);
    }
  }
}

// ---------------------------------------------------------------------------
// Wire shapes. Every field is optional-tolerant on read: these are the shapes
// the API answers today, and a missing optional must degrade to absent rather
// than throw on a title that simply has no rating.
// ---------------------------------------------------------------------------

export interface StreamvySearchResult {
  subject_id: string;
  title: string;
  /** `Movie` | `Series` | ... */
  type?: string;
  /** 1 = film, 2 = series. */
  subject_type?: number;
  release_date?: string;
  imdb_rating?: string;
  /** Comma-joined genre labels, e.g. `"Action,Crime,Thriller"`. */
  genre?: string;
  /** Absolute poster URL (portrait). */
  cover?: string;
  detail_path?: string | null;
  language?: string;
}

export interface StreamvySearchPage {
  query?: string;
  page?: number;
  results: StreamvySearchResult[];
}

export interface StreamvyDetail {
  subject_id: string;
  title: string;
  subject_type?: number;
  type?: string;
  description?: string;
  release_date?: string;
  /** Human runtime, e.g. `"2h 6m"`. */
  duration?: string;
  imdb_rating?: string;
  genre?: string;
  country?: string;
  language?: string;
  cover?: string;
  detail_path?: string;
  dubs?: { subject_id?: string; lang_name?: string; language?: string }[];
}

export interface StreamvySeasonBlock {
  season: number;
  episode_count: number;
  resolutions?: { resolution?: string; epNum?: number }[];
}

export interface StreamvyEpisodes {
  subject_id: string;
  seasons: StreamvySeasonBlock[];
}

export interface StreamvyStream {
  source?: string;
  /** `"MP4"` | `"DASH"` | ... */
  format?: string;
  quality?: string;
  quality_value?: number;
  resolution_tag?: string;
  url: string;
  size_mb?: number;
  codec?: string;
  duration_sec?: number | null;
  cookie?: string;
  headers?: Record<string, string>;
}

export interface StreamvyStreamPayload {
  subject_id: string;
  season?: number;
  episode?: number;
  count?: number;
  streams: StreamvyStream[];
}

export interface StreamvyCaption {
  id?: string;
  language?: string;
  code?: string;
  url: string;
  size?: number;
}

export interface StreamvyCaptionPayload {
  subject_id: string;
  season?: number;
  episode?: number;
  count?: number;
  captions: StreamvyCaption[];
}

/** A catalogue item as `/movies` and `/tv-series` answer it. */
export interface StreamvyCatalogItem {
  title: string;
  subject_id: string;
  detail_path?: string;
  cover?: string;
  rating?: number | string;
  year?: number | string;
}

export interface StreamvyCatalogPage {
  page: number;
  per_page: number;
  total: number;
  items: StreamvyCatalogItem[];
}

/**
 * One artwork-bearing subject as `/home` hands it over.
 *
 * `/home` is the only endpoint that carries landscape art (the banner images
 * and trailer posters) and a real synopsis, which is why the home feed maps
 * from this rather than from the flatter `/search` row.
 */
export interface StreamvyHomeSubject {
  /**
   * `/home` is the one payload the API answers in camelCase -- every other
   * endpoint is snake_case. That asymmetry is the API's, not a typo here.
   */
  subjectId: string;
  /** 1 = film, 2 = series. */
  subjectType?: number;
  title: string;
  description?: string;
  /** ISO date, e.g. `"2017-10-03"`. */
  releaseDate?: string;
  /** Seconds; 0 when the API does not know. */
  duration?: number;
  /** Comma-joined labels, e.g. `"Anime,Action,Adventure"`. */
  genre?: string;
  cover?: { url?: string; width?: number; height?: number } | string;
  /** Landscape stills. Present in the schema but empty in every response. */
  stills?: { url?: string } | string | null;
  countryName?: string;
  /** Stringly-typed, e.g. `"7.1"`. */
  imdbRatingValue?: string | number;
  /** Drives the popularity proxy used by the Top-10 shelves. */
  imdbRatingCount?: number;
  detailPath?: string;
  hasResource?: boolean;
  /**
   * A native MP4 trailer, hosted on `macdn.aoneroom.com` -- the one CDN the
   * API's proxy can actually relay. This is the trailer path the app prefers,
   * because a `<video>` element needs no embed origin, no iframe handshake and
   * no CSP allowance the way a YouTube link would.
   */
  trailer?: {
    videoAddress?: { url?: string; duration?: number; width?: number; height?: number };
    cover?: { url?: string };
  } | null;
}

export interface StreamvyBannerItem {
  id?: string;
  title?: string;
  /** Landscape hero artwork. */
  image?: string;
  subjectId?: string;
  subjectType?: number;
  subject?: StreamvyHomeSubject;
}

export interface StreamvyHomeBlock {
  type?: string;
  position?: number;
  title?: string;
  subjects?: StreamvyHomeSubject[];
  banner?: { items?: StreamvyBannerItem[] };
}

export interface StreamvyHomePayload {
  data?: { operatingList?: StreamvyHomeBlock[] };
}

// ---------------------------------------------------------------------------
// Raw endpoint calls.
// ---------------------------------------------------------------------------

/** `GET /search`. */
export function streamvySearch(
  query: string,
  opts: { page?: number; perPage?: number } = {}
): Promise<StreamvySearchPage> {
  return streamvyGet<StreamvySearchPage>("/search", {
    params: {
      q: query,
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 24,
    },
    context: "Search",
  });
}

/** `GET /detail/{subject_id}`. */
export function streamvyDetail(subjectId: string): Promise<StreamvyDetail> {
  return streamvyGet<StreamvyDetail>(`/detail/${encodeURIComponent(subjectId)}`, {
    context: "Detail",
  });
}

/** `GET /episodes/{subject_id}` -- season and episode *counts*, not records. */
export function streamvyEpisodes(subjectId: string): Promise<StreamvyEpisodes> {
  return streamvyGet<StreamvyEpisodes>(`/episodes/${encodeURIComponent(subjectId)}`, {
    context: "Episodes",
  });
}

/**
 * How long a resolved `/api/stream` answer is reused.
 *
 * The player asks for this endpoint more than once per playback: a stall
 * handler retries, a quality switch re-resolves, and the download menu re-reads
 * the ladder. The URL set for a given (subject, season, episode) is not
 * volatile, so re-answering those calls spends rate limit to learn nothing.
 */
const STREAM_CACHE_TTL_MS = 60_000;

const streamCache = new Map<string, { at: number; promise: Promise<StreamvyStreamPayload> }>();

/**
 * `GET /api/stream/{subject_id}`.
 *
 * Movies address the endpoint with `se=0&ep=0`; a series carries the real
 * season and episode. Omitting both is what the API treats as the default, so
 * an untargeted resolve still answers rather than 422-ing.
 *
 * Cached for {@link STREAM_CACHE_TTL_MS} per (subject, season, episode), and
 * shared across concurrent callers -- the stall watcher and a user-initiated
 * retry routinely land in the same tick.
 */
export function streamvyStreams(
  subjectId: string,
  opts: { season?: number; episode?: number; force?: boolean } = {}
): Promise<StreamvyStreamPayload> {
  const key = `${subjectId}|${opts.season ?? ""}|${opts.episode ?? ""}`;
  const cached = streamCache.get(key);
  const now = Date.now();
  if (!opts.force && cached && now - cached.at < STREAM_CACHE_TTL_MS) {
    return cached.promise;
  }

  const params: Record<string, string | number | undefined> = {};
  if (opts.season != null) params.se = opts.season;
  if (opts.episode != null) params.ep = opts.episode;
  const promise = streamvyGet<StreamvyStreamPayload>(
    `/api/stream/${encodeURIComponent(subjectId)}`,
    { params, context: "Stream" }
  ).then(payload => ({ ...payload, streams: [...(payload.streams ?? [])] }));

  streamCache.set(key, { at: now, promise });
  // A failure must not be replayed from cache: the caller may be retrying
  // because the instance just woke up, and pinning the rejection for a minute
  // would turn a transient outage into a one-minute one.
  promise.catch(() => streamCache.delete(key));
  return promise;
}

/** `GET /home`. */
export function streamvyHome(): Promise<StreamvyHomePayload> {
  return streamvyGet<StreamvyHomePayload>("/home", { context: "Home" });
}

/** `GET /movies` or `GET /tv-series`. */
export function streamvyCatalog(
  kind: "movies" | "tv-series",
  opts: { page?: number; perPage?: number; sort?: string } = {}
): Promise<StreamvyCatalogPage> {
  return streamvyGet<StreamvyCatalogPage>(`/${kind}`, {
    params: {
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 24,
      sort: opts.sort,
    },
    context: kind === "movies" ? "Movies" : "TV series",
  });
}

// ---------------------------------------------------------------------------
// The video proxy.
// ---------------------------------------------------------------------------

/** The proxy route that relays a media URL back through the API origin. */
export const VIDEO_PROXY_PATH = "/api/proxy/video";

/** Schemes that must never be wrapped: a blob is ours, `data:` is inline. */
const PASSTHROUGH_SCHEME = /^(blob|data):/i;

/**
 * True when `url` is already one of our video-proxy handles.
 *
 * Checked by *path*, not by prefix, so it stays true however the origin was
 * configured -- and it is what makes wrapping idempotent. Without it a source
 * that round-trips through this function twice would be nested inside the proxy
 * twice, and the proxy would then be asked to relay itself.
 */
export function isProxiedVideoUrl(url: string): boolean {
  try {
    return new URL(url, "https://url.invalid").pathname === VIDEO_PROXY_PATH;
  } catch {
    return false;
  }
}

/**
 * The upstream URL a proxy handle carries, or null when there is none.
 *
 * Format sniffing has to run against *this*, not against the handle: every
 * proxied URL ends in `/api/proxy/video` and so looks like an unrecognised
 * path, which would rank every rendition as a last-resort unknown and feed
 * `.mpd` playlists to `<video src>`.
 */
export function proxiedVideoTarget(url: string): string | null {
  if (!isProxiedVideoUrl(url)) return null;
  try {
    const inner = new URL(url, "https://url.invalid").searchParams.get("url");
    return inner && inner.trim() ? inner : null;
  } catch {
    return null;
  }
}

/**
 * The same-origin URL a `<video>`, `<audio>` or `<track>` should load.
 *
 * Raw CDN URLs are refused by the browser before a byte is read: the media
 * hosts send no `Access-Control-Allow-Origin`, and several of them refuse a
 * request whose `Referer` is not their own -- which a cross-origin media
 * element cannot set, because the browser owns that header. The API's proxy
 * exists for exactly this: it fetches upstream with the referer the title
 * needs and answers with CORS headers the browser accepts.
 *
 * Everything is proxied rather than host-matched. An allowlist would be a
 * second, drifting source of truth about which origins behave, and a host
 * added to the catalogue tomorrow would silently play (or silently not) based
 * on whether someone remembered to edit a list here.
 *
 * Idempotent, and a no-op for handles the app already owns: a relative path
 * stays relative, and `blob:`/`data:` URLs are this document's own bytes.
 */
export function proxiedVideoUrl(url: string, referer?: string | null): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return "";
  if (PASSTHROUGH_SCHEME.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  if (isProxiedVideoUrl(trimmed)) return trimmed;

  let absolute = trimmed;
  if (!/^https?:\/\//i.test(trimmed)) {
    // Not a scheme we recognise and not a handle -- leave it alone rather than
    // hand the proxy a string it cannot parse.
    try {
      absolute = new URL(trimmed, "https://url.invalid").toString();
    } catch {
      return trimmed;
    }
  }

  const params = new URLSearchParams({ url: absolute });
  const cleanReferer = typeof referer === "string" ? referer.trim() : "";
  if (cleanReferer) params.set("referer", cleanReferer);
  return `${streamvyUrl(VIDEO_PROXY_PATH)}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Captions.
// ---------------------------------------------------------------------------

/**
 * How many caption tracks are converted per playback.
 *
 * A title can ship a dozen languages. Converting all of them means a dozen
 * extra round trips against a rate-limited host on behalf of a menu that
 * realistically gets one selection, so the list is ordered by how likely the
 * language is to be chosen and cut. The caption *list* is still one request;
 * only the conversion is capped.
 */
const MAX_CAPTION_TRACKS = 5;

/** Languages first, then the rest in the order the API returned them. */
function prioritizeCaptions(captions: StreamvyCaption[]): StreamvyCaption[] {
  const rank = (caption: StreamvyCaption): number => {
    const code = (caption.code || caption.language || "").toLowerCase();
    if (code === "en" || code.startsWith("en-")) return 0;
    if (code === "") return 2;
    return 1;
  };
  return captions
    .map((caption, index) => ({ caption, index }))
    .sort((a, b) => rank(a.caption) - rank(b.caption) || a.index - b.index)
    .map(entry => entry.caption);
}

function captionLang(caption: StreamvyCaption): string {
  return (caption.code || caption.language || "").trim();
}

/**
 * Load this playback's caption tracks as WebVTT the browser will actually
 * parse.
 *
 * The API serves `.srt`. A `<track>` element accepts WebVTT only -- an SRT
 * src is a silent failure, not an error, so the viewer watches believing
 * subtitles were offered. Each file is therefore pulled through the same video
 * proxy (which carries the CORS header the CDN does not) and converted here.
 *
 * Entirely fail-soft: a caption is decoration, and one that cannot be fetched
 * or read is dropped rather than failing the playback it rode in on.
 */
export async function loadCaptionTracks(
  subjectId: string,
  opts: { season?: number; episode?: number } = {}
): Promise<{ label: string; lang: string; url: string }[]> {
  let payload: StreamvyCaptionPayload;
  try {
    const params: Record<string, string | number | undefined> = {};
    if (opts.season != null) params.se = opts.season;
    if (opts.episode != null) params.ep = opts.episode;
    payload = await streamvyGet<StreamvyCaptionPayload>(
      `/api/stream/${encodeURIComponent(subjectId)}/captions`,
      { params, context: "Captions", timeoutMs: 15_000 }
    );
  } catch {
    return [];
  }
  if (!Array.isArray(payload?.captions)) return [];

  const chosen = prioritizeCaptions(payload.captions)
    .filter(caption => typeof caption?.url === "string" && caption.url.trim())
    .slice(0, MAX_CAPTION_TRACKS);

  const tracks = await Promise.all(
    chosen.map(async caption => {
      const lang = captionLang(caption);
      if (!lang) return null;
      try {
        const response = await fetch(proxiedVideoUrl(caption.url));
        if (!response.ok) return null;
        const text = await response.text();
        const parsed = parseSubtitleFile(`${lang}.srt`, text);
        if (!parsed.ok) return null;
        const blob = new Blob([parsed.vtt], { type: "text/vtt" });
        return {
          label: caption.language?.trim() || lang,
          lang,
          url: URL.createObjectURL(blob),
        };
      } catch {
        return null;
      }
    })
  );

  return tracks.filter(
    (track): track is { label: string; lang: string; url: string } => track !== null
  );
}
