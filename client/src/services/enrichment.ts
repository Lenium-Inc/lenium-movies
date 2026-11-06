/**
 * The build-time metadata layer: TMDB enrichment, keyed by Streamvy subject id.
 *
 * Why this exists
 * ---------------
 * The catalogue that serves playback is headless and thin. `/detail` answers
 * fifteen keys and no artwork beyond a portrait cover; `/home` is the only
 * endpoint with a synopsis, and its landscape `stills` field is empty in every
 * response (measured across 340 subjects: zero populated). So a title page
 * built from the media API alone has no backdrop, no director, no cast and no
 * runtime.
 *
 * The missing half is TMDB's, but the browser must not ask for it.
 * `docs/metadata-provider.md` records that the API key never reaches a `VITE_*`
 * variable, `docs/security.md` notes that a committed key literal was
 * deliberately removed once already, and `scripts/check_secrets.py` flags the
 * exact `*_API_KEY` shape a client-side variable would create. The SPA also
 * deploys statically (`vercel.json`), so there is no server to keep a secret
 * on the request path.
 *
 * What this module loads instead is a snapshot: `scripts/export_streamvy_catalog.py`
 * crawls the media API, resolves each title against TMDB offline, and writes
 * `client/public/data/streamvy-catalog.json`. The browser fetches that file and
 * indexes it. One request, no key, no rate limit, no runtime join.
 *
 * Everything here is fail-soft. A missing file, a 404 from the SPA rewrite, a
 * truncated payload or an id that was never exported all resolve to `null`, so
 * a stale or absent snapshot degrades to Streamvy's own cover rather than
 * blanking a page.
 */

/** The trailer TMDB named, when the exporter found a framable one. */
export interface EnrichmentTrailer {
  /** `"YouTube"` | `"Vimeo"` | `"Dailymotion"`. */
  site: string;
  key: string;
  /** `"Trailer"` | `"Teaser"` | ... */
  type: string;
}

/**
 * A native MP4 trailer served by the media API itself.
 *
 * 92% of `/home` subjects carry one, all on `macdn.aoneroom.com` -- the single
 * CDN the API's video proxy can relay. This beats the TMDB embed where both
 * exist: a `<video>` needs no iframe, no embed origin, no CSP allowance and no
 * postMessage handshake.
 */
export interface NativeTrailer {
  url: string;
  cover: string | null;
}

export interface SimilarSeed {
  tmdb_id: string;
  title: string;
  year: number | null;
  media_type: "movie" | "tv";
  poster_url: string | null;
  backdrop_url: string | null;
  vote_average: number | null;
}

/** One exported title's enrichment record. */
export interface EnrichmentRecord {
  tmdb_id: string;
  title: string;
  year: number | null;
  media_type: "movie" | "tv";
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  /** 0-10. */
  vote_average: number | null;
  /** Minutes. */
  runtime: number | null;
  director: string | null;
  cast: string[];
  country: string | null;
  language: string | null;
  imdb_id: string | null;
  trailer: EnrichmentTrailer | null;
  native_trailer: NativeTrailer | null;
  similar: SimilarSeed[];
}

interface ExportFile {
  generated_at?: string;
  count?: number;
  items?: Record<string, EnrichmentRecord>;
}

/**
 * Where the snapshot is served from.
 *
 * A *runtime* fetch rather than an import. Importing it would splice the whole
 * catalogue into the JS bundle -- hundreds of kilobytes of synopsis text for a
 * title the viewer may never open -- and it would make a missing export a
 * build failure instead of a graceful degradation. Served from `public/`, it
 * is one request, cacheable, and a 404 costs nothing.
 */
const SNAPSHOT_PATH = "/data/streamvy-catalog.json";

let snapshot: Record<string, EnrichmentRecord> | null = null;
let pending: Promise<Record<string, EnrichmentRecord>> | null = null;

function emptySnapshot(): Record<string, EnrichmentRecord> {
  return {};
}

async function loadSnapshot(): Promise<Record<string, EnrichmentRecord>> {
  if (snapshot) return snapshot;
  if (pending) return pending;

  pending = (async () => {
    try {
      const response = await fetch(SNAPSHOT_PATH, { method: "GET" });
      if (!response.ok) return emptySnapshot();
      const payload: ExportFile | null = await response.json();
      const items = payload?.items;
      if (!items || typeof items !== "object") return emptySnapshot();
      snapshot = items as Record<string, EnrichmentRecord>;
      return snapshot;
    } catch {
      // Offline, aborted, or a body that is not JSON. The catalogue is still
      // browsable and playable without this; only the enrichment is gone.
      return emptySnapshot();
    } finally {
      pending = null;
    }
  })();

  return pending;
}

/**
 * The enrichment for a Streamvy subject id, or null when it was never exported.
 *
 * Lookups are by subject id alone -- the app's routes already carry it, and
 * resolving it through a title search would reintroduce exactly the join this
 * snapshot exists to avoid.
 */
export async function lookupEnrichment(
  subjectId: string | number | null | undefined
): Promise<EnrichmentRecord | null> {
  const key = subjectId == null ? "" : String(subjectId).trim();
  if (!key) return null;
  const items = await loadSnapshot();
  return items[key] ?? null;
}

/** Sync variant for callers that already awaited `loadSnapshot`. */
export function peekEnrichment(
  subjectId: string | number | null | undefined
): EnrichmentRecord | null {
  if (!snapshot) return null;
  const key = subjectId == null ? "" : String(subjectId).trim();
  return key ? snapshot[key] ?? null : null;
}

/**
 * Force the snapshot to load.
 *
 * The home feed calls this once on mount so that the first title click does
 * not pay for the fetch, and so backdrops land in the same paint as the cards
 * rather than one round trip behind them.
 */
export function warmEnrichment(): Promise<Record<string, EnrichmentRecord>> {
  return loadSnapshot();
}

/**
 * Normalise a title for matching.
 *
 * The media API decorates its catalogue freely -- `"Black Clover [English]"`,
 * `"Boys Over Flowers (2022)"` -- so the decorations are stripped and the
 * remainder is case- and punctuation-folded. This is the same normalisation the
 * exporter applies, which is the only reason the two agree.
 */
export function normalizeTitleForMatch(title: string): string {
  return title
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Neighbouring titles for a "More Like This" wall, matched by title+year.
 *
 * The media API has no recommendations endpoint and no id shared with TMDB, so
 * the wall is seeded by genre shelves (`fetchDiscover`) and the neighbours
 * returned here fill in what a genre query cannot: titles that are actually
 * the same programme. Falls back to an empty array when the snapshot is absent.
 */
export function findSimilarByTitle(
  title: string,
  year: number | null,
  mediaType: "movie" | "tv",
  limit = 12
): SimilarSeed[] {
  if (!snapshot) return [];
  const needle = normalizeTitleForMatch(title);
  if (!needle) return [];

  const scored: { seed: SimilarSeed; score: number }[] = [];
  for (const record of Object.values(snapshot)) {
    if (!record || record.media_type !== mediaType) continue;
    const candidate = normalizeTitleForMatch(record.title || "");
    if (!candidate) continue;
    if (candidate !== needle) continue;
    // Same programme; a year match separates a remake from the original.
    const yearMatch =
      year != null && record.year != null && Math.abs(record.year - year) <= 1;
    scored.push({
      seed: {
        tmdb_id: record.tmdb_id,
        title: record.title,
        year: record.year,
        media_type: record.media_type,
        poster_url: record.poster_url,
        backdrop_url: record.backdrop_url,
        vote_average: record.vote_average,
      },
      score: yearMatch ? 2 : 1,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.seed);
}
