import { afterEach, describe, expect, it, vi } from "vitest";

async function load(apiBase?: string, proxyBase?: string) {
  vi.resetModules();
  vi.stubEnv("VITE_STREAMVY_API_BASE_URL", apiBase as unknown as string);
  vi.stubEnv("VITE_STREAMVY_PROXY_BASE_URL", proxyBase as unknown as string);
  const api = await import("./api");
  const streamvy = await import("./streamvy");
  return { api, streamvy };
}

describe("media relay origin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the Vercel Edge relay when none is configured", async () => {
    const { api, streamvy } = await load("https://media.example.com");
    expect(streamvy.STREAMVY_PROXY_BASE_URL).toBe(
      "https://www.streamvy.me/api"
    );
    expect(
      streamvy.proxiedVideoUrl("https://cdn.example.com/a.mp4")
    ).toBe(
      "https://www.streamvy.me/api/proxy/stream?url=https%3A%2F%2Fcdn.example.com%2Fa.mp4"
    );
    expect(api.proxiedDownloadUrl("https://cdn.example.com/a.mp4", "a.mp4")).toBe(
      "https://www.streamvy.me/api/proxy/download?url=https%3A%2F%2Fcdn.example.com%2Fa.mp4&filename=a.mp4"
    );
  });

  it("routes both playback and download through a configured relay", async () => {
    const { api, streamvy } = await load(
      "https://media.example.com",
      "https://relay.example.com///"
    );
    expect(streamvy.STREAMVY_PROXY_BASE_URL).toBe("https://relay.example.com");
    expect(
      streamvy.proxiedVideoUrl("https://cdn.example.com/a.mp4")
    ).toBe(
      "https://relay.example.com/proxy/stream?url=https%3A%2F%2Fcdn.example.com%2Fa.mp4"
    );
    expect(api.proxiedDownloadUrl("https://cdn.example.com/a.mp4", "a.mp4")).toBe(
      "https://relay.example.com/proxy/download?url=https%3A%2F%2Fcdn.example.com%2Fa.mp4&filename=a.mp4"
    );
  });

  it("keeps an existing relay handle idempotent", async () => {
    const { streamvy } = await load(
      "https://media.example.com",
      "https://relay.example.com"
    );
    const handle =
      "https://relay.example.com/proxy/stream?url=https%3A%2F%2Fcdn.example.com%2Fa.mp4";
    expect(streamvy.proxiedVideoUrl(handle)).toBe(handle);
  });

  it("recognises the Edge relay handle and unwraps its target", async () => {
    const { streamvy } = await load("https://media.example.com");
    const handle =
      "https://www.streamvy.me/api/proxy/stream?url=https%3A%2F%2Fcdn.example.com%2Fa.mp4";

    expect(streamvy.isProxiedVideoUrl(handle)).toBe(true);
    expect(streamvy.proxiedVideoTarget(handle)).toBe(
      "https://cdn.example.com/a.mp4"
    );
    expect(streamvy.proxiedVideoUrl(handle)).toBe(handle);
  });
});
