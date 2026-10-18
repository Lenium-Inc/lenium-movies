import { afterEach, describe, expect, it, vi } from "vitest";

const API_ORIGIN = "https://backend.example.com";
const LOCAL = "http://127.0.0.1:8001";

/**
 * The backend mints playback legs as *relative* handles
 * (`/api/v1/playback/media?token=…`). That is correct only when the SPA and
 * the API share an origin; the moment they do not, a relative handle resolves
 * against the frontend host, whose only `/api` answer is the SPA catch-all
 * rewrite — which serves `index.html`. The `<video>` element is then handed an
 * HTML document, hls.js is asked to parse a manifest out of markup, and the
 * download anchor navigates to the homepage.
 *
 * These pin the absolutisation that fixes it, plus the two invariants that keep
 * it safe: absolute third-party URLs are untouched, and the rewrite is
 * idempotent.
 */
async function resolveWithBase(
  base: string | undefined,
  prod: boolean
): Promise<(url: string) => string> {
  vi.resetModules();
  vi.stubEnv("PROD", prod);
  vi.stubEnv("VITE_API_BASE_URL", base as unknown as string);
  vi.stubEnv("VITE_MOVIE_API_BASE_URL", undefined as unknown as string);
  vi.stubEnv("VITE_API_URL", undefined as unknown as string);
  const mod = await import("./api");
  return mod.resolvePlaybackHandle;
}

describe("resolvePlaybackHandle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("absolutises a relative playback leg against the API origin", async () => {
    const resolve = await resolveWithBase(API_ORIGIN, true);
    expect(resolve("/api/v1/playback/media?token=abc")).toBe(
      `${API_ORIGIN}/api/v1/playback/media?token=abc`
    );
  });

  it("absolutises every leg the backend can mint", async () => {
    const resolve = await resolveWithBase(API_ORIGIN, true);
    for (const path of [
      "/api/v1/playback/frame?token=abc",
      "/api/v1/playback/download?token=abc",
      "/api/v1/playback/captions?token=abc",
      "/api/proxy/manifest?token=abc",
      "/api/proxy/subtitle?track=abc",
    ]) {
      expect(resolve(path)).toBe(`${API_ORIGIN}${path}`);
    }
  });

  it("leaves an absolute third-party URL untouched", async () => {
    const resolve = await resolveWithBase(API_ORIGIN, true);
    const archive = "https://archive.org/download/item/Movie_512kb.mp4";
    expect(resolve(archive)).toBe(archive);
    const embed = "https://vidsrc.me/embed/movie?tmdb=1580190";
    expect(resolve(embed)).toBe(embed);
  });

  it("is idempotent, so a double-normalised handle is not double-prefixed", async () => {
    const resolve = await resolveWithBase(API_ORIGIN, true);
    const once = resolve("/api/v1/playback/media?token=abc");
    expect(resolve(once)).toBe(once);
  });

  it("absolutises against the local FastAPI default when nothing is configured", async () => {
    const resolve = await resolveWithBase(undefined, false);
    expect(resolve("/api/v1/playback/media?token=abc")).toBe(
      `${LOCAL}/api/v1/playback/media?token=abc`
    );
  });

  it("does not touch a non-API relative path", async () => {
    const resolve = await resolveWithBase(API_ORIGIN, true);
    expect(resolve("/terms")).toBe("/terms");
  });
});
