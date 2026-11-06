/**
 * HTTP client for the external movie pipeline.
 *
 * The Python scraper/backend (Flask/FastAPI) exposes `GET /api/movies` and
 * returns a JSON array in this shape, with `stream_url` pointing at an actual
 * playable video file or stream (MP4/HLS) — never a third-party embed. The
 * base URL is configurable through `VITE_MOVIE_API_BASE_URL` and defaults to
 * the local development server.
 */
import {
  ApiError,
  getDetail,
  getHome,
  getStreams,
  isRateLimited,
  isUsableSubjectId,
  loadCaptionTracks,
  peekDetailPath,
  peekPoster,
  peekSubjectId,
  proxiedVideoTarget,
  proxiedVideoUrl,
  resolveDetailPath,
  resolveSubjectId,
  searchSubjects,
  suggestSubjects,
  STREAMVY_API_BASE_URL,
  USING_FALLBACK_STREAMVY_ORIGIN,
  type MovieBoxDetail,
  type MovieBoxItem,
  type MovieBoxResource,
  type MovieBoxSeasonBlock,
} from "@/services/streamvy";

export { ApiError, isRateLimited, proxiedVideoTarget };

export type StreamQuality = "8K" | "4K" | "1080p" | "720p" | "480p" | "320p";

export interface StreamVariant {
  quality: StreamQuality;
  url: string;
  width: number;
  height: number;
  size: number;
  /**
   * Tokenised same-origin handle the backend mints for this rendition when it
   * is a real saveable file (`/api/v1/playback/download?token=…`). Absent for
   * playlists and embeds. This is the only URL downloads work through: the
   * play handle is a playlist relay and the raw archive URL is never shipped.
   */
  downloadUrl?: string | null;
}

export interface StreamSubtitle {
  label: string;
  lang: string;
  url: string;
}

/**
 * Keep only well-formed subtitle descriptors.
 *
 * Every field is required for a `<track>` to work: `url` is the source, `lang`
 * becomes `srcLang` and is how the player matches a selection back to a track,
 * and `label` is what the menu shows. A descriptor missing `url` or `lang` is
 * dropped rather than rendered as a dead row.
 */
export function sanitizeSubtitles(value: unknown): StreamSubtitle[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tracks: StreamSubtitle[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const raw = typeof record.url === "string" ? record.url.trim() : "";
    if (!raw) continue;
    // Caption handles are minted as `/api/proxy/subtitle?track=…` and must be
    // absolutised for the same reason the media legs are — see
    // `resolvePlaybackHandle`. A `<track>` fetches cross-origin in prod, so a
    // relative handle would resolve against Vercel and 404 into the SPA shell.
    const url = resolvePlaybackHandle(raw);
    const lang = typeof record.lang === "string" ? record.lang.trim() : "";
    if (!lang) continue;
    // Two files for the same language would collide in the track list, since
    // the player selects by language code.
    const key = lang.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({
      url,
      lang,
      label:
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : lang,
    });
  }
  return tracks;
}

/** An alternative playable source carried by the v1 init payload (`mirrors`).
 * The player lets the viewer switch between `stream_url` and these mirrors at
 * runtime. */
export interface StreamMirror {
  name: string;
  url: string;
}

/**
 * One entry of `/api/movies/resolve`'s ordered `providers` array: the failover
 * chain the resolver walked, winner first.
 *
 * The client walks this list itself on a per-candidate timer instead of asking
 * the server again, so `name` is a label to show, `url` is the thing to load, and
 * `is_embed` says whether the URL is a frame or a file. The backend also emits
 * the planned (unprobed) chain this shape when nothing resolved, so an entry
 * being here never means it was verified -- `available` on the payload is what
 * says that.
 */
export interface StreamProviderCandidate {
  name: string;
  url: string;
  is_embed: boolean;
}

export interface StreamEpisode {
  season: number;
  number: number;
  title: string;
  overview?: string;
  still_path?: string;
  still_url?: string;
  air_date?: string;
  runtime?: number;
  vote_average?: number;
}

export interface StreamMovie {
  /**
   * MovieBox subject id. A ~19-digit string, never a number: it exceeds
   * `Number.MAX_SAFE_INTEGER`, so any numeric round-trip silently changes which
   * title plays.
   */
  id: string;
  /** The API's public URL handle for this title (`/detail/{detail_path}`). */
  detail_path?: string;
  title: string;
  poster_url: string;
  stream_url: string;
  streams?: StreamVariant[];
  subtitles?: StreamSubtitle[];
  episodes?: StreamEpisode[];
  year?: number | null;
  topics?: string[];
  _downloads?: number;
  _addeddate?: string;
  /** Whether the payload is a feature film or a TV series. */
  media_type?: "movie" | "tv";
  /** Season count for TV payloads (drives the episode matrix). */
  seasons?: number;
  /** Episodes-per-season count for TV payloads (drives the episode matrix). */
  episodes_per_season?: number;
  /** Season the returned `stream_url` targets (TV payloads). */
  season?: number;
  /** Episode the returned `stream_url` targets (TV payloads). */
  episode?: number;
  /** Alternate embed sources returned by `/api/v1/playback/init`. */
  mirrors?: StreamMirror[];
  /**
   * The resolver's ordered provider chain (winner first), carried onto the movie
   * because `resolveStream` returns `{stream, exact}` and the chain is the one
   * field the page cannot re-derive: the order is the backend's own decision
   * about what it probed and what survived.
   */
  providers?: StreamProviderCandidate[];
  /**
   * The backend's provider chain settled on a third-party iframe rather than a
   * directly playable file. Optional because catalog listings carry no stream at
   * all, so "not an embed" and "no stream yet" are genuinely different.
   */
  is_embed?: boolean;
  /** Ordered playable source candidates (primary first) for auto-cycling. */
  sources?: string[];
  /** Backdrop image URL from TMDB (original size). */
  backdrop_url?: string;
  /** TMDB overview/synopsis. */
  overview?: string;
  /** TMDB vote average (0-10). */
  vote_average?: number;
  /** TMDB popularity score. */
  popularity?: number;
  /** TMDB genre names. */
  genres?: string[];
}

/** Order of quality tiers, best -> worst. */
export const STREAM_QUALITY_ORDER: StreamQuality[] = [
  "8K",
  "4K",
  "1080p",
  "720p",
  "480p",
  "320p",
];

/**
 * Nearest quality rung for a real video height. This is an explicit ladder
 * rather than a comparison against `STREAM_QUALITY_ORDER`: the order array
 * holds labels like "4K" and "1080p", and `Number.parseInt("4K", 10)` is 4, so
 * every height from 4 upward would have matched "4K".
 */
export function qualityFromHeight(height: number): StreamQuality {
  // An absent or zero height tells us nothing, so hold the neutral rung
  // rather than claiming a resolution the stream may well exceed.
  if (!Number.isFinite(height) || height <= 0) return "480p";
  if (height >= 4000) return "8K";
  if (height >= 2000) return "4K";
  if (height >= 900) return "1080p";
  if (height >= 600) return "720p";
  if (height >= 400) return "480p";
  return "320p";
}

/**
 * Return the movie's requested quality variant, preferring the largest tier no
 * higher than the player's preload budget. Falls back to `stream_url` (the
 * backend's default, generally the fastest-start tier).
 */
export function pickStreamVariant(
  movie: StreamMovie,
  quality?: StreamQuality
): { variant?: StreamVariant; url: string } {
  if (movie.streams?.length) {
    if (quality) {
      const found = movie.streams.find(s => s.quality === quality);
      if (found) return { variant: found, url: found.url };
    }
    const best = movie.streams[0];
    return { variant: best, url: best.url };
  }
  return { url: movie.stream_url };
}

/**
 * Save URL for a media file the API already knows how to relay.
 *
 * A browser ignores an `<a download>` attribute on a cross-origin href, so the
 * anchor points at the API's `/proxy/download` route; that route streams the
 * same bytes as `/proxy/stream` but adds `Content-Disposition: attachment`,
 * which is what actually names and saves the file. The CDN Referer the upstream
 * requires is added on the server, not here.
 */
export function proxiedDownloadUrl(url: string, filename: string): string {
  const params = new URLSearchParams({ url, filename });
  return `${MOVIE_API_BASE_URL}/proxy/download?${params.toString()}`;
}

/**
 * The URL a `<track>` element should load.
 *
 * The backend mints every caption as a same-origin relay handle
 * (`/api/proxy/subtitle?track=…`) that already converts `.srt` upstreams to
 * WebVTT and serves with CORS headers. That handle is playable as-is. It used
 * to be re-wrapped in `/api/subtitles?url=…` — a pre-v1 raw-URL door the
 * backend deliberately removed — so every `<track>` fetched a 404 and no cue
 * ever rendered. Handles are passed through untouched now; a rare absolute URL
 * is also handed over unchanged, because no raw-URL proxy exists any more and
 * mangling it into a dead route cannot help.
 */
export function subtitleTrackUrl(url: string): string {
  return url;
}

/**
 * The catalogue API's origin.
 *
 * `MOVIE_API_BASE_URL` is kept as the name every existing caller and test uses,
 * but it now resolves through the media API's own variable. The legacy
 * `VITE_API_BASE_URL` is deliberately not consulted here: deployments still
 * carry it pointing at the retired Flask/Render service, and inheriting it
 * would silently send every catalogue call back to an origin the operator has
 * moved off.
 */
export const MOVIE_API_BASE_URL = STREAMVY_API_BASE_URL;

/**
 * True when this build carries no configured media origin and is therefore
 * talking to the deployed default above. The only signal it leaves behind --
 * nothing is logged.
 */
export const USING_FALLBACK_BACKEND_ORIGIN = USING_FALLBACK_STREAMVY_ORIGIN;

/** Build a full API URL for the movie backend. */
export function apiUrl(path: string): string {
  return `${MOVIE_API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Absolutise a backend-minted playback handle so the browser fetches it from
 * the API origin rather than the SPA's own origin.
 *
 * The backend answers every downstream playback leg as a *relative* path —
 * `/api/v1/playback/media?token=…`, `/api/v1/playback/frame?token=…`,
 * `/api/v1/playback/download?token=…`, `/api/proxy/manifest?token=…`,
 * `/api/proxy/subtitle?track=…`. That is correct when the SPA and the API share
 * an origin, which is the local-dev shape (Vite proxies `/api` to :5000).
 *
 * In production they do not: the SPA is on Vercel, the API on Render. A
 * relative handle is then resolved against Vercel, whose only `/api` answer is
 * the SPA catch-all rewrite, which serves `index.html`. So the `<video>` element
 * is handed an HTML document (the black "won't play"), hls.js is asked to parse
 * a manifest out of markup, and the download anchor navigates to the homepage
 * instead of saving a file. All three are one bug: the handle never reached the
 * API.
 *
 * Only `/api/`-prefixed paths are rewritten. Absolute URLs (third-party embeds,
 * raw Archive.org files) and non-API relative paths are passed through
 * untouched, and the rewrite is idempotent — an already-absolute handle no
 * longer starts with `/api/`, so re-running it is a no-op. In dev the base is
 * empty, so this leaves the path relative and Vite's proxy still applies.
 */
export function resolvePlaybackHandle(url: string): string {
  if (!url.startsWith("/api/")) return url;
  return apiUrl(url);
}

function isStreamMovie(value: unknown): value is StreamMovie {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.poster_url === "string" &&
    typeof record.stream_url === "string"
  );
}



/**
 * The media kind a home section carries.
 *
 * A `/home` card does not say whether it is a film or a series; only the
 * section it sits in does. This is what fills that gap, and it is deliberately
 * biased toward "movie": a film addressed as a series asks the stream endpoint
 * for a season it does not have, which is a harder failure than a series opened
 * as a film (the route is still the same slug, and the detail record corrects
 * the kind the moment it loads).
 */
function mediaTypeFromSection(section: string): "movie" | "tv" {
  const label = section.toLowerCase();
  if (
    label.includes("series") ||
    label.includes("show") ||
    label.includes("drama") ||
    label.includes("anime") ||
    label.includes("animation")
  ) {
    return "tv";
  }
  return "movie";
}

/** Genre labels the home sections use, matched case-insensitively. */
const SECTION_GENRES: Record<string, string> = {
  action: "Action",
  adventure: "Adventure",
  animation: "Animation",
  anime: "Anime",
  comedy: "Comedy",
  crime: "Crime",
  documentary: "Documentary",
  drama: "Drama",
  family: "Family",
  fantasy: "Fantasy",
  horror: "Horror",
  music: "Music",
  mystery: "Mystery",
  romance: "Romance",
  superhero: "Superhero",
  thriller: "Thriller",
  war: "War",
  western: "Western",
  nollywood: "Nollywood",
  "k-drama": "K-Drama",
  "c-drama": "C-Drama",
  bl: "BL",
};

/**
 * Derive display genres from a section's name.
 *
 * This is the only genre signal the home feed carries, so it is worth the small
 * amount of normalisation: "Action & Thriller" has to yield two chips, not the
 * literal string, and "Popular Series" must yield none rather than inventing a
 * genre from the word "series".
 */
function genresFromSection(section: string): string[] {
  const label = section.toLowerCase();
  const genres = new Set<string>();
  if (label.includes("sci-fi") || label.includes("sci fi")) {
    genres.add("Sci-Fi");
  }
  for (const token of label.split(/[^a-z-]+/)) {
    const genre = SECTION_GENRES[token];
    if (genre) genres.add(genre);
  }
  return [...genres];
}

function posterFromItem(item: MovieBoxItem): string {
  const direct = item.poster_url?.trim();
  if (direct) return direct;
  const slug = item.slug?.trim();
  return (slug && peekPoster(slug)) || "";
}

/**
 * A home/search card as the app's `StreamMovie`.
 *
 * `stream_url` is empty on purpose. The catalogue never carries playable links
 * -- those are minted per episode by `/api/stream` -- and an empty string is how
 * every existing caller already represents "metadata only".
 */
function movieFromItem(
  item: MovieBoxItem,
  mediaType: "movie" | "tv"
): StreamMovie {
  const slug = item.slug?.trim() || "";
  const subjectId = item.subject_id?.trim() || slug;
  return {
    id: subjectId,
    detail_path: slug || undefined,
    title: item.name?.trim() || slug || "Untitled",
    poster_url: posterFromItem(item),
    stream_url: "",
    year: toStreamYear(item.year),
    media_type: mediaType,
    ...(typeof item.rating === "number"
      ? { vote_average: item.rating }
      : typeof item.rating === "string" && Number.isFinite(Number(item.rating))
        ? { vote_average: Number(item.rating) }
        : {}),
  };
}

/** Split the API's comma-joined `genre` field. */
function genresFromSubject(genre: string | undefined): string[] {
  if (!genre) return [];
  return genre
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
}

function stillsUrl(stills: MovieBoxDetail["subject"]["stills"]): string {
  if (!stills) return "";
  if (typeof stills === "string") return stills;
  return stills.url?.trim() || "";
}

/** Flatten the per-season episode counts into the app's flat episode list. */
function episodesFromResource(resource?: MovieBoxResource): StreamEpisode[] {
  const blocks = Array.isArray(resource?.seasons) ? resource.seasons : [];
  const episodes: StreamEpisode[] = [];
  for (const block of blocks) {
    if (!Number.isFinite(block.se) || !Number.isFinite(block.maxEp)) continue;
    for (let episode = 1; episode <= block.maxEp; episode++) {
      episodes.push({
        season: block.se,
        number: episode,
        title: `Episode ${episode}`,
      });
    }
  }
  return episodes;
}

function seasonCount(resource?: MovieBoxResource): number {
  const blocks: MovieBoxSeasonBlock[] = Array.isArray(resource?.seasons)
    ? resource.seasons
    : [];
  return blocks.reduce((max, block) => Math.max(max, block.se), 0) || 1;
}

function episodeCount(resource?: MovieBoxResource): number {
  const blocks: MovieBoxSeasonBlock[] = Array.isArray(resource?.seasons)
    ? resource.seasons
    : [];
  return blocks.reduce((max, block) => Math.max(max, block.maxEp), 0) || 1;
}

/**
 * A `/detail/{slug}` record as the app's `StreamMovie`.
 *
 * This is the one place the catalogue's vocabulary (subject, cover, resource)
 * becomes the app's (id, poster_url, seasons), so a new field only has to be
 * mapped once.
 */
function movieFromDetail(detail: MovieBoxDetail): StreamMovie {
  const subject = detail.subject;
  const mediaType = subject.subjectType === 2 ? "tv" : "movie";
  const rating = Number(subject.imdbRatingValue);
  const slug = subject.detailPath?.trim() || "";
  return {
    id: subject.subjectId,
    detail_path: slug || undefined,
    title:
      subject.title?.trim() || detail.metadata?.title?.trim() || "Untitled",
    poster_url: subject.cover?.url?.trim() || "",
    backdrop_url: stillsUrl(subject.stills),
    stream_url: "",
    year: toStreamYear(subject.releaseDate?.slice(0, 4)),
    overview:
      subject.description?.trim() || detail.metadata?.description?.trim() || "",
    media_type: mediaType,
    genres: genresFromSubject(subject.genre),
    seasons: mediaType === "tv" ? seasonCount(detail.resource) : 1,
    episodes_per_season:
      mediaType === "tv" ? episodeCount(detail.resource) : 1,
    ...(Number.isFinite(rating) && rating > 0 ? { vote_average: rating } : {}),
    ...(mediaType === "tv"
      ? { episodes: episodesFromResource(detail.resource) }
      : {}),
  };
}

/** One home section, wrapped so genre/media-kind travel with its cards. */
interface HomeSectionView {
  name: string;
  mediaType: "movie" | "tv";
  genres: string[];
  movies: StreamMovie[];
}

async function homeSections(): Promise<HomeSectionView[]> {
  const payload = await getHome();
  const raw = Array.isArray(payload.sections) ? payload.sections : [];
  return raw
    .filter(section => !/music video/i.test(section.section))
    .map(section => {
      const mediaType = mediaTypeFromSection(section.section);
      const items = Array.isArray(section.items) ? section.items : [];
      return {
        name: section.section,
        mediaType,
        genres: genresFromSection(section.section),
        movies: items
          .filter(item => Boolean(item.slug?.trim()))
          .map(item => movieFromItem(item, mediaType)),
      };
    })
    .filter(section => section.movies.length > 0);
}

/** Flatten sections, keeping the first occurrence of each subject. */
function flattenSections(sections: HomeSectionView[]): StreamMovie[] {
  const seen = new Set<string>();
  const movies: StreamMovie[] = [];
  for (const section of sections) {
    for (const movie of section.movies) {
      if (seen.has(movie.id)) continue;
      seen.add(movie.id);
      movies.push(movie);
    }
  }
  return movies;
}

function sectionsMatching(
  sections: HomeSectionView[],
  predicate: (section: HomeSectionView) => boolean
): HomeSectionView[] {
  return sections.filter(predicate);
}

/**
 * Live search against the media API (`/search?q=…`).
 *
 * Returns an empty array for an empty query and throws when the backend is
 * unreachable so callers can fall back to their metadata provider.
 */
export async function searchCatalog(query: string): Promise<StreamMovie[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const payload = await searchSubjects(trimmed);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return items
    .filter(item => Boolean(item.slug?.trim()))
    .map(item =>
      movieFromItem(
        item,
        /\bseries\b/i.test(item.name ?? "") ? "tv" : "movie"
      )
    );
}

export interface ResolvedStream {
  stream: StreamMovie;
  exact: boolean;
  /**
   * Base language code the backend worked out for this viewer (from their
   * address, never from anything they typed). Null when the backend could not
   * place them. The player seeds its track selection from it; see
   * {@link StreamSource.language}.
   */
  language?: string | null;
}

/** Thrown when the backend has no playable title for the requested search. */
export class StreamNotFoundError extends Error {
  constructor(title: string) {
    super(`No playable stream found for "${title}"`);
    this.name = "StreamNotFoundError";
  }
}

/**
 * Thrown when the backend walked every configured provider and none of them
 * could serve the title (HTTP 404 with `code: "PROVIDERS_EXHAUSTED"` from
 * `/api/v1/playback/init`).
 *
 * This is deliberately distinct from a transport error. It reports a
 * *decision* -- the whole chain was tried -- so retrying it can only re-walk
 * providers that already failed. Treating it as a generic error made the client
 * burn its whole retry budget re-asking a question that was already answered,
 * delaying the terminal state by several long round-trips.
 */
export class StreamExhaustedError extends Error {
  /** Per-provider outcome from the chain, for diagnostics. */
  readonly providerAttempts: unknown[];

  constructor(attempts: unknown[] = []) {
    super("Every stream provider failed for this title");
    this.name = "StreamExhaustedError";
    this.providerAttempts = attempts;
  }
}

/** Normalize the year the backend reports (string when it came from TMDB). */
function toStreamYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The resolve response movie is embed-oriented: it always carries an id,
 * title, and `stream_url`, but only sometimes a `poster_url` (resolved TV
 * entries and bare TMDB matches omit it) and reports `year` as a string when
 * it came from TMDB. This guard + normalizer keep the resolve contract happy
 * with the shape the updated backend actually returns.
 */
function isResolveMovie(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.stream_url === "string"
  );
}

function normalizeResolvedMovie(value: unknown): StreamMovie | null {
  if (!isResolveMovie(value)) return null;
  const mediaType = value.media_type === "tv" ? "tv" : "movie";
  return {
    id: String(value.id),
    title: String(value.title),
    poster_url: typeof value.poster_url === "string" ? value.poster_url : "",
    backdrop_url:
      typeof value.backdrop_url === "string" ? value.backdrop_url : "",
    stream_url: resolvePlaybackHandle(String(value.stream_url)),
    year: toStreamYear(value.year),
    media_type: mediaType,
    season:
      typeof value.season === "number"
        ? value.season
        : Number(value.season) || 1,
    episode:
      typeof value.episode === "number"
        ? value.episode
        : Number(value.episode) || 1,
    seasons:
      typeof value.seasons === "number"
        ? value.seasons
        : Number(value.seasons) || 1,
    episodes_per_season:
      typeof value.episodes_per_season === "number"
        ? value.episodes_per_season
        : Number(value.episodes_per_season) || 1,
    overview: typeof value.overview === "string" ? value.overview : "",
    // The backend's provider chain reports which tier settled the title, so the
    // page can render an embed without re-deriving it from the host. Carried
    // through here for the same reason as `subtitles` and `streams` below: this
    // normalizer rebuilds the movie field by field, so any field it forgets to
    // copy silently disappears.
    is_embed: value.is_embed === true,
    vote_average:
      typeof value.vote_average === "number" ? value.vote_average : undefined,
    popularity:
      typeof value.popularity === "number" ? value.popularity : undefined,
    genres: Array.isArray(value.genres) ? value.genres : [],
    ...(value.episodes && Array.isArray(value.episodes)
      ? { episodes: value.episodes }
      : {}),
    // The resolver reports subtitle tracks, but this normalizer rebuilt the
    // movie field by field and never copied them -- so the array reached the
    // player as `undefined` no matter what the backend sent.
    ...(sanitizeSubtitles(value.subtitles).length > 0
      ? { subtitles: sanitizeSubtitles(value.subtitles) }
      : {}),
    // Same bug, second time, for the stream list. `pickDownloadCandidate`
    // prefers `streams` over `stream_url` precisely because the primary URL is
    // often the HLS playlist or an embed while the list holds a saveable file;
    // dropping the list here quietly removed that preference. The backend sends
    // {height, quality, size, url, width} per entry, and `quality` is a closed
    // union here, so an unrecognised label is resolved against the real
    // resolution rather than cast through.
    ...(Array.isArray(value.streams) && value.streams.length > 0
      ? {
          streams: value.streams
            .map((entry): StreamVariant | null => {
              const record = entry as Record<string, unknown>;
              if (typeof record.url !== "string" || !record.url) return null;
              const height =
                typeof record.height === "number" ? record.height : 0;
              const label =
                typeof record.quality === "string" ? record.quality : "";
              const quality =
                STREAM_QUALITY_ORDER.find(q => label.includes(q)) ??
                qualityFromHeight(height);
              return {
                url: resolvePlaybackHandle(record.url),
                quality,
                width: typeof record.width === "number" ? record.width : 0,
                height,
                size: typeof record.size === "number" ? record.size : 0,
                downloadUrl:
                  typeof record.download_url === "string" &&
                  record.download_url.trim()
                    ? resolvePlaybackHandle(record.download_url.trim())
                    : null,
              };
            })
            .filter((entry): entry is StreamVariant => entry !== null),
        }
      : {}),
    ...(value.mirrors && Array.isArray(value.mirrors)
      ? {
          mirrors: value.mirrors
            .map((mirror): StreamMirror | null => {
              if (
                !mirror ||
                typeof (mirror as StreamMirror).name !== "string" ||
                typeof (mirror as StreamMirror).url !== "string"
              ) {
                return null;
              }
              const typed = mirror as StreamMirror;
              return {
                name: typed.name,
                url: resolvePlaybackHandle(typed.url),
              };
            })
            .filter((mirror): mirror is StreamMirror => mirror !== null),
        }
      : {}),
    // The failover chain, in the backend's own probed order. This normalizer
    // rebuilds the movie field by field, so a field it forgets to copy vanishes
    // rather than arriving malformed -- and a dropped chain is exactly what left
    // the page with nothing to walk, so every candidate had to be guessed.
    ...(Array.isArray(value.providers) && value.providers.length > 0
      ? {
          providers: value.providers
            .map((entry): StreamProviderCandidate | null => {
              if (typeof entry !== "object" || entry === null) return null;
              const record = entry as Record<string, unknown>;
              if (typeof record.url !== "string" || !record.url) return null;
              const name =
                typeof record.name === "string" && record.name.trim()
                  ? record.name.trim()
                  : "Alternate source";
              return {
                name,
                url: resolvePlaybackHandle(record.url),
                is_embed: record.is_embed !== false,
              };
            })
            .filter(
              (entry): entry is StreamProviderCandidate => entry !== null
            ),
        }
      : {}),
  };
}

function isResolvePayload(value: unknown): value is {
  movie: StreamMovie;
  exact: boolean;
  language?: string | null;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Boolean(normalizeResolvedMovie(record.movie)) &&
    typeof record.exact === "boolean"
  );
}

/** Optional media targeting for stream resolution (TV series playback). */
export interface StreamResolveOptions {
  /** The detail slug, when the caller already has it (avoids re-deriving it). */
  detailPath?: string;
  /** Feature film or series, when the caller already knows the kind. */
  mediaType?: "movie" | "tv";
  /** Season of a series to resolve (ignored for movies). */
  season?: number;
  /** Episode of a series to resolve (ignored for movies). */
  episode?: number;
}

/** Distinguishes "the resolver is still booting" from a real failure. */
export class StreamTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Stream resolver did not respond within ${timeoutMs / 1000}s`);
    this.name = "StreamTimeoutError";
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // Only the timer aborts this controller, so a rejection here is a timeout
    // rather than a genuine network failure. Callers retry the former silently
    // and surface the latter.
    if (controller.signal.aborted) throw new StreamTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve playback for a metadata title through the movie backend. The backend
 * matches against its catalog and, when nothing is found, scrapes a playable
 * source on demand and adds it to the platform before returning it. Only
 * confident matches play — a same-named film with a different year (or a
 * look-alike title) is never served.
 *
 * For TV series pass `options.season`/`options.episode` so the backend bakes
 * the exact episode into the returned embed URL.
 *
 * Pass `options.tmdbId` for direct resolution by TMDB ID (more reliable than
 * title/year search).
 *
 * @param title metadata title from the catalog
 * @param year release year, used to reject same-name-but-different-film matches
 * @param options episode targeting and optional TMDB ID, used for series playback
 * @throws `StreamNotFoundError` when no playable title exists, or an `Error`
 * when the backend is unreachable.
 */
export async function resolveStream(
  handle: string,
  _year?: number | null,
  options?: StreamResolveOptions
): Promise<ResolvedStream> {
  // The handle is the slug from the card (`/detail/{slug}`). The `_year` remains
  // in the signature because the details page still passes it, but it has no
  // meaning against this catalogue: the handle is the lookup key, and matching a
  // second time by year would only reject an otherwise exact title.
  const target = options?.detailPath?.trim() || handle.trim();
  if (!target) throw new StreamNotFoundError(handle || "(untitled)");

  let detail: MovieBoxDetail;
  try {
    detail = await getDetail(target);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new StreamNotFoundError(handle);
    }
    throw err;
  }

  const stream = movieFromDetail(detail);
  if (options?.mediaType) stream.media_type = options.mediaType;
  if (stream.media_type === "tv") {
    stream.season = options?.season ?? 1;
    stream.episode = options?.episode ?? 1;
  }
  return { stream, exact: true, language: null };
}

/**
 * A playable source returned by `/api/v1/playback/init` (`getStreamSource`)
 * or carried inside the resolve payload's `movie`. URLs are backend handles
 * (`/api/v1/playback/...?token=...`), never raw upstream links.
 */
export interface StreamSource {
  /** Primary playable URL, already routed through the media proxy. */
  url: string;
  /** Ordered list of candidate source URLs (primary first) for auto-cycling. */
  sources?: string[];
  /** Every quality rendition the stream endpoint reported, best first. */
  streams?: StreamVariant[];
  /** Alternate servers the player can switch between. */
  mirrors: StreamMirror[];
  /**
   * WebVTT tracks for the chosen source. Only a direct archive.org source has
   * these; an embed payload carries none.
   */
  subtitles?: StreamSubtitle[];
  /**
   * The backend's chain settled on a third-party iframe player. The client
   * renders it directly rather than requiring a "Try another source" click.
   */
  isEmbed?: boolean;
  /** Id of the provider that served this source. */
  provider?: string;
  /**
   * Base language code the backend detected for this viewer (IP plus
   * `Accept-Language`, never anything they typed). The player opens on a track
   * matching it so a viewer who speaks something other than English does not
   * have to hunt for their language on every title. Null when it could not be
   * determined. Their own pick in the audio/subtitle switchers overrides it.
   */
  language?: string | null;
}

export interface GetStreamRequest {
  /**
   * MovieBox subject id. Kept under the historical name so call sites do not
   * churn, but it is no longer a TMDB id -- the catalogue has none.
   */
  tmdbId: string;
  /** The detail slug; playback can only be resolved with both this and the id. */
  detailPath?: string;
  mediaType: "movie" | "tv";
  /** Season to target (TV only; defaults to 1 on the backend). */
  season?: number;
  /** Episode to target (TV only; defaults to 1 on the backend). */
  episode?: number;
  /**
   * Bypasses the backend's direct-source cache and forces a fresh scrape.
   * Used by the player's stream-fallback loop while it polls for a playable
   * source.
   */
  refresh?: boolean;
}

function isGetStreamPayload(value: unknown): value is {
  success: boolean;
  available?: boolean;
  movie: {
    stream_url: string;
    sources?: string[];
    mirrors?: StreamMirror[];
    subtitles?: StreamSubtitle[];
    is_embed?: boolean;
    provider?: string;
  };
  provider?: string;
  language?: string | null;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.success !== true) return false;
  const movie = record.movie;
  if (typeof movie !== "object" || movie === null) return false;
  const streamUrl = (movie as Record<string, unknown>).stream_url;
  return typeof streamUrl === "string";
}

/**
 * Stream resolution is the slowest call in the app. A Render free-tier
 * instance that has scaled to zero needs 15-20s to boot before it answers
 * `/api/v1/playback/init`, and `fetch` has no default timeout, so a cold
 * start was
 * indistinguishable from a hung request -- the resolver had no way to say "still
 * waiting" and the UI had nothing to show but the generic spinner.
 *
 * 30s clears the cold-start window while still bounding a genuinely dead
 * backend. Catalog and metadata calls are left alone: they answer in under a
 * second and a long timeout there would only delay an honest error.
 */
export const STREAM_RESOLVE_TIMEOUT_MS = 30_000;

/**
 * Budget for `/api/movies/resolve`.
 *
 * The endpoint bounds itself: the extract chain and the archive lookup run
 * concurrently under one server-side tier budget (`RESOLVE_TIER_BUDGET_SECONDS`,
 * 25s by default), so a warm answer -- stream or honest miss -- lands in
 * ~26s at the outside. What the client timeout still has to cover is the
 * instance that has scaled to zero: a cold Render boot eats 15-20s before the
 * request reaches Python at all, and a timeout shorter than that would abort
 * every first visit of the day. 30s clears the server's own budget plus boot
 * with margin, so the viewer always sees the server's honest verdict (a stream
 * or a genuine "no source") rather than a client-side cut-off masquerading as
 * one -- and a timeout thrown here is classified recoverable, so the cold-start
 * case is retried warm instead of surfacing as "unavailable".
 */
export const MOVIE_RESOLVE_TIMEOUT_MS = 30_000;

/**
 * Per-provider diagnostics when this response means "every provider failed",
 * or `null` when it means something else.
 *
 * Exhaustion is identified by its *code*, not by its status, because two
 * unrelated conditions used to share one status and the client's response to
 * them is opposite:
 *
 * - `404 PROVIDERS_EXHAUSTED` is a decision -- all six providers were walked
 *   and none could serve the title -- so re-asking only re-walks what already
 *   failed. It moved off `503` because that is also what the memory guard
 *   answers when the byte ceiling trips, and "no source exists" and "we are
 *   shedding load right now" must not be the same number.
 * - `503 RESOURCE_LIMIT_EXCEEDED` is that guard: transient by construction, so
 *   it stays retryable. Reading *every* 503 as exhaustion -- what this did
 *   before -- turned a shed request that would have cleared in ten seconds into
 *   a permanent failure for the viewer.
 *
 * A 503 naming neither still counts as exhaustion. A proxy in front of the
 * backend can replace the body with its own error page, and then the status is
 * the only evidence there is.
 */
async function readProviderExhaustion(response: Response): Promise<unknown[] | null> {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Unparseable body: only the status below can be judged.
  }

  const code = typeof body?.code === "string" ? body.code : null;
  const attempts = Array.isArray(body?.provider_attempts) ? body.provider_attempts : [];

  if (response.status === 404) {
    return code === "PROVIDERS_EXHAUSTED" ? attempts : null;
  }
  if (response.status === 503) {
    return code === "RESOURCE_LIMIT_EXCEEDED" ? null : attempts;
  }
  return null;
}

/**
 * Resolve a playable source for an already-known TMDB title through the
 * backend's `/api/v1/playback/init` endpoint (the player leg; the details
 * sheet's warm resolve reaches the same handler via the `/api/movies/resolve`
 * alias). The answer carries `movie.stream_url` (a tokenised frame or media
 * handle), the `sources`/`mirrors` lists the player can cycle, the caption
 * tracks for that source, and the viewer's detected language.
 *
 * For TV entries pass the selected `season`/`episode` so every returned leg —
 * the primary handle and every mirror — targets the exact episode picked.
 *
 * @throws `StreamTimeoutError` if the backend does not answer within
 * `STREAM_RESOLVE_TIMEOUT_MS`, which usually means a cold start rather than a
 * dead service. @throws `StreamExhaustedError` when every provider was walked
 * and none could serve the title. @throws `Error` when the backend is
 * unreachable or returns an unexpected shape.
 */
/** Map a stream source's `resolution` label onto a real pixel height. */
function heightFromResolution(resolution: unknown): number {
  if (typeof resolution === "number" && Number.isFinite(resolution)) {
    return resolution;
  }
  const label = String(resolution ?? "").toLowerCase();
  if (label.includes("8k") || label.includes("4320")) return 4320;
  if (label.includes("4k") || label.includes("2160")) return 2160;
  const match = label.match(/(\d{3,4})/);
  if (match) {
    const height = Number(match[1]);
    if (Number.isFinite(height)) return height;
  }
  if (label.includes("hd")) return 720;
  return 0;
}

/**
 * Resolve a playable source for a title, then route every media leg through the
 * API's proxy.
 *
 * Three things make this endpoint different from the catalogue calls:
 *
 * 1. It needs *both* the subject id and the detail slug. The slug keys the
 *    detail lookup; the id keys the stream lookup. A caller holding only one can
 *    still recover the other from the caches `api.ts` filled while rendering the
 *    page.
 * 2. Movies must send `se=0&ep=0`, not the endpoint's `1/1` default. A film has
 *    no season, and the default asks for one that does not exist.
 * 3. Every returned URL is a raw CDN link that the browser cannot fetch (the CDN
 *    requires the MovieBox `Referer`, which a media element cannot set), so it is
 *    wrapped in the proxy here rather than at the player.
 *
 * @throws `StreamTimeoutError` if the API does not answer within
 * `STREAM_RESOLVE_TIMEOUT_MS`. @throws `StreamExhaustedError` when the title has
 * no sources for the requested episode. @throws `Error` when the backend is
 * unreachable or returns an unexpected shape.
 */
export async function getStreamSource(
  input: GetStreamRequest
): Promise<StreamSource> {
  const handle = (input.tmdbId ?? "").trim();
  if (!handle) throw new StreamExhaustedError();

  const detailPath =
    input.detailPath?.trim() ||
    peekDetailPath(handle) ||
    (isUsableSubjectId(handle) ? await resolveDetailPath(handle) : handle);

  const subjectId = isUsableSubjectId(handle)
    ? handle
    : peekSubjectId(detailPath) || (await resolveSubjectId(detailPath));

  // Films are addressed as season 0, episode 0; the endpoint's own default is
  // 1/1, which is a season a film does not have.
  const season = input.mediaType === "tv" ? input.season ?? 1 : 0;
  const episode = input.mediaType === "tv" ? input.episode ?? 1 : 0;

  const payload = await getStreams(subjectId, detailPath, {
    season,
    episode,
    force: input.refresh === true,
  });

  const variants: StreamVariant[] = (Array.isArray(payload.sources)
    ? payload.sources
    : []
  )
    .filter(
      (source): source is typeof source & { url: string } =>
        typeof source.url === "string" && source.url.trim().length > 0
    )
    .map(source => {
      const height = heightFromResolution(source.resolution);
      const size =
        typeof source.size === "number"
          ? source.size
          : Number(source.size) || 0;
      return {
        url: proxiedVideoUrl(source.url),
        quality: qualityFromHeight(height),
        width: 0,
        height,
        size,
      };
    })
    .sort((a, b) => b.height - a.height);

  if (variants.length === 0) {
    throw new StreamExhaustedError();
  }

  const sources = Array.from(new Set(variants.map(variant => variant.url)));

  // Captions are fail-soft by construction: a title that has none, or whose
  // caption CDN is unreachable, still plays.
  const subtitles = await loadCaptionTracks(subjectId, detailPath, {
    season,
    episode,
  });

  return {
    url: sources[0],
    sources,
    streams: variants,
    mirrors: [],
    isEmbed: false,
    provider: "MovieBox",
    language: null,
    ...(subtitles.length > 0
      ? { subtitles: sanitizeSubtitles(subtitles) }
      : {}),
  };
}

export interface MovieFeeds {
  featured: StreamMovie[];
  recent: StreamMovie[];
  popular: StreamMovie[];
}

function isFeedsPayload(value: unknown): value is MovieFeeds {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.featured) &&
    Array.isArray(record.recent) &&
    Array.isArray(record.popular)
  );
}

/**
 * Fetch the shelf feeds (featured / recent / popular) from the backend. Every
 * returned title is already verified-playable, so shelves built from these can
 * stream immediately on click.
 */
export async function fetchFeeds(): Promise<MovieFeeds> {
  const sections = await homeSections();

  const featuredSections = sectionsMatching(sections, section =>
    /banner|featured/i.test(section.name)
  );
  const popularSections = sectionsMatching(sections, section =>
    /popular|trending|hot/i.test(section.name)
  );
  const recentSections = sectionsMatching(sections, section =>
    /new|recent|latest|release/i.test(section.name)
  );

  return {
    featured: flattenSections(
      featuredSections.length > 0 ? featuredSections : popularSections
    ).slice(0, 12),
    recent: flattenSections(
      recentSections.length > 0 ? recentSections : popularSections
    ).slice(0, 24),
    popular: flattenSections(popularSections).slice(0, 24),
  };
}

/** A preview trailer embed pointer returned by the movie backend. */
export interface TrailerInfo {
  provider: string;
  id: string;
  title?: string;
  /**
   * The player URL, built by the backend.
   *
   * Present when the trailer came from `/api/v1/media/trailer`, where the site
   * table and the framing check live. `resolveTrailer` prefers it over building
   * its own base so that a site the backend knows and the client does not still
   * plays, and a site neither knows is dropped before an iframe is mounted.
   *
   * It is the *base* URL with no playback parameters. Autoplay, mute, loop and
   * `enablejsapi` are per-embed decisions, so they are still appended here.
   */
  embed_url?: string;
  /** Provider thumbnail, when the provider exposes one. */
  thumb_url?: string;
}

function isTrailerPayload(value: unknown): value is { trailer?: TrailerInfo } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { trailer?: unknown };
  if (!record.trailer) return true;
  const trailer = record.trailer as { provider?: unknown; id?: unknown };
  return typeof trailer.provider === "string" && typeof trailer.id === "string";
}

/**
 * Fetch the official preview trailer for a title through the movie backend.
 * The backend consults TMDB (year-qualified) so the preview always belongs to
 * the requested film. Returns null when no trailer exists — the caller then
 * falls back to backdrop artwork on hover.
 */
export async function fetchTrailer(
  _title: string,
  _year?: number | null
): Promise<TrailerInfo | null> {
  // The catalogue's trailers are direct MP4 addresses on the MovieBox CDN, but
  // `resolveTrailer` only knows how to frame YouTube/Dailymotion/Vimeo embeds.
  // Returning null keeps the hero on its backdrop art instead of mounting an
  // iframe around a file URL it cannot play.
  return null;
}

/**
 * Fetch the ranked trailer list by TMDB ID, best candidate first.
 *
 * The backend does the ranking and the URL construction, so this is the one
 * call a title-detail view should make. It returns 200 with `trailer: null` for
 * a title with no playable upload and for an unknown id alike, which is right:
 * "nothing to show" is the useful answer either way, and a `404` would have
 * made callers distinguish an id typo from an empty catalog to produce the same
 * artwork fallback.
 */
async function fetchRankedTrailer(
  _tmdbId: string | number,
  _mediaType: "movie" | "tv"
): Promise<TrailerInfo | null> {
  return null;
}

/**
 * Fetch trailer by TMDB ID directly from TMDB via backend.
 *
 * `mediaType` defaults to `movie` to match the backend, but callers have to pass
 * the real one: a TMDB id is only meaningful against its own type, and relying
 * on the default asked for the wrong title's trailer for every series.
 *
 * Tries the ranked endpoint first and falls back to the older key-only route.
 * The fallback is not defensive busywork: the two routes are answered by
 * different functions in the same backend, and a title that resolves to nothing
 * should go unnoticed rather than taking a hover preview down with it.
 */
export async function fetchTrailerByTmdbId(
  _tmdbId: string | number,
  _mediaType: "movie" | "tv" = "movie"
): Promise<TrailerInfo | null> {
  return null;
}

/**
 * Fetch detailed episode metadata (synopsis, still, air date, etc.) from the backend.
 * The backend queries TMDB for the specific episode details.
 */
export async function fetchEpisodeDetails(
  _handle: string,
  _season: number,
  _episode: number
): Promise<StreamEpisode | null> {
  // The catalogue carries episode counts, not per-episode synopses. A null here
  // is the documented "no extra metadata" answer; the player keeps the episode
  // number and still stubs/titles the row from the detail resource.
  return null;
}

function isEpisodeDetailPayload(
  value: unknown
): value is { episode: StreamEpisode } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.episode === "object" && record.episode !== null;
}

/**
 * One `Response` for a URL, re-fetched on `429` with exponential backoff.
 *
 * The episode matrix fans out across a show's whole catalogue, and a single
 * page load used to fire dozens of `/api/episodes` calls at once -- enough to
 * trip the backend's limiter, which answers 429 and drops every in-flight
 * request. Backing off and retrying (0.5s, 1s, 2s) rides out the window
 * instead of failing the row. Non-429 responses -- including 404 and 5xx -- are
 * returned as-is so callers keep their own handling; only a genuine network
 * throw propagates. The final attempt is a bare `fetch`, so after the retries
 * are spent the caller sees the same error shape it always did.
 */
/**
 * A 429's `Retry-After`, in milliseconds, or null when the server did not say.
 *
 * The header is authoritative and the fallback is not: the resolver tier
 * refills one token per six seconds, so a fixed 0.5/1/2s backoff lands all of
 * its retries inside a single empty window and re-429s every time -- which is
 * how a viewer waiting on one title used to accumulate an abuse score meant
 * for a scraper.
 */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  retries = 3,
  delay = 500
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt >= retries) return response;
    // Honour the server's own clock where it sent one, with the exponential
    // fallback only for a 429 that arrived without the header.
    const wait = retryAfterMs(response) ?? delay * Math.pow(2, attempt);
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

export interface SearchSuggestion {
  /** Route handle (the detail slug). Never a numeric id. */
  id: string;
  /** The detail slug, when it differs from `id`. */
  detail_path?: string;
  /** MovieBox subject id, kept for playback resolution. */
  subject_id?: string;
  title: string;
  poster_url: string;
  year?: string;
  media_type: "movie" | "tv";
}

/**
 * Fetch live search autocomplete suggestions from the backend.
 */
export async function searchSuggest(
  query: string
): Promise<SearchSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2) return [];
  const suggestions = await suggestSubjects(trimmed);
  return suggestions
    .map((suggestion): SearchSuggestion | null => {
      const slug = suggestion.slug?.trim() || "";
      const subjectId = suggestion.subject_id?.trim() || "";
      const handle = slug || subjectId;
      const title = suggestion.title?.trim() || slug;
      if (!handle || !title) return null;
      return {
        id: handle,
        ...(slug ? { detail_path: slug } : {}),
        ...(subjectId ? { subject_id: subjectId } : {}),
        title,
        poster_url:
          (slug && peekPoster(slug)) ||
          suggestion.poster_url?.trim() ||
          "",
        media_type: "movie",
      };
    })
    .filter((suggestion): suggestion is SearchSuggestion => suggestion !== null);
}

function isSuggestion(value: unknown): value is SearchSuggestion {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.poster_url === "string" &&
    (record.media_type === "movie" || record.media_type === "tv")
  );
}

// Simple in-memory cache for API responses
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const apiCache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached<T>(key: string): T | null {
  const entry = apiCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    apiCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  apiCache.set(key, { data, timestamp: Date.now() });
}

/** One episode as `/api/season` returns it. */
export interface SeasonEpisode {
  season: number;
  number: number | null;
  title: string;
  overview: string;
  still_path: string;
  still_url: string;
  air_date: string;
  runtime: number | null;
  vote_average: number | null;
}

export interface SeasonPayload {
  show: {
    /** Subject id: a ~19-digit string, kept as text to avoid precision loss. */
    id: string | number;
    name: string;
    overview: string;
    poster_url: string;
    backdrop_url: string;
  };
  season: {
    number: number;
    name: string;
    episode_count: number;
    poster_url: string;
  };
  episodes: SeasonEpisode[];
}

/**
 * Shape check, not a schema check.
 *
 * The backend is the only writer of this payload and it is validated in Python
 * already; what is being caught here is the case where the response is not that
 * payload at all -- an HTML error page from a proxy, or a JSON body from a
 * different route. Rendering a shelf from `null` fields is worse than rendering
 * none, so this returns null and the shelf stays empty.
 */
function isSeasonPayload(value: unknown): value is {
  success: true;
  show: SeasonPayload["show"];
  season: SeasonPayload["season"];
  episodes: SeasonEpisode[];
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.success !== true) return false;
  if (typeof record.show !== "object" || record.show === null) return false;
  if (typeof record.season !== "object" || record.season === null) return false;
  if (!Array.isArray(record.episodes)) return false;
  const show = record.show as Record<string, unknown>;
  const season = record.season as Record<string, unknown>;
  return (
    typeof show.id === "number" &&
    typeof show.name === "string" &&
    typeof season.number === "number"
  );
}

/**
 * Fetch a show's newest aired season, or one specific season.
 *
 * Cached client-side for the same five minutes as the other catalogue calls.
 * The server holds a six-hour cache underneath keyed by the resolved season, so
 * a five-minute client cache costs one cheap request per season per five minutes
 * at worst and saves a round trip every time Home is revisited.
 *
 * A 404 is swallowed and reported as `null`: a show whose newest season cannot
 * be resolved should leave the shelf empty, not put an error toast in front of
 * someone who was only scrolling.
 */
export async function fetchSeasonDetails(
  handle: number | string,
  season?: number
): Promise<SeasonPayload | null> {
  const cacheKey = `season:${handle}:${season ?? "latest"}`;
  const cached = getCached<SeasonPayload>(cacheKey);
  if (cached) return cached;

  let detail: MovieBoxDetail;
  try {
    detail = await getDetail(String(handle));
  } catch {
    // Offline, unknown title, or a non-JSON proxy answer. A season shelf that
    // cannot be loaded should stay empty, not put an error in front of someone
    // who was only scrolling.
    return null;
  }

  const subject = detail.subject;
  const blocks = Array.isArray(detail.resource?.seasons)
    ? detail.resource.seasons
    : [];
  if (blocks.length === 0) return null;

  const targetSeason =
    season ?? blocks.reduce((max, block) => Math.max(max, block.se), 1);
  const block = blocks.find(entry => entry.se === targetSeason);
  if (!block) return null;

  const episodes: SeasonEpisode[] = Array.from(
    { length: Math.max(0, block.maxEp) },
    (_, index) => {
      const number = index + 1;
      return {
        season: targetSeason,
        number,
        title: `Episode ${number}`,
        overview: "",
        still_path: "",
        still_url: "",
        air_date: "",
        runtime: null,
        vote_average: null,
      };
    }
  );

  const payload: SeasonPayload = {
    show: {
      id: subject.subjectId,
      name: subject.title || detail.metadata?.title || "Untitled",
      overview:
        subject.description || detail.metadata?.description || "",
      poster_url: subject.cover?.url || "",
      backdrop_url: stillsUrl(subject.stills),
    },
    season: {
      number: targetSeason,
      name: `Season ${targetSeason}`,
      episode_count: block.maxEp,
      poster_url: subject.cover?.url || "",
    },
    episodes,
  };
  setCache(cacheKey, payload);
  return payload;
}

/**
 * Fetch trending movies/TV from TMDB via backend.
 * Cached for 5 minutes to avoid redundant requests.
 */
export interface TrendingParams {
  time_window?: "day" | "week";
  media_type?: "all" | "movie" | "tv";
}

export async function fetchTrending(
  params: TrendingParams = {}
): Promise<StreamMovie[]> {
  const cacheKey = `trending:${params.time_window || "week"}:${params.media_type || "all"}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const sections = await homeSections();
  const wanted = params.media_type ?? "all";
  let selected = sectionsMatching(
    sections,
    section =>
      /popular|trending|hot|banner/i.test(section.name) &&
      (wanted === "all" || section.mediaType === wanted)
  );
  // A filtered home page can easily have no "Popular Series" section at all.
  // Falling back to every series section is closer to what "trending series"
  // means than an empty shelf.
  if (selected.length === 0 && wanted !== "all") {
    selected = sectionsMatching(
      sections,
      section => section.mediaType === wanted && !/banner/i.test(section.name)
    );
  }

  const result = flattenSections(selected).slice(0, 40);
  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch popular movies/TV from TMDB via backend.
 * Cached for 5 minutes to avoid redundant requests.
 */
export interface PopularParams {
  media_type?: "movie" | "tv";
  page?: number;
}

export async function fetchPopular(
  params: PopularParams = {}
): Promise<StreamMovie[]> {
  const mediaType = params.media_type || "movie";
  const page = params.page || 1;
  const cacheKey = `popular:${mediaType}:${page}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const sections = await homeSections();
  const selected = sectionsMatching(
    sections,
    section =>
      section.mediaType === mediaType && /popular/i.test(section.name)
  );
  const all = flattenSections(
    selected.length > 0
      ? selected
      : sectionsMatching(sections, section => section.mediaType === mediaType)
  );

  // Home sections are fixed-size shelves, not a paginated catalogue. Slicing
  // them keeps page 2 honest (an empty array) instead of silently replaying
  // page 1 forever.
  const perPage = 24;
  const result = all.slice((page - 1) * perPage, page * perPage);
  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch currently playing movies from TMDB via backend.
 * Cached for 5 minutes to avoid redundant requests.
 */
export interface NowPlayingParams {
  page?: number;
}

export async function fetchNowPlaying(
  params: NowPlayingParams = {}
): Promise<StreamMovie[]> {
  const page = params.page || 1;
  const cacheKey = `now_playing:${page}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const sections = await homeSections();
  const selected = sectionsMatching(sections, section =>
    /new|recent|latest|release|banner/i.test(section.name)
  );
  const all = flattenSections(
    selected.length > 0 ? selected : sections
  ).filter(movie => movie.media_type !== "tv");

  const result = all.slice((page - 1) * 24, page * 24);
  setCache(cacheKey, result);
  return result;
}

/** A unified catalog card returned by `/api/catalog/discover`. */
export interface CatalogItem {
  /** MovieBox subject id, or the slug when an id is missing. */
  id: string;
  /** The detail slug: the route handle and the only reliable lookup key. */
  detail_path?: string;
  /** Subject id, kept under the historical name for existing call sites. */
  tmdb_id?: string | number | null;
  imdb_id?: string;
  title: string;
  media_type?: "movie" | "tv";
  year?: number | null;
  poster_url?: string;
  backdrop_url?: string;
  overview?: string;
  vote_average?: number | null;
  popularity?: number | null;
  genres?: string[];
  runtime?: number | null;
  director?: string | null;
  cast?: string[];
  country?: string | null;
  language?: string | null;
  release_date?: string | null;
  source?: string;
}

export interface DiscoverResult {
  items: CatalogItem[];
  page: number;
  per_page: number;
  total: number;
  has_more: boolean;
  source: "cache" | "live";
}

export interface DiscoverParams {
  media_type?: "movie" | "tv" | "all";
  page?: number;
  per_page?: number;
  genre?: string;
  /**
   * Session-local taste signals. The client ranks results on its own either
   * way; these are sent so the catalogue can use them if it chooses to.
   */
  affinity_genres?: string;
  affinity_people?: string;
}

function isDiscoverResult(value: unknown): value is DiscoverResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.items) &&
    typeof record.page === "number" &&
    typeof record.per_page === "number" &&
    typeof record.has_more === "boolean"
  );
}

/**
 * In-flight discover requests, keyed the same way as the result cache.
 *
 * Navigating Home -> Explore -> Vyteenda while a page is still loading used to
 * fire the same request three times: the TTL cache cannot help before the
 * first answer lands, and every component owns its own effect. Collapsing them
 * here means one walk of the catalogue is shared by every consumer.
 */
const discoverInFlight = new Map<string, Promise<DiscoverResult>>();

/**
 * Fetch a paginated, aggregated catalog page from the backend's DB-first
 * discover endpoint. The backend serves its seeded database and falls back to
 * a live multi-source aggregation (persisted) when a page isn't cached yet.
 *
 * Pages are public catalogue data, so the result is memoised for the same five
 * minutes as the TMDB shelves and concurrent callers share one request.
 */
function catalogItemFromMovie(
  movie: StreamMovie,
  section: HomeSectionView
): CatalogItem {
  return {
    id: movie.id || movie.detail_path || movie.title,
    detail_path: movie.detail_path,
    tmdb_id: movie.id,
    title: movie.title,
    media_type: movie.media_type,
    year: movie.year,
    poster_url: movie.poster_url,
    overview: movie.overview,
    vote_average: movie.vote_average,
    genres:
      movie.genres && movie.genres.length > 0
        ? movie.genres
        : section.genres,
    source: "moviebox",
  };
}

export async function fetchDiscover(
  params: DiscoverParams = {}
): Promise<DiscoverResult> {
  const page = params.page || 1;
  const perPage = params.per_page || 24;
  const mediaType = params.media_type || "movie";

  const cacheKey = [
    "discover",
    mediaType,
    page,
    perPage,
    params.genre || "",
    params.affinity_genres || "",
    params.affinity_people || "",
  ].join(":");
  const cached = getCached<DiscoverResult>(cacheKey);
  if (cached) return cached;

  const inFlight = discoverInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const request = (async (): Promise<DiscoverResult> => {
    const sections = await homeSections();

    let selected = sectionsMatching(
      sections,
      section => mediaType === "all" || section.mediaType === mediaType
    );

    // The home feed is the curated catalogue. `/movies` and `/tv-series` are
    // the raw MovieBox listing and are polluted with music videos, so genre
    // filtering happens against the section names that carry it rather than
    // against a catalog endpoint.
    if (params.genre) {
      const wanted = params.genre.trim().toLowerCase();
      const byGenre = sectionsMatching(selected, section =>
        section.genres.some(genre => genre.toLowerCase() === wanted)
      );
      if (byGenre.length > 0) selected = byGenre;
    }

    const seen = new Set<string>();
    const all: CatalogItem[] = [];
    for (const section of selected) {
      for (const movie of section.movies) {
        if (seen.has(movie.id)) continue;
        seen.add(movie.id);
        all.push(catalogItemFromMovie(movie, section));
      }
    }

    const start = (page - 1) * perPage;
    const items = all.slice(start, start + perPage);
    const result: DiscoverResult = {
      items,
      page,
      per_page: perPage,
      total: all.length,
      has_more: start + items.length < all.length,
      source: "cache",
    };
    setCache(cacheKey, result);
    return result;
  })();

  discoverInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    discoverInFlight.delete(cacheKey);
  }
}

/**
 * Fetch currently airing TV shows from TMDB via backend.
 * Cached for 5 minutes to avoid redundant requests.
 */
export interface OnTheAirParams {
  page?: number;
}

export async function fetchOnTheAir(
  params: OnTheAirParams = {}
): Promise<StreamMovie[]> {
  const page = params.page || 1;
  const cacheKey = `on_the_air:${page}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const sections = await homeSections();
  const selected = sectionsMatching(
    sections,
    section =>
      section.mediaType === "tv" &&
      /popular|series|drama|anime|airing|on air/i.test(section.name)
  );
  const all = flattenSections(
    selected.length > 0
      ? selected
      : sectionsMatching(sections, section => section.mediaType === "tv")
  );

  const result = all.slice((page - 1) * 24, page * 24);
  setCache(cacheKey, result);
  return result;
}
