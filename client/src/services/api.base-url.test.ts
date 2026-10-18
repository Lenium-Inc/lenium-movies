import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LOCAL = "http://127.0.0.1:8001";

/**
 * These cover the resolution order: the canonical VITE_API_BASE_URL, the two
 * legacy names behind it, and the built-in local default that replaces both
 * an absent variable and one that is present but blank (the shape
 * .env.example ships, which looks configured in a dashboard but is not a URL).
 */
async function resolveBaseUrl(
  apiBaseUrl: string | undefined,
  prod: boolean,
  legacyBaseUrl?: string,
  apiUrlVar?: string
): Promise<string> {
  vi.resetModules();
  vi.stubEnv("PROD", prod);
  vi.stubEnv("VITE_API_BASE_URL", apiBaseUrl as unknown as string);
  vi.stubEnv(
    "VITE_MOVIE_API_BASE_URL",
    legacyBaseUrl as unknown as string
  );
  vi.stubEnv("VITE_API_URL", apiUrlVar as unknown as string);
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

  it("falls back to the local FastAPI address when the var is absent", async () => {
    await expect(resolveBaseUrl(undefined, true)).resolves.toBe(LOCAL);
  });

  it("falls back when the var is present but empty", async () => {
    await expect(resolveBaseUrl("", true)).resolves.toBe(LOCAL);
  });

  it("falls back when the var is only whitespace", async () => {
    await expect(resolveBaseUrl("   ", true)).resolves.toBe(LOCAL);
  });

  it("falls back to the same local address in development", async () => {
    await expect(resolveBaseUrl(undefined, false)).resolves.toBe(LOCAL);
    await expect(resolveBaseUrl("", false)).resolves.toBe(LOCAL);
  });

  it("lets a configured origin win in development too", async () => {
    await expect(
      resolveBaseUrl("http://127.0.0.1:8001", false)
    ).resolves.toBe("http://127.0.0.1:8001");
  });

  it("prefers VITE_API_BASE_URL over the legacy VITE_MOVIE_API_BASE_URL", async () => {
    await expect(
      resolveBaseUrl(
        "https://canonical.example.com",
        true,
        "https://legacy.example.com"
      )
    ).resolves.toBe("https://canonical.example.com");
  });

  it("honours the legacy VITE_MOVIE_API_BASE_URL when the canonical var is blank", async () => {
    await expect(
      resolveBaseUrl("", true, "https://legacy.example.com")
    ).resolves.toBe("https://legacy.example.com");
  });

  it("honours VITE_API_URL when both newer vars are blank", async () => {
    await expect(
      resolveBaseUrl("", true, "", "https://legacy.example.com")
    ).resolves.toBe("https://legacy.example.com");
  });
});

describe("fallback origin reporting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stays silent when an unconfigured build uses the hardcoded default", async () => {
    // The fallback used to log a paragraph on every build shipped without the
    // variable. It is now reported only through the flag below, so the
    // console keeps quiet.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveBaseUrl("", true, "", "")).resolves.toBe(LOCAL);
    expect(warn).not.toHaveBeenCalled();
  });

  it("flags the default when no origin is configured, in either mode", async () => {
    for (const prod of [true, false]) {
      vi.resetModules();
      vi.stubEnv("PROD", prod);
      vi.stubEnv("VITE_API_BASE_URL", "");
      vi.stubEnv("VITE_MOVIE_API_BASE_URL", "");
      vi.stubEnv("VITE_API_URL", "");
      const mod = await import("./api");
      expect(mod.MOVIE_API_BASE_URL).toBe(LOCAL);
      expect(mod.USING_FALLBACK_BACKEND_ORIGIN).toBe(true);
    }
  });

  it("keeps the flag false when an origin is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_API_BASE_URL", "https://backend.example.com");
    const mod = await import("./api");
    expect(mod.USING_FALLBACK_BACKEND_ORIGIN).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
