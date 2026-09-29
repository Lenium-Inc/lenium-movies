/**
 * Embed-failure classification tests.
 *
 * A background trailer's failure is reported cross-origin as a `postMessage`,
 * so the payload shape is the entire contract and the one thing a provider
 * change can silently break. These pin it down directly rather than through a
 * live YouTube iframe, which no unit test can stand up.
 */
import { describe, expect, it } from "vitest";
import { classifyEmbedMessage, isTrustedEmbedOrigin } from "./useEmbedFailure";

describe("fatal YouTube error codes", () => {
  // Every one of these is a real way a TMDB-listed trailer fails to embed, so
  // each must trip the backdrop fallback.
  const fatal: ReadonlyArray<readonly [number, string]> = [
    [2, "invalid player parameter"],
    [5, "HTML5 player error"],
    [100, "removed, private, or nonexistent"],
    [101, "owner disallowed embedding"],
    [150, "embed blocked by owner"],
    [153, "embedding disabled"],
  ];

  for (const [code, why] of fatal) {
    it(`treats code ${code} as fatal (${why})`, () => {
      expect(classifyEmbedMessage({ event: "onError", info: code })).toBe("failed");
    });
  }

  it("does not treat unrelated codes as fatal", () => {
    // Guards against a widened set silently unmounting healthy players.
    for (const code of [0, 1, 3, 11, 1000, -1, NaN, "100", undefined, null]) {
      expect(classifyEmbedMessage({ event: "onError", info: code })).toBe(
        "ignore",
      );
    }
  });
});

describe("healthy player traffic", () => {
  it("counts a ready event as proof of life", () => {
    expect(classifyEmbedMessage({ event: "onReady" })).toBe("alive");
  });

  it("counts state delivery as proof of life", () => {
    expect(
      classifyEmbedMessage({ event: "infoDelivery", info: { playerState: 1 } }),
    ).toBe("alive");
  });

  it("does not let chatter disarm the init watchdog", () => {
    // A payload with no event name is not a player message. If this returned
    // "alive" the watchdog would stand down for a player that never booted.
    expect(classifyEmbedMessage({ foo: "bar" })).toBe("ignore");
    expect(classifyEmbedMessage({ info: 3 })).toBe("ignore");
  });
});

describe("Dailymotion", () => {
  it("treats a video error as fatal", () => {
    expect(classifyEmbedMessage({ event: "videoError" })).toBe("failed");
  });

  it("treats the legacy type field as fatal", () => {
    expect(classifyEmbedMessage({ type: "video_error" })).toBe("failed");
  });
});

describe("malformed input", () => {
  it("ignores anything that is not a message object", () => {
    for (const junk of [null, undefined, 0, "", "onError", true, []]) {
      expect(classifyEmbedMessage(junk)).toBe("ignore");
    }
  });
});

describe("origin allowlist", () => {
  it("accepts the players we embed", () => {
    for (const origin of [
      "https://www.youtube-nocookie.com",
      "https://www.youtube.com",
      "https://www.dailymotion.com",
    ]) {
      expect(isTrustedEmbedOrigin(origin)).toBe(true);
    }
  });

  it("rejects lookalike and foreign origins", () => {
    for (const origin of [
      "https://youtube-nocookie.com.evil.test",
      "https://evil.test",
      "http://www.youtube.com",
      "https://www.youtube.com.evil.test",
      "",
    ]) {
      expect(isTrustedEmbedOrigin(origin)).toBe(false);
    }
  });
});
