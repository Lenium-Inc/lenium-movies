import { describe, expect, it } from "vitest";
import { isWebVtt, toWebVtt, toWebVttTimecode } from "./subtitles";

describe("SubRip to WebVTT conversion", () => {
  it("writes the signature and the dot timecode Chrome requires", () => {
    const vtt = toWebVtt(
      [
        "1",
        "00:00:01,500 --> 00:00:04,000",
        "First cue.",
        "",
        "2",
        "00:00:05,250 --> 00:00:07,000",
        "Second cue.",
        "",
      ].join("\n")
    );

    expect(vtt.startsWith("WEBVTT\n")).toBe(true);
    // The comma is the whole reason a SubRip file fails to parse at all.
    expect(vtt).toContain("00:00:01.500 --> 00:00:04.000");
    expect(vtt).toContain("00:00:05.250 --> 00:00:07.000");
    expect(vtt).toContain("First cue.");
    expect(vtt).toContain("Second cue.");
  });

  it("pads partial milliseconds to three digits", () => {
    expect(toWebVttTimecode("00:00:01,5")).toBe("00:00:01.500");
    expect(toWebVttTimecode("00:00:01,05")).toBe("00:00:01.050");
    expect(toWebVttTimecode("00:00:01,123")).toBe("00:00:01.123");
  });

  it("leaves an existing WebVTT track untouched", () => {
    const alreadyValid = [
      "WEBVTT",
      "",
      "NOTE this is a comment",
      "",
      "00:00:01.000 --> 00:00:02.000 line:90% align:center",
      "Already valid.",
      "",
    ].join("\n");

    expect(toWebVtt(alreadyValid)).toBe(alreadyValid);
    expect(isWebVtt(alreadyValid)).toBe(true);
  });

  it("handles CRLF bodies and a byte-order mark", () => {
    const vtt = toWebVtt(
      "﻿1\r\n00:00:02,000 --> 00:00:03,000\r\nWindows cue.\r\n"
    );

    expect(vtt.startsWith("WEBVTT\n")).toBe(true);
    expect(vtt).toContain("00:00:02.000 --> 00:00:03.000");
    expect(vtt).toContain("Windows cue.");
  });

  it("encodes bare ampersands without double-encoding existing entities", () => {
    const vtt = toWebVtt(
      "1\n00:00:01,000 --> 00:00:02,000\nTom &amp; Jerry & Co <b>fight</b>\n"
    );

    expect(vtt).toContain("Tom &amp; Jerry &amp; Co");
    expect(vtt).toContain("<b>fight</b>");
    expect(vtt).not.toContain("&amp;amp;");
  });

  it("escapes markup WebVTT cannot express", () => {
    // `<font>` is not a WebVTT tag and would be swallowed as an unknown tag,
    // taking the rest of the cue with it.
    const vtt = toWebVtt(
      '1\n00:00:01,000 --> 00:00:02,000\n<font color="red">Danger</font>\n'
    );

    expect(vtt).toContain("&lt;font color=\"red\">Danger");
  });

  it("leaves a bare number in cue text alone", () => {
    // An entity placeholder built from digits would corrupt this line.
    const vtt = toWebVtt("1\n00:00:01,000 --> 00:00:02,000\nWait 3 seconds.\n");

    expect(vtt).toContain("Wait 3 seconds.");
  });

  it("carries cue settings through the timestamp conversion", () => {
    const vtt = toWebVtt(
      "1\n00:00:01,000 --> 00:00:02,000 position:50% align:middle\nPositioned.\n"
    );

    expect(vtt).toContain("00:00:01.000 --> 00:00:02.000 position:50% align:middle");
  });

  it("drops blocks with no usable timing line", () => {
    const vtt = toWebVtt(
      [
        "WEBHDR",
        "some stray preamble",
        "",
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "Good cue.",
        "",
      ].join("\n")
    );

    expect(vtt).toContain("Good cue.");
    expect(vtt).not.toContain("stray preamble");
  });

  it("ends with exactly one newline so no empty cue is appended", () => {
    const vtt = toWebVtt("1\n00:00:01,000 --> 00:00:02,000\nOnly.\n\n\n");

    expect(vtt.endsWith("Only.\n")).toBe(true);
  });
});