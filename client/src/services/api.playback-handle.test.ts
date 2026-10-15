import { afterEach, describe, expect, it, vi } from "vitest";

const RENDER = "https://vy-e721.onrender.com";

/**
 * The backend mints every playback leg as a *relative* handle
 * (`/api/v1/playback/media?token=…`). That is correct when the SPA and the API
 * share an origin (local dev, where Vite proxies `/api`), and wrong the moment
 * they do not: in production the SPA is on Vercel and the API on Render, so a
 * relative handle resolves against Vercel, whose only `/api` answer is the SPA
 * catch-all rewrite — which serves `index.html`. The `<video>` element is then
 * handed an HTML document, hls.js is asked to parse a manifest out of markup,
 * and the download anchor navigates to the homepage.
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
  vi.stubEnv("VITE_MOVIE_API_BASE_URL", base as unknown as string);
  vi.stubEnv("VITE_API_URL", undefined as unknown as string);
  const mod = await import("./api");
  return mod.resolvePlaybackHandle;
}

describe("resolvePlaybackHandle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("absolutises a relative playback leg against the API origin", async () => {
    const resolve = await resolveWithBase(RENDER, true);
    expect(resolve("/api/v1/playback/media?token=abc")).toBe(
      `${RENDER}/api/v1/playback/media?token=abc`
    );
  });

  it("absolutises every leg the backend can mint", async () => {
    const resolve = await resolveWithBase(RENDER, true);
    for (const path of [
      "/api/v1/playback/frame?token=abc",
      "/api/v1/playback/download?token=abc",
      "/api/v1/playback/captions?token=abc",
      "/api/proxy/manifest?token=abc",
      "/api/proxy/subtitle?track=abc",
    ]) {
      expect(resolve(path)).toBe(`${RENDER}${path}`);
    }
  });

  it("leaves an absolute third-party URL untouched", async () => {
    const resolve = await resolveWithBase(RENDER, true);
    const archive = "https://archive.org/download/item/Movie_512kb.mp4";
    expect(resolve(archive)).toBe(archive);
    const embed = "https://vidsrc.me/embed/movie?tmdb=1580190";
    expect(resolve(embed)).toBe(embed);
  });

  it("is idempotent, so a double-normalised handle is not double-prefixed", async () => {
    const resolve = await resolveWithBase(RENDER, true);
    const once = resolve("/api/v1/playback/media?token=abc");
    expect(resolve(once)).toBe(once);
  });

  it("keeps the path relative when no API origin is configured (local dev)", async () => {
    // An empty base is the local-dev shape: Vite proxies `/api` to the Flask
    // process, so the handle must stay relative or the proxy is bypassed.
    const resolve = await resolveWithBase("", false);
    expect(resolve("/api/v1/playback/media?token=abc")).toBe(
      "/api/v1/playback/media?token=abc"
    );
  });

  it("does not touch a non-API relative path", async () => {
    const resolve = await resolveWithBase(RENDER, true);
    expect(resolve("/terms")).toBe("/terms");
  });
});
