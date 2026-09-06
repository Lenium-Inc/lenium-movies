import { describe, expect, it } from "vitest";
import { MetadataProviderUnavailableError, isTmdbConfigured } from "./providers/tmdb";

describe("TMDB metadata provider", () => {
  it("reports that the provider is configured with the server secret", () => {
    expect(isTmdbConfigured()).toBe(true);
    expect(new MetadataProviderUnavailableError().message).toContain("not configured");
  });
});
