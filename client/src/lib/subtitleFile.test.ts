import { describe, expect, it } from "vitest";
import { parseSubtitleFile } from "./subtitleFile";

const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello there.

2
00:00:03,000 --> 00:00:04,000
Second line,
wrapped.
`;

const SRT_WITHOUT_INDEX = `00:00:01,000 --> 00:00:02,000
No index line here.
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:02.500
Hello there.
`;

describe("parseSubtitleFile", () => {
  it("accepts SRT and converts commas to WebVTT periods", () => {
    const result = parseSubtitleFile("subs.srt", SRT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vtt.startsWith("WEBVTT")).toBe(true);
    expect(result.vtt).toContain("00:00:01.000 --> 00:00:02.500");
    expect(result.vtt).toContain("Hello there.");
    // Only the timing line's comma changes; text keeps its own punctuation.
    expect(result.vtt).toContain("Second line,\nwrapped.");
  });

  it("converts SRT blocks that omit the numeric index line", () => {
    const result = parseSubtitleFile("subs.srt", SRT_WITHOUT_INDEX);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vtt).toContain("No index line here.");
  });

  it("passes valid WebVTT through unchanged", () => {
    const result = parseSubtitleFile("subs.vtt", VTT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vtt).toBe(VTT);
  });

  it("strips a UTF-8 BOM and normalizes CRLF line endings", () => {
    const crlf = VTT.replace(/\n/g, "\r\n");
    const result = parseSubtitleFile("subs.vtt", `\uFEFF${crlf}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vtt.startsWith("WEBVTT")).toBe(true);
    expect(result.vtt).not.toContain("\r");
    expect(result.vtt).toBe(VTT);
  });

  it("detects the format by content, not by filename", () => {
    // An SRT body that arrived under a .vtt name still has to convert.
    const result = parseSubtitleFile("lying.vtt", SRT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vtt).toContain("00:00:01.000 --> 00:00:02.500");
  });

  it("rejects an empty file", () => {
    const result = parseSubtitleFile("empty.srt", "   \n\n  ");

    expect(result).toEqual({
      ok: false,
      reason: '"empty.srt" is empty.',
    });
  });

  it("rejects text with no cue timings at all", () => {
    const result = parseSubtitleFile(
      "novtt.vtt",
      "WEBVTT\n\nJust a paragraph of prose.\n"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no cue timings");
  });

  it("rejects a non-subtitle file that has no timing lines", () => {
    const result = parseSubtitleFile(
      "readme.txt",
      "# Project\n\nSome ordinary text.\n"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('"readme.txt"');
  });
});
