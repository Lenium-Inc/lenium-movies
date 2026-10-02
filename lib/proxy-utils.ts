import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type {
  QualityOption,
  StreamQuality,
  VodTitle,
} from "@/types/stream";

const TOKEN_LIFETIME_SECONDS = 2 * 60 * 60;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
const TITLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
let cachedCatalogJson = "";
let cachedCatalog: VodTitle[] | null = null;

export class RequestInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RequestInputError";
  }
}

function encryptionKey(): Buffer {
  const secret = process.env.VOD_PROXY_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("VOD_PROXY_SECRET must contain at least 32 characters.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function configuredOrigins(): Set<string> {
  const values = (process.env.VOD_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (!values.length) {
    throw new Error("VOD_ALLOWED_ORIGINS must contain at least one origin.");
  }

  const origins = new Set<string>();
  for (const value of values) {
    const origin = new URL(value);
    const localHttp =
      process.env.NODE_ENV !== "production" &&
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(origin.hostname);
    if (origin.protocol !== "https:" && !localHttp) {
      throw new Error("VOD_ALLOWED_ORIGINS entries must use HTTPS.");
    }
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("VOD_ALLOWED_ORIGINS entries must be bare origins.");
    }
    origins.add(origin.origin);
  }
  return origins;
}

export function assertAuthorizedMediaUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RequestInputError("Media URL is invalid.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !configuredOrigins().has(url.origin)
  ) {
    throw new RequestInputError("Media origin is not authorized.", 403);
  }
  return url;
}

export function getVodCatalog(): VodTitle[] {
  const raw = process.env.VOD_CATALOG_JSON;
  if (!raw) {
    throw new Error("VOD_CATALOG_JSON is required to serve the VOD catalog.");
  }
  if (raw.length > MAX_CATALOG_BYTES) {
    throw new Error("VOD_CATALOG_JSON exceeds the 5 MB catalog limit.");
  }
  if (raw === cachedCatalogJson && cachedCatalog) return cachedCatalog;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("VOD_CATALOG_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("VOD_CATALOG_JSON must be a JSON array.");
  }

  const ids = new Set<string>();
  const catalog = parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`VOD catalog item ${index} must be an object.`);
    }
    const item = entry as Partial<VodTitle>;
    if (
      typeof item.titleId !== "string" ||
      !TITLE_ID_PATTERN.test(item.titleId) ||
      ids.has(item.titleId)
    ) {
      throw new Error(`VOD catalog item ${index} has an invalid or duplicate titleId.`);
    }
    ids.add(item.titleId);
    if (
      typeof item.title !== "string" ||
      !item.title.trim() ||
      typeof item.synopsis !== "string" ||
      !["movie", "series"].includes(String(item.kind)) ||
      !Array.isArray(item.genres) ||
      item.genres.some(genre => typeof genre !== "string") ||
      (item.cast !== undefined &&
        (!Array.isArray(item.cast) ||
          item.cast.some(person => typeof person !== "string"))) ||
      (item.year !== null &&
        item.year !== undefined &&
        (!Number.isInteger(item.year) || item.year < 1880 || item.year > 2200)) ||
      (item.rating !== null &&
        item.rating !== undefined &&
        typeof item.rating !== "string") ||
      (item.fallbackPlaylists !== undefined &&
        (!Array.isArray(item.fallbackPlaylists) ||
          item.fallbackPlaylists.some(url => typeof url !== "string"))) ||
      (item.episodes !== undefined && !Array.isArray(item.episodes)) ||
      typeof item.posterUrl !== "string" ||
      typeof item.backdropUrl !== "string" ||
      typeof item.masterPlaylist !== "string" ||
      item.distribution !== "owned_or_licensed" ||
      item.rightsVerified !== true
    ) {
      throw new Error(
        `VOD catalog item "${item.titleId}" is missing required authorization or metadata.`
      );
    }
    assertAuthorizedMediaUrl(item.masterPlaylist);
    for (const playlist of item.fallbackPlaylists ?? []) {
      assertAuthorizedMediaUrl(playlist);
    }
    if (item.downloads) {
      for (const [quality, url] of Object.entries(item.downloads)) {
        if (!["480p", "720p", "1080p"].includes(quality)) {
          throw new Error(`VOD catalog item "${item.titleId}" has an invalid download quality.`);
        }
        if (url) assertAuthorizedMediaUrl(url);
      }
    }
    for (const episode of item.episodes ?? []) {
      if (
        !Number.isInteger(episode.season) ||
        episode.season < 1 ||
        !Number.isInteger(episode.episode) ||
        episode.episode < 1 ||
        typeof episode.title !== "string" ||
        !episode.title.trim()
      ) {
        throw new Error(`VOD catalog item "${item.titleId}" has an invalid episode.`);
      }
      if (episode.playlistUrl) assertAuthorizedMediaUrl(episode.playlistUrl);
      for (const [quality, url] of Object.entries(episode.downloads ?? {})) {
        if (!["480p", "720p", "1080p"].includes(quality)) {
          throw new Error(`VOD catalog item "${item.titleId}" has an invalid episode download quality.`);
        }
        if (url) assertAuthorizedMediaUrl(url);
      }
    }
    for (const imageUrl of [item.posterUrl, item.backdropUrl]) {
      if (imageUrl) {
        let image: URL;
        try {
          image = new URL(imageUrl);
        } catch {
          throw new Error(`VOD catalog item "${item.titleId}" has an invalid image URL.`);
        }
        if (image.protocol !== "https:") {
          throw new Error(`VOD catalog item "${item.titleId}" image URL must use HTTPS.`);
        }
      }
    }
    return item as VodTitle;
  });
  cachedCatalogJson = raw;
  cachedCatalog = catalog;
  return catalog;
}

export function findVodTitle(titleId: string): VodTitle | undefined {
  if (!TITLE_ID_PATTERN.test(titleId)) return undefined;
  return getVodCatalog().find(item => item.titleId === titleId);
}

interface TokenPayload {
  url: string;
  expiresAt: number;
}

export function createProxyToken(value: string): string {
  const url = assertAuthorizedMediaUrl(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const payload: TokenPayload = {
    url: url.href,
    expiresAt: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
  };
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function readProxyToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{40,4096}$/.test(token)) {
    throw new RequestInputError("Invalid stream token.", 403);
  }
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length < 29) throw new Error("Token too short.");
    const iv = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const encrypted = bytes.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as Partial<TokenPayload>;
    if (
      typeof payload.url !== "string" ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt < Math.floor(Date.now() / 1000)
    ) {
      throw new Error("Token expired.");
    }
    return assertAuthorizedMediaUrl(payload.url).href;
  } catch (error) {
    if (error instanceof RequestInputError) throw error;
    throw new RequestInputError("Invalid or expired stream token.", 403);
  }
}

export function proxyUrl(url: string, playlist: boolean): string {
  const token = createProxyToken(url);
  const path = playlist
    ? "/api/v1/proxy/m3u8"
    : "/api/v1/proxy/segment";
  return `${path}?token=${encodeURIComponent(token)}`;
}

function parseAttributeList(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
  for (const match of value.matchAll(matcher)) {
    attributes[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return attributes;
}

function rewriteUriAttribute(
  line: string,
  base: URL,
  attribute: string,
  playlist: boolean
): string {
  const expression = new RegExp(`\\b${attribute}=(?:"([^"]+)"|([^,\\s]+))`);
  return line.replace(expression, (_whole, quoted: string, bare: string) => {
    const raw = quoted ?? bare;
    const target = new URL(raw, base);
    const rewritten = proxyUrl(target.href, playlist);
    return `${attribute}="${rewritten}"`;
  });
}

export function rewriteManifest(manifest: string, manifestUrl: string): string {
  if (Buffer.byteLength(manifest, "utf8") > MAX_MANIFEST_BYTES) {
    throw new RequestInputError("Manifest is too large.", 502);
  }
  if (!manifest.trimStart().startsWith("#EXTM3U")) {
    throw new RequestInputError("Upstream did not return an HLS manifest.", 502);
  }
  const base = assertAuthorizedMediaUrl(manifestUrl);
  let nextLineIsPlaylist = false;
  return manifest
    .split(/\r?\n/)
    .map(rawLine => {
      const line = rawLine.trim();
      if (!line) return rawLine;
      if (!line.startsWith("#")) {
        const playlist = nextLineIsPlaylist;
        nextLineIsPlaylist = false;
        return proxyUrl(new URL(line, base).href, playlist);
      }
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        nextLineIsPlaylist = true;
        return rawLine;
      }
      if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
        return rewriteUriAttribute(rawLine, base, "URI", true);
      }
      if (
        line.startsWith("#EXT-X-MEDIA:") ||
        line.startsWith("#EXT-X-KEY:") ||
        line.startsWith("#EXT-X-SESSION-KEY:") ||
        line.startsWith("#EXT-X-MAP:") ||
        line.startsWith("#EXT-X-PART:") ||
        line.startsWith("#EXT-X-PRELOAD-HINT:") ||
        line.startsWith("#EXT-X-RENDITION-REPORT:")
      ) {
        const attrs = parseAttributeList(line.slice(line.indexOf(":") + 1));
        if (!attrs.URI) return rawLine;
        const isPlaylist = line.startsWith("#EXT-X-RENDITION-REPORT:") ||
          (line.startsWith("#EXT-X-MEDIA:") && attrs.TYPE !== "SUBTITLES");
        return rewriteUriAttribute(rawLine, base, "URI", isPlaylist);
      }
      return rawLine;
    })
    .join("\n");
}

export async function readBoundedText(
  response: Response,
  maxBytes = MAX_MANIFEST_BYTES
): Promise<string> {
  if (!response.body) throw new RequestInputError("Upstream response was empty.", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestInputError("Upstream manifest is too large.", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

const QUALITY_HEIGHTS: Record<StreamQuality, number> = {
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
};

export function parseMasterQualities(
  manifest: string,
  manifestUrl: string
): QualityOption[] {
  const lines = manifest.split(/\r?\n/);
  const variants: QualityOption[] = [];
  let pending: { height: number; bandwidth: number } | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributeList(line.slice(line.indexOf(":") + 1));
      const resolution = attrs.RESOLUTION?.match(/x(\d+)/i);
      pending = {
        height: resolution ? Number(resolution[1]) : 0,
        bandwidth: Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH || 0),
      };
    } else if (line && !line.startsWith("#") && pending) {
      const height = pending.height;
      const quality: StreamQuality =
        height >= 900 ? "1080p" : height >= 600 ? "720p" : "480p";
      variants.push({
        id: `${quality}-${variants.length}`,
        label: height ? `${height}p` : quality,
        height: height || QUALITY_HEIGHTS[quality],
        bandwidth: pending.bandwidth,
        url: proxyUrl(new URL(line, manifestUrl).href, true),
      });
      pending = null;
    }
  }
  return variants
    .sort((a, b) => b.height - a.height)
    .filter((item, index, all) => all.findIndex(other => other.height === item.height) === index);
}

export function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[\x00-\x1f\x7f"\\/]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "video";
}
