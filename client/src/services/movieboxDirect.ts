import type {
  MovieBoxCatalogPage,
  MovieBoxDetailEnvelope,
  MovieBoxHome,
  MovieBoxHomeSection,
  MovieBoxItem,
  MovieBoxSearchPayload,
} from "@/services/streamvy";

const DEFAULT_BFF_ORIGIN = "https://h5-api.aoneroom.com/wefeed-h5api-bff";
const BFF_TIMEOUT_MS = 25_000;
const DETAIL_TIMEOUT_MS = 30_000;

function envString(name: string): string {
  const env = import.meta.env as Record<string, string | boolean | undefined>;
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

const configuredOrigin = envString("VITE_MOVIEBOX_BFF_URL");

export const MOVIEBOX_BFF_BASE_URL = (
  configuredOrigin || DEFAULT_BFF_ORIGIN
).replace(/\/+$/, "");

const configuredDirect = envString("VITE_MOVIEBOX_DIRECT_BFF").toLowerCase();

export const MOVIEBOX_DIRECT_ENABLED = configuredDirect
  ? !["0", "false", "off", "no"].includes(configuredDirect)
  : Boolean(import.meta.env.PROD);

export class MovieBoxDirectError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MovieBoxDirectError";
    this.status = status;
  }
}

let bearerToken: string | null = null;
let tokenPromise: Promise<string> | null = null;

function readToken(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get("x-user");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.trim()
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

function requestHeaders(auth: boolean): Record<string, string> {
  const timezone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Dhaka"
      : "Asia/Dhaka";
  const language =
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language.split("-")[0] || "en"
      : "en";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Client-Info": JSON.stringify({ timezone }),
    "X-Request-Lang": language,
  };
  if (auth && bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return headers;
}

interface BffRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

async function bffFetchRaw(
  path: string,
  options: BffRequestOptions = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? BFF_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = requestHeaders(options.auth !== false);
    if (options.method === "POST") headers["Content-Type"] = "application/json";
    const response = await fetch(`${MOVIEBOX_BFF_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      credentials: "omit",
      signal: controller.signal,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const nextToken = readToken(response.headers);
    if (nextToken) bearerToken = nextToken;
    const raw = await response.text();
    if (!response.ok) {
      throw new MovieBoxDirectError(
        response.status,
        raw || `MovieBox request failed with status ${response.status}`
      );
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error("MovieBox answered a non-JSON body");
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `MovieBox request timed out after ${timeoutMs / 1000}s`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureToken(): Promise<string> {
  if (bearerToken) return bearerToken;
  if (!tokenPromise) {
    tokenPromise = (async () => {
      await bffFetchRaw("/home?host=moviebox.ph", { auth: false });
      if (!bearerToken) throw new Error("MovieBox did not issue a guest token");
      return bearerToken;
    })().finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

function unwrap<T>(payload: unknown, context: string): T {
  if (!payload || typeof payload !== "object") {
    throw new Error(`${context} answered an invalid payload`);
  }
  const record = payload as { code?: unknown; message?: unknown };
  if (typeof record.code === "number" && record.code !== 0) {
    throw new MovieBoxDirectError(
      record.code,
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : `${context} failed with code ${record.code}`
    );
  }
  return payload as T;
}

function isInvalidToken(err: unknown): boolean {
  return (
    err instanceof MovieBoxDirectError &&
    (err.status === 400 || err.status === 401 || err.status === 403) &&
    /invalid token/i.test(err.message)
  );
}

async function bffRequest<T>(
  path: string,
  options: BffRequestOptions & { context?: string } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const auth = options.auth !== false;
    if (auth) await ensureToken();
    try {
      const payload = await bffFetchRaw(path, options);
      return unwrap<T>(payload, options.context ?? path);
    } catch (err) {
      if (attempt === 0 && isInvalidToken(err)) {
        bearerToken = null;
        continue;
      }
      throw err;
    }
  }
}

interface RawCover {
  url?: string | null;
}

interface RawSubject {
  title?: string | null;
  cover?: RawCover | null;
  detailPath?: string | null;
  subjectId?: string | null;
  corner?: string | null;
  imdbRatingValue?: string | number | null;
  releaseDate?: string | null;
}

interface RawBannerItem {
  title?: string | null;
  image?: RawCover | null;
  detailPath?: string | null;
  subject?: RawSubject | null;
}

interface RawOperating {
  type?: string | null;
  title?: string | null;
  banner?: { items?: RawBannerItem[] | null } | null;
  subjects?: RawSubject[] | null;
}

interface RawHomeEnvelope {
  data?: { operatingList?: RawOperating[] | null } | null;
}

interface RawListEnvelope {
  data?: {
    items?: RawSubject[] | null;
    subjects?: RawSubject[] | null;
    list?: RawSubject[] | null;
    total?: number | null;
    pager?: { totalCount?: number | null } | null;
  } | null;
}

function itemFromSubject(subject: RawSubject): MovieBoxItem {
  return {
    name: subject.title ?? null,
    poster_url: subject.cover?.url ?? null,
    slug: subject.detailPath ?? null,
    subject_id: subject.subjectId ?? null,
    badge: subject.corner ?? null,
    rating: subject.imdbRatingValue ?? null,
  };
}

function catalogItemFromSubject(subject: RawSubject): MovieBoxItem {
  return {
    ...itemFromSubject(subject),
    year: subject.releaseDate
      ? subject.releaseDate.slice(0, 4)
      : null,
  };
}

function mapHome(payload: RawHomeEnvelope): MovieBoxHome {
  const sections: MovieBoxHomeSection[] = [];
  for (const op of payload.data?.operatingList ?? []) {
    if (op.type === "BANNER") {
      const items: MovieBoxItem[] = [];
      for (const item of op.banner?.items ?? []) {
        if (!item.title || /communities/i.test(item.title)) continue;
        const subject = item.subject ?? undefined;
        items.push({
          name: item.title,
          poster_url: item.image?.url ?? subject?.cover?.url ?? null,
          slug: item.detailPath ?? subject?.detailPath ?? null,
          subject_id: subject?.subjectId ?? null,
          badge: subject?.corner ?? null,
        });
      }
      sections.push({ section: "Banner", count: items.length, items });
    } else if (
      op.type === "SUBJECTS_MOVIE" ||
      op.type === "SUBJECTS_TV" ||
      op.type === "SUBJECTS_ANIMATION"
    ) {
      const items = (op.subjects ?? []).map(itemFromSubject);
      sections.push({
        section: op.title || "Featured",
        count: items.length,
        items,
      });
    }
  }
  return { status: "success", sections };
}

function mapSearch(
  payload: RawListEnvelope,
  query: string,
  page: number
): MovieBoxSearchPayload {
  const inner = payload.data ?? {};
  const raw = inner.items ?? inner.list ?? [];
  const items = raw.map(itemFromSubject);
  const total = inner.pager?.totalCount ?? inner.total ?? items.length;
  return { query, page, total, items };
}

function mapCatalog(
  payload: RawListEnvelope,
  page: number,
  perPage: number
): MovieBoxCatalogPage {
  const inner = payload.data ?? {};
  const raw = inner.items ?? inner.subjects ?? [];
  const items = raw.map(catalogItemFromSubject);
  const total = inner.pager?.totalCount ?? inner.total ?? items.length;
  return { page, per_page: perPage, total, items };
}

export async function directHome(): Promise<MovieBoxHome> {
  const payload = await bffRequest<RawHomeEnvelope>("/home?host=moviebox.ph", {
    auth: false,
    context: "Home",
  });
  return mapHome(payload);
}

export async function directSearch(
  query: string,
  page = 1
): Promise<MovieBoxSearchPayload> {
  const payload = await bffRequest<RawListEnvelope>("/subject/search", {
    method: "POST",
    body: { keyword: query, page, perPage: 20 },
    context: "Search",
  });
  return mapSearch(payload, query, page);
}

export async function directCatalog(
  kind: "movies" | "tv-series" | "animation",
  opts: { page?: number; sort?: string } = {}
): Promise<MovieBoxCatalogPage> {
  const page = opts.page ?? 1;
  const perPage = 24;
  const tabId = kind === "movies" ? 2 : kind === "tv-series" ? 5 : 8;
  const payload = await bffRequest<RawListEnvelope>("/subject/filter", {
    method: "POST",
    body: {
      tabId,
      filter: {
        sort: opts.sort ?? "RECOMMEND",
        genre: "ALL",
        country: "ALL",
        year: "ALL",
        language: "ALL",
      },
      page,
      perPage,
    },
    context:
      kind === "movies"
        ? "Movies"
        : kind === "tv-series"
          ? "TV series"
          : "Animation",
  });
  return mapCatalog(payload, page, perPage);
}

export function directDetail(slug: string): Promise<MovieBoxDetailEnvelope> {
  return bffRequest<MovieBoxDetailEnvelope>(
    `/detail?detailPath=${encodeURIComponent(slug)}`,
    { context: "Title details", timeoutMs: DETAIL_TIMEOUT_MS }
  );
}
