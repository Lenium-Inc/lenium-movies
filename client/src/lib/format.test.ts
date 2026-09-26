import { describe, expect, it } from "vitest";
import { formatPlayerTime, formatRuntime } from "./format";

describe("formatRuntime", () => {
  it("renders minutes under an hour with an m suffix", () => {
    expect(formatRuntime(26)).toBe("26m");
    expect(formatRuntime(59)).toBe("59m");
  });

  it("splits into hours and minutes", () => {
    expect(formatRuntime(86)).toBe("1h 26m");
    expect(formatRuntime(140)).toBe("2h 20m");
  });

  it("drops a zero minute remainder", () => {
    expect(formatRuntime(120)).toBe("2h");
    expect(formatRuntime(180)).toBe("3h");
  });

  it("accepts a string that already carries an m suffix", () => {
    expect(formatRuntime("86m")).toBe("1h 26m");
    expect(formatRuntime("26m")).toBe("26m");
  });

  it("returns an empty string for missing or unusable input", () => {
    expect(formatRuntime(null)).toBe("");
    expect(formatRuntime(undefined)).toBe("");
    expect(formatRuntime("")).toBe("");
    expect(formatRuntime(0)).toBe("");
    expect(formatRuntime(-5)).toBe("");
    expect(formatRuntime("abc")).toBe("");
  });
});

describe("formatPlayerTime", () => {
  it("renders MM:SS under an hour", () => {
    expect(formatPlayerTime(0)).toBe("00:00");
    expect(formatPlayerTime(9)).toBe("00:09");
    expect(formatPlayerTime(65)).toBe("01:05");
  });

  it("adds an unpadded hour segment past 60 minutes", () => {
    // 85:57 as minutes:seconds is 5157 seconds.
    expect(formatPlayerTime(5157)).toBe("1:25:57");
  });

  it("keeps two-digit hours intact", () => {
    expect(formatPlayerTime(36000)).toBe("10:00:00");
  });

  it("clamps negative and non-finite input", () => {
    expect(formatPlayerTime(-1)).toBe("00:00");
    expect(formatPlayerTime(NaN)).toBe("00:00");
    expect(formatPlayerTime(Infinity)).toBe("00:00");
  });

  it("truncates fractional seconds rather than rounding up", () => {
    expect(formatPlayerTime(65.9)).toBe("01:05");
  });
});
