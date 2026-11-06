import { afterEach, describe, expect, it, vi } from "vitest";

const DEFAULT = "https://movie-api.streamvy.me";

/**
 * The media origin now comes from one variable, `VITE_STREAMVY_API_BASE_URL`.
 *
 * The old names are deliberately *not* honoured: `VITE_API_BASE_URL` still
 * exists in deployments pointing at the retired Flask/Render service, and
 * inheriting it would send every catalogue call back to an origin the operator
 * has moved off. The unconfigured build talks to the deployed product origin.
 */
async function resolveBaseUrl(
  streamvyBaseUrl: string | undefined,
  prod: boolean,
  legacyApiBaseUrl?: string
): Promise<{
  movie: string;
  fallback: boolean;
  backendFallback: boolean;
}> {
  vi.resetModules();
  vi.stubEnv("PROD", prod);
  vi.stubEnv("VITE_STREAMVY_API_BASE_URL", streamvyBaseUrl as unknown as string);
  vi.stubEnv("VITE_API_BASE_URL", legacyApiBaseUrl as unknown as string);
  const mod = await import("./api");
  return {
    movie: mod.MOVIE_API_BASE_URL,
    fallback: mod.USING_FALLBACK_BACKEND_ORIGIN,
    backendFallback: mod.USING_FALLBACK_BACKEND_ORIGIN,
  };
}

describe("MOVIE_API_BASE_URL resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses an explicitly configured media origin verbatim", async () => {
    await expect(
      resolveBaseUrl("https://media.example.com", true)
    ).resolves.toMatchObject({ movie: "https://media.example.com" });
  });

  it("strips trailing slashes so paths join without doubling", async () => {
    await expect(
      resolveBaseUrl("https://media.example.com///", true)
    ).resolves.toMatchObject({ movie: "https://media.example.com" });
  });

  it("trims surrounding whitespace from a padded value", async () => {
    await expect(
      resolveBaseUrl("  https://media.example.com/  ", true)
    ).resolves.toMatchObject({ movie: "https://media.example.com" });
  });

  it("falls back to the deployed media origin when the var is absent", async () => {
    await expect(resolveBaseUrl(undefined, true)).resolves.toMatchObject({
      movie: DEFAULT,
      fallback: true,
    });
  });

  it("falls back when the var is present but empty", async () => {
    await expect(resolveBaseUrl("", true)).resolves.toMatchObject({
      movie: DEFAULT,
      fallback: true,
    });
  });

  it("falls back when the var is only whitespace", async () => {
    await expect(resolveBaseUrl("   ", true)).resolves.toMatchObject({
      movie: DEFAULT,
      fallback: true,
    });
  });

  it("falls back in development too", async () => {
    await expect(resolveBaseUrl(undefined, false)).resolves.toMatchObject({
      movie: DEFAULT,
    });
  });

  it("ignores the retired VITE_API_BASE_URL", async () => {
    await expect(
      resolveBaseUrl(undefined, true, "https://vy-e721.onrender.com")
    ).resolves.toMatchObject({ movie: DEFAULT, fallback: true });
  });

  it("reports a configured origin as non-fallback", async () => {
    await expect(
      resolveBaseUrl("https://media.example.com", true)
    ).resolves.toMatchObject({ fallback: false, backendFallback: false });
  });
});
