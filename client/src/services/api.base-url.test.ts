import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RENDER = "https://vy-e721.onrender.com";

/**
 * The deployed SPA hosts no API, so every call needs an absolute origin. These
 * cover the resolution order plus the two failure modes that shipped a broken
 * build: a variable that is absent, and one that is present but blank, which
 * looks configured in a dashboard but is not a URL.
 */
async function resolveBaseUrl(
  movieApiBaseUrl: string | undefined,
  prod: boolean
): Promise<string> {
  vi.resetModules();
  vi.stubEnv("PROD", prod);
  vi.stubEnv("VITE_MOVIE_API_BASE_URL", movieApiBaseUrl as unknown as string);
  vi.stubEnv("VITE_API_URL", undefined as unknown as string);
  const mod = await import("./api");
  return mod.MOVIE_API_BASE_URL;
}

describe("MOVIE_API_BASE_URL resolution", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses an explicitly configured origin verbatim", async () => {
    await expect(
      resolveBaseUrl("https://backend.example.com", true)
    ).resolves.toBe("https://backend.example.com");
  });

  it("strips trailing slashes so paths join without doubling", async () => {
    await expect(
      resolveBaseUrl("https://backend.example.com///", true)
    ).resolves.toBe("https://backend.example.com");
  });

  it("trims surrounding whitespace from a padded value", async () => {
    await expect(
      resolveBaseUrl("  https://backend.example.com/  ", true)
    ).resolves.toBe("https://backend.example.com");
  });

  it("falls back to the deployed backend in production when the var is absent", async () => {
    await expect(resolveBaseUrl(undefined, true)).resolves.toBe(RENDER);
  });

  it("falls back in production when the var is present but empty", async () => {
    await expect(resolveBaseUrl("", true)).resolves.toBe(RENDER);
  });

  it("falls back in production when the var is only whitespace", async () => {
    await expect(resolveBaseUrl("   ", true)).resolves.toBe(RENDER);
  });

  it("stays relative in development, where Vite proxies /api to localhost", async () => {
    await expect(resolveBaseUrl(undefined, false)).resolves.toBe("");
    await expect(resolveBaseUrl("", false)).resolves.toBe("");
  });

  it("lets a configured origin win in development too", async () => {
    await expect(
      resolveBaseUrl("http://127.0.0.1:5000", false)
    ).resolves.toBe("http://127.0.0.1:5000");
  });

  it("honours VITE_API_URL when the primary var is blank", async () => {
    vi.resetModules();
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "");
    vi.stubEnv("VITE_API_URL", "https://legacy.example.com");
    const mod = await import("./api");
    expect(mod.MOVIE_API_BASE_URL).toBe("https://legacy.example.com");
  });
});

describe("fallback origin warning", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("warns when production silently uses the hardcoded fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "");
    vi.stubEnv("VITE_API_URL", undefined as unknown as string);
    await import("./api");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain(RENDER);
  });

  it("stays quiet when an origin is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "https://backend.example.com");
    vi.stubEnv("VITE_API_URL", undefined as unknown as string);
    await import("./api");
    expect(warn).not.toHaveBeenCalled();
  });
});
