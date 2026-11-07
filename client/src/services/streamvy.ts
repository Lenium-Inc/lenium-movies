/**
 * Transport and wire shapes for the deployed Streamvy catalogue API
 * (`https://movie-api.streamvy.me`, the FastAPI app in the Streamvy_API repo).
 *
 * Why this file exists
 * --------------------
 * The app used to talk to one Flask service that answered search, metadata,
 * feeds, playback and image proxying from a single origin. The catalogue now
 * comes from MovieBox through a small headless FastAPI layer with a different
 * vocabulary: slugs are the public handle, subject ids are 19-digit strings, and
 * every media leg is a signed third-party URL that only works when the request
 * carries the MovieBox referer. Keeping that inside `services/api.ts` would have
 * meant a 1600-line file with two error vocabularies in it, so the raw half
 * lives here and `api.ts` keeps the app's own types and mappers.
 *
 * The rule this module holds: **one place knows where the media API is, how a
 * slug becomes a detail record, and how a media URL becomes playable.**
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
 * True when `value` is a MovieBox subject id the stream endpoint can use.
 *
 * Subject ids are ~19-digit integers, so they land well above `2**53` and lose
 * precision the moment they pass through `Number`. Anything that treats one as
 * a number -- a route param, a dedupe key -- therefore has to keep it as a
 * string, and the first defence is refusing the shapes that are obviously not
 * one.
 */
export function isUsableSubjectId(value: unknown): value is string {
  return typeof value === "string" && /^\d{12,}$/.test(value.trim());
}

/**
 * The media API's origin.
 *
 * `VITE_STREAMVY_API_BASE_URL` is deliberately its own variable. The old
 * `VITE_API_BASE_URL` still exists in some deployments pointing at the retired
 * Flask/Render service, and inheriting it here is exactly how the app would keep
 * calling a backend the operator has moved off. A build that configures nothing
 * still gets the deployed product origin rather than a blank page.
 */
const DEFAULT_STREAMVY_ORIGIN = "https://movie-api.streamvy.me";

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
 * The origin that relays signed media URLs.
 *
 * The video CDN refuses Vercel's Python function egress, but the Vercel Edge
 * runtime reaches it, so playback and downloads go through the same-origin
 * `/api/proxy/*` routes by default.
 */
const DEFAULT_STREAMVY_PROXY_ORIGIN = "https://www.streamvy.me/api";

const CONFIGURED_STREAMVY_PROXY_ORIGIN = (
  import.meta.env.VITE_STREAMVY_PROXY_BASE_URL || ""
).trim();

export const STREAMVY_PROXY_BASE_URL = (
  CONFIGURED_STREAMVY_PROXY_ORIGIN || DEFAULT_STREAMVY_PROXY_ORIGIN
).replace(/\/+$/, "");

/** Build a full URL against the media relay origin. */
export function streamvyProxyUrl(path: string): string {
  return `${STREAMVY_PROXY_BASE_URL}${
    path.startsWith("/") ? path : `/${path}`
  }`;
}

/** How long a single catalogue/metadata call may take before it is aborted. */
export const STREAMVY_TIMEOUT_MS = 25_000;

/** How long a stream resolve may take. MovieBox answers this one in <2s warm. */
export const STREAMVY_STREAM_TIMEOUT_MS = 30_000;

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

function buildQuery(params: StreamvyGetOptions["params"]): string {
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
 * Retries a 429 with the server's own `Retry-After` when it sent one. The body
 * is read as text before it is parsed so a proxy's HTML error page surfaces as
 * a status error rather than as a JSON parse failure.
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
        throw new Error(`${context} timed out after ${timeoutMs / 1000}s`);
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
      throw new Error(
        `${context} responded with status ${response.status} and a non-JSON body`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Wire shapes. Every field is optional-tolerant on read: these are the shapes
// the API answers today, and a missing optional must degrade to absent rather
// than throw on a title that simply has no rating.
// ---------------------------------------------------------------------------

/** One card as `/home`, `/search` and the catalog routes answer it. */
export interface MovieBoxItem {
  name?: string | null;
  poster_url?: string | null;
  slug?: string | null;
  subject_id?: string | null;
  badge?: string | null;
  rating?: string | number | null;
  year?: string | number | null;
}

export interface MovieBoxHomeSection {
  section: string;
  count?: number;
  items: MovieBoxItem[];
}

export interface MovieBoxHome {
  status?: string;
  sections: MovieBoxHomeSection[];
}

export interface MovieBoxCover {
  url?: string | null;
  width?: number;
  height?: number;
}

export interface MovieBoxTrailer {
  videoAddress?: {
    url?: string | null;
    duration?: number;
    width?: number;
    height?: number;
  } | null;
  cover?: MovieBoxCover | null;
}

export interface MovieBoxDub {
  subjectId?: string;
  lanName?: string;
  lanCode?: string;
  original?: boolean;
  type?: number;
  detailPath?: string;
}

export interface MovieBoxSubject {
  subjectId: string;
  /** 1 = film, 2 = series. */
  subjectType?: number;
  title?: string;
  description?: string;
  releaseDate?: string;
  /** Seconds; 0 when the API does not know. */
  duration?: number;
  /** Comma-joined labels, e.g. `"Action,Crime,Thriller"`. */
  genre?: string;
  cover?: MovieBoxCover | null;
  /** Landscape artwork. */
  stills?: MovieBoxCover | string | null;
  countryName?: string;
  imdbRatingValue?: string | number;
  imdbRatingCount?: number;
  detailPath?: string;
  hasResource?: boolean;
  season?: number;
  corner?: string | null;
  trailer?: MovieBoxTrailer | null;
  dubs?: MovieBoxDub[];
  subtitles?: string;
}

export interface MovieBoxStar {
  staffId?: string;
  /** 1 = cast, 2 = crew (a director carries `character: "Director"`). */
  staffType?: number;
  name?: string;
  character?: string;
  avatarUrl?: string;
  detailPath?: string;
}

export interface MovieBoxSeasonBlock {
  se: number;
  maxEp: number;
  allEp?: string;
  resolutions?: { resolution?: string | number; epNum?: number }[];
}

export interface MovieBoxResource {
  seasons?: MovieBoxSeasonBlock[];
  source?: string;
  uploadBy?: string;
}

export interface MovieBoxDetail {
  subject: MovieBoxSubject;
  stars?: MovieBoxStar[];
  resource?: MovieBoxResource;
  metadata?: {
    title?: string;
    description?: string;
    image?: string | MovieBoxCover | null;
    keyWords?: string;
  };
  isForbid?: boolean;
  watchTimeLimit?: number;
  postList?: unknown;
  accessStrategy?: unknown;
}

export interface MovieBoxDetailEnvelope {
  code?: number;
  message?: string;
  data?: MovieBoxDetail;
}

export interface MovieBoxStreamSource {
  resolution?: string;
  format?: string;
  url?: string;
  size?: number | string;
  duration?: number | string;
  codec?: string;
}

export interface MovieBoxStreamPayload {
  subject_id: string;
  se?: number;
  ep?: number;
  has_resource?: boolean;
  sources?: MovieBoxStreamSource[];
  hls?: unknown[];
  dash?: unknown[];
  free_episodes?: number;
  limited?: boolean;
  note?: string | null;
}

export interface MovieBoxCaption {
  id?: string;
  /** Language code, e.g. `"en"`. */
  lan?: string;
  /** Display name, e.g. `"English"`. */
  lanName?: string;
  url?: string;
  size?: number;
}

export interface MovieBoxCaptionPayload {
  subject_id?: string;
  se?: number;
  ep?: number;
  count?: number;
  captions?: MovieBoxCaption[];
}

export interface MovieBoxCatalogPage {
  page?: number;
  per_page?: number;
  total?: number;
  items?: MovieBoxItem[];
}

export interface MovieBoxSearchPayload {
  query?: string;
  page?: number;
  total?: number;
  items?: MovieBoxItem[];
}

export interface MovieBoxSuggestion {
  title?: string | null;
  slug?: string | null;
  subject_id?: string | null;
  poster_url?: string | null;
}

export interface MovieBoxSuggestPayload {
  suggestions?: MovieBoxSuggestion[];
}

// ---------------------------------------------------------------------------
// Caches and subject-handle bookkeeping.
//
// The catalogue speaks slugs; playback speaks subject ids. Every item that
// passes through here records both directions, so a route carrying one can be
// resolved without forcing a detail request the UI already made.
// ---------------------------------------------------------------------------

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  at: number;
  promise: Promise<T>;
}

const detailCache = new Map<string, CacheEntry<MovieBoxDetail>>();
const homeCache: { entry: CacheEntry<MovieBoxHome> | null } = { entry: null };

/**
 * The last `/home` answer, persisted across page loads.
 *
 * `/home` is the one call every visit needs and it routinely takes 1.5-2s at
 * the origin. Keeping the previous payload in `localStorage` lets a returning
 * viewer paint the real shelves on the first tick while a fresh copy is
 * fetched in the background; the network becomes an upgrade rather than a gate.
 * The TTL is deliberately longer than the in-memory one -- a quarter-hour-old
 * catalogue is still a useful catalogue, and a stricter TTL would put the
 * viewer back in front of an empty grid to save a title that changed minutes
 * ago.
 */
const HOME_CACHE_KEY = "streamvy:home:v2";
const HOME_PERSIST_TTL_MS = 30 * 60 * 1000;

const detailPathBySubject = new Map<string, string>();
const subjectIdByPath = new Map<string, string>();
const posterBySlug = new Map<string, string>();

function rememberSubject(item: MovieBoxItem): void {
  const slug = item.slug?.trim();
  const subjectId = item.subject_id?.trim();
  if (slug && subjectId) {
    detailPathBySubject.set(subjectId, slug);
    subjectIdByPath.set(slug, subjectId);
  }
  if (slug && item.poster_url) posterBySlug.set(slug, item.poster_url);
}

/** The subject id already known for a handle, or null. */
export function peekSubjectId(handle: string): string | null {
  const clean = (handle ?? "").trim();
  if (!clean) return null;
  if (isUsableSubjectId(clean)) return clean;
  return subjectIdByPath.get(clean) ?? null;
}

/** The slug already known for a handle, or null. */
export function peekDetailPath(handle: string): string | null {
  const clean = (handle ?? "").trim();
  if (!clean) return null;
  if (!isUsableSubjectId(clean)) return clean;
  return detailPathBySubject.get(clean) ?? null;
}

/** The poster already seen for a slug, or null. */
export function peekPoster(slug: string): string | null {
  return posterBySlug.get(slug) ?? null;
}

function rememberDetail(detail: MovieBoxDetail): void {
  const slug = detail.subject?.detailPath?.trim();
  const subjectId = detail.subject?.subjectId?.trim();
  if (slug && subjectId) {
    detailPathBySubject.set(subjectId, slug);
    subjectIdByPath.set(slug, subjectId);
  }
  if (slug && detail.subject?.cover?.url) {
    posterBySlug.set(slug, detail.subject.cover.url);
  }
}

// ---------------------------------------------------------------------------
// Raw endpoint calls.
// ---------------------------------------------------------------------------

function rememberHome(payload: MovieBoxHome): void {
  for (const section of payload.sections ?? []) {
    for (const item of section.items ?? []) rememberSubject(item);
  }
}

function readPersistedHome(): MovieBoxHome | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(HOME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      at?: number;
      payload?: MovieBoxHome;
    };
    if (!parsed?.payload || !Array.isArray(parsed.payload.sections)) {
      return null;
    }
    if (!parsed.at || Date.now() - parsed.at > HOME_PERSIST_TTL_MS) {
      return null;
    }
    rememberHome(parsed.payload);
    return parsed.payload;
  } catch {
    // Private mode, a quota error or a corrupt entry. The network path below
    // is the fallback, not a second failure.
    return null;
  }
}

function writePersistedHome(payload: MovieBoxHome): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      HOME_CACHE_KEY,
      JSON.stringify({ at: Date.now(), payload })
    );
  } catch {
    // A full quota must not break browsing.
  }
}

function fetchHome(): Promise<MovieBoxHome> {
  return streamvyGet<MovieBoxHome>("/home", { context: "Home" }).then(
    payload => {
      rememberHome(payload);
      writePersistedHome(payload);
      return payload;
    }
  );
}

/** `GET /home`. */
export function getHome(force = false): Promise<MovieBoxHome> {
  const now = Date.now();
  const cached = homeCache.entry;
  if (!force && cached && now - cached.at < CATALOG_CACHE_TTL_MS) {
    return cached.promise;
  }

  // A persisted answer is returned immediately and refreshed behind the
  // viewer. The in-flight network promise replaces the memory entry so a later
  // call gets the fresh one, but nothing on this call waits for it.
  const persisted = force ? null : readPersistedHome();
  if (persisted) {
    const resolved = Promise.resolve(persisted);
    homeCache.entry = { at: now, promise: resolved };
    fetchHome()
      .then(payload => {
        homeCache.entry = { at: Date.now(), promise: Promise.resolve(payload) };
      })
      .catch(() => {
        // Keep serving the persisted copy when the refresh fails.
      });
    return resolved;
  }

  const promise = fetchHome();
  homeCache.entry = { at: now, promise };
  promise.catch(() => {
    if (homeCache.entry?.promise === promise) homeCache.entry = null;
  });
  return promise;
}

/** `GET /search?q=`. */
export function searchSubjects(
  query: string,
  page = 1
): Promise<MovieBoxSearchPayload> {
  return streamvyGet<MovieBoxSearchPayload>("/search", {
    params: { q: query, page },
    context: "Search",
  }).then(payload => {
    for (const item of payload.items ?? []) rememberSubject(item);
    return payload;
  });
}

/** `GET /search/suggest?q=`. */
export function suggestSubjects(query: string): Promise<MovieBoxSuggestion[]> {
  // The deployed `/search/suggest` answers titles only -- `slug` and
  // `subject_id` are null -- which leaves a suggestion with no route to open.
  // `/search` is one request and carries both handles plus the poster, so the
  // palette is built from its first page instead. `/search/suggest` stays
  // documented above for the day the upstream enriches it.
  return searchSubjects(query).then(payload => {
    return (payload.items ?? []).slice(0, 8).map(item => ({
      title: item.name ?? null,
      slug: item.slug ?? null,
      subject_id: item.subject_id ?? null,
      poster_url: item.poster_url ?? null,
    }));
  });
}

/** `GET /movies`, `/tv-series` or `/animation`. */
export function getCatalog(
  kind: "movies" | "tv-series" | "animation",
  opts: { page?: number; sort?: string } = {}
): Promise<MovieBoxCatalogPage> {
  return streamvyGet<MovieBoxCatalogPage>(`/${kind}`, {
    params: { page: opts.page ?? 1, sort: opts.sort },
    context: kind === "movies" ? "Movies" : kind === "tv-series" ? "TV series" : "Animation",
  }).then(payload => {
    for (const item of payload.items ?? []) rememberSubject(item);
    return payload;
  });
}

/**
 * `GET /detail/{slug}`.
 *
 * Accepts a subject id too, but only when that id has already been seen on a
 * card or suggestion. The live deployment answers `/detail/{subject_id}` with
 * 502 (it forwards the id into the slug query), so a cold direct link keyed on a
 * numeric id cannot be recovered -- routes in this app are built from slugs for
 * exactly that reason.
 */
export function getDetail(handle: string): Promise<MovieBoxDetail> {
  const clean = (handle ?? "").trim();
  if (!clean) return Promise.reject(new Error("A title handle is required"));

  // `subjectIdByPath` maps a slug to its subject id, not the other way
  // around. Reading it here used to turn a perfectly good slug into a
  // subject id and then ask `/detail/{subject_id}`, which the live API
  // answers with a 502. Only a subject id needs translating back to a slug.
  const slug = isUsableSubjectId(clean)
    ? detailPathBySubject.get(clean) ?? clean
    : clean;

  const now = Date.now();
  const cached = detailCache.get(slug);
  if (cached && now - cached.at < CATALOG_CACHE_TTL_MS) return cached.promise;

  const promise = streamvyGet<MovieBoxDetailEnvelope>(
    `/detail/${encodeURIComponent(slug)}`,
    { context: "Title details", timeoutMs: STREAMVY_STREAM_TIMEOUT_MS }
  ).then(envelope => {
    if (!envelope?.data?.subject) {
      throw new Error("The media API answered a detail payload with no subject");
    }
    rememberDetail(envelope.data);
    return envelope.data;
  });

  detailCache.set(slug, { at: now, promise });
  promise.catch(() => detailCache.delete(slug));
  return promise;
}

/** Resolve a handle to the subject id playback needs. */
export async function resolveSubjectId(handle: string): Promise<string> {
  const clean = (handle ?? "").trim();
  if (!clean) throw new Error("A title handle is required");
  if (isUsableSubjectId(clean)) {
    const known = detailPathBySubject.get(clean);
    if (known) return clean;
  }
  const detail = await getDetail(clean);
  return detail.subject.subjectId;
}

/** Resolve a handle to the detail slug the API accepts. */
export async function resolveDetailPath(handle: string): Promise<string> {
  const clean = (handle ?? "").trim();
  if (!clean) throw new Error("A title handle is required");
  if (!isUsableSubjectId(clean)) return clean;
  const known = detailPathBySubject.get(clean);
  if (known) return known;
  const detail = await getDetail(clean);
  return detail.subject.detailPath?.trim() || clean;
}

/**
 * `GET /api/stream/{subject_id}`.
 *
 * Movies address the endpoint with `se=0&ep=0`; a series carries the real
 * season and episode. Both are always sent explicitly: the route's own default
 * is `se=1&ep=1`, which is the one combination a film never has a source for.
 *
 * Cached per (subject, detail path, season, episode) for a minute. The signed
 * CDN URL is short-lived, so a longer cache would hand the player an expired URL
 * on a retry.
 */
const STREAM_CACHE_TTL_MS = 60_000;

const streamCache = new Map<string, CacheEntry<MovieBoxStreamPayload>>();

export function getStreams(
  subjectId: string,
  detailPath: string,
  opts: { season?: number; episode?: number; force?: boolean } = {}
): Promise<MovieBoxStreamPayload> {
  const season = opts.season ?? 0;
  const episode = opts.episode ?? 0;
  const key = `${subjectId}|${detailPath}|${season}|${episode}`;
  const cached = streamCache.get(key);
  const now = Date.now();
  if (!opts.force && cached && now - cached.at < STREAM_CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = streamvyGet<MovieBoxStreamPayload>(
    `/api/stream/${encodeURIComponent(subjectId)}`,
    {
      params: { detail_path: detailPath, se: season, ep: episode },
      context: "Stream",
      timeoutMs: STREAMVY_STREAM_TIMEOUT_MS,
    }
  );

  streamCache.set(key, { at: now, promise });
  promise.catch(() => streamCache.delete(key));
  return promise;
}

/** `GET /api/stream/{subject_id}/captions`. */
export function getCaptions(
  subjectId: string,
  detailPath: string,
  opts: { season?: number; episode?: number } = {}
): Promise<MovieBoxCaptionPayload> {
  const season = opts.season ?? 0;
  const episode = opts.episode ?? 0;
  return streamvyGet<MovieBoxCaptionPayload>(
    `/api/stream/${encodeURIComponent(subjectId)}/captions`,
    {
      params: { detail_path: detailPath, se: season, ep: episode },
      context: "Captions",
      timeoutMs: 15_000,
    }
  );
}

// ---------------------------------------------------------------------------
// The video proxy.
// ---------------------------------------------------------------------------

/** The proxy route that relays a media URL back through the API origin. */
export const VIDEO_PROXY_PATH = "/proxy/stream";

/** Schemes that must never be wrapped: a blob is ours, `data:` is inline. */
const PASSTHROUGH_SCHEME = /^(blob|data):/i;

/**
 * True when `url` is already one of our video-proxy handles.
 *
 * Checked by *path*, not by prefix, so it stays true however the origin was
 * configured -- and it is what makes wrapping idempotent.
 */
export function isProxiedVideoUrl(url: string): boolean {
  try {
    const path = new URL(url, "https://url.invalid").pathname;
    return path === VIDEO_PROXY_PATH || path === "/api/proxy/video";
  } catch {
    return false;
  }
}

/**
 * The upstream URL a proxy handle carries, or null when there is none.
 *
 * Format sniffing has to run against *this*, not against the handle: every
 * proxied URL ends in `/proxy/stream` and so looks like an unrecognised path.
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
 * The URL a `<video>`, `<audio>` or `<track>` should load.
 *
 * Raw CDN URLs are refused by the browser before a byte is read: the media hosts
 * require a MovieBox `Referer`, which a cross-origin media element cannot set
 * because the browser owns that header. The API's proxy exists for exactly
 * this: it fetches upstream with the referer the title needs and answers with
 * CORS headers the browser accepts.
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
    try {
      absolute = new URL(trimmed, "https://url.invalid").toString();
    } catch {
      return trimmed;
    }
  }

  const params = new URLSearchParams({ url: absolute });
  const cleanReferer = typeof referer === "string" ? referer.trim() : "";
  if (cleanReferer) params.set("referer", cleanReferer);
  return `${streamvyProxyUrl(VIDEO_PROXY_PATH)}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Captions.
// ---------------------------------------------------------------------------

/** How many caption tracks are converted per playback. */
const MAX_CAPTION_TRACKS = 4;

function captionLang(caption: MovieBoxCaption): string {
  return (
    caption.lan?.trim() ||
    caption.lanName?.trim() ||
    ""
  );
}

/**
 * Load this playback's caption tracks as WebVTT the browser will actually
 * parse.
 *
 * The API serves `.srt`. A `<track>` element accepts WebVTT only -- an SRT src
 * is a silent failure, not an error. Each file is pulled through the same video
 * proxy (which carries the referer the CDN requires) and converted here.
 *
 * Entirely fail-soft: a caption is decoration, and one that cannot be fetched
 * or read is dropped rather than failing the playback it rode in on.
 */
export async function loadCaptionTracks(
  subjectId: string,
  detailPath: string,
  opts: { season?: number; episode?: number } = {}
): Promise<{ label: string; lang: string; url: string }[]> {
  let payload: MovieBoxCaptionPayload;
  try {
    payload = await getCaptions(subjectId, detailPath, opts);
  } catch {
    return [];
  }
  const captions = Array.isArray(payload?.captions) ? payload.captions : [];

  const ranked = captions
    .map((caption, index) => ({ caption, index }))
    .sort((a, b) => {
      const rank = (caption: MovieBoxCaption): number => {
        const code = captionLang(caption).toLowerCase();
        if (code === "en" || code.startsWith("en-")) return 0;
        if (code === "") return 2;
        return 1;
      };
      return rank(a.caption) - rank(b.caption) || a.index - b.index;
    })
    .map(entry => entry.caption)
    .filter(caption => typeof caption.url === "string" && caption.url.trim())
    .slice(0, MAX_CAPTION_TRACKS);

  const tracks = await Promise.all(
    ranked.map(async caption => {
      const lang = captionLang(caption);
      if (!lang) return null;
      try {
        const response = await fetch(proxiedVideoUrl(caption.url as string));
        if (!response.ok) return null;
        const text = await response.text();
        const parsed = parseSubtitleFile(`${lang}.srt`, text);
        if (!parsed.ok) return null;
        const blob = new Blob([parsed.vtt], { type: "text/vtt" });
        return {
          label: caption.lanName?.trim() || lang,
          lang,
          url: URL.createObjectURL(blob),
        };
      } catch {
        return null;
      }
    })
  );

  return tracks.filter(
    (track): track is { label: string; lang: string; url: string } =>
      track !== null
  );
}
