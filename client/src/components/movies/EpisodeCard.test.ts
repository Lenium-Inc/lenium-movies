import { describe, expect, it } from "vitest";
import { formatAirDate } from "./EpisodeCard";

describe("formatAirDate", () => {
  // Positive is the past, negative is the future -- the direction a reader of
  // "3 days ago" expects, and the opposite of the sign the function computes
  // internally, which is exactly the confusion worth pinning in a test.
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it("says today and yesterday rather than a date", () => {
    expect(formatAirDate(daysAgo(0))).toBe("today");
    expect(formatAirDate(daysAgo(1))).toBe("yesterday");
  });

  it("counts out a recent week", () => {
    expect(formatAirDate(daysAgo(3))).toBe("3 days ago");
    expect(formatAirDate(daysAgo(7))).toBe("7 days ago");
  });

  it("handles future dates TMDB pre-dates", () => {
    expect(formatAirDate(daysAgo(-1))).toBe("tomorrow");
    expect(formatAirDate(daysAgo(-4))).toBe("in 4 days");
  });

  it("falls back to a date once it is outside the relative window", () => {
    // The point of the shelf is recency; past a week a calendar date is more
    // useful than "52 days ago", and for an old release that is the only thing
    // worth showing.
    expect(formatAirDate("1999-03-30")).not.toMatch(/ago/);
  });

  it("returns the raw value when the date will not parse", () => {
    expect(formatAirDate("not-a-date")).toBe("not-a-date");
  });
});
