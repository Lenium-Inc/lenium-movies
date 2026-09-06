import { describe, expect, it } from "vitest";
import {
  getPlaybackUnavailableState,
  PLAYBACK_UNAVAILABLE_MESSAGE,
} from "../shared/playback";

describe("playback availability", () => {
  it("never reports playback as available without a configured provider", () => {
    expect(getPlaybackUnavailableState()).toEqual({
      available: false,
      reason: "provider_not_configured",
      message: PLAYBACK_UNAVAILABLE_MESSAGE,
    });
  });
});
