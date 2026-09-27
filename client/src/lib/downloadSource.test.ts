import { describe, expect, it } from "vitest";
import {
  buildDownloadFilename,
  classifyDownloadUrl,
  downloadUnavailableReason,
  pickDownloadCandidate,
  sanitizeFilenamePart,
} from "@/lib/downloadSource";

const MP4 = "https://archive.org/download/item/Movie_512kb.mp4";
const M3U8 = "https://archive.org/download/item/master.m3u8";
const MPD = "https://archive.org/download/item/manifest.mpd";
const EMBED = "https://vidsrc.me/embed/movie?tmdb=1580190";

describe("classifyDownloadUrl", () => {
  it("treats a progressive container as saveable", () => {
    expect(classifyDownloadUrl(MP4).kind).toBe("progressive");
  });

  it("recognises alternative containers", () => {
    for (const url of [
      "https://archive.org/download/i/a.mkv",
      "https://archive.org/download/i/a.webm",
      "https://archive.org/download/i/a.m4v",
      "https://archive.org/download/i/a.mov",
    ]) {
      expect(classifyDownloadUrl(url).kind).toBe("progressive");
    }
  });

  it("refuses to call a playlist a saveable file", () => {
    // Saving an .m3u8 stores a few kilobytes of playlist, not the video.
    expect(classifyDownloadUrl(M3U8).kind).toBe("hls");
    expect(classifyDownloadUrl(MPD).kind).toBe("hls");
  });

  it("detects a third-party embed page", () => {
    expect(classifyDownloadUrl(EMBED).kind).toBe("embed");
  });

  it("matches embed subdomains", () => {
    expect(
      classifyDownloadUrl("https://player.vidsrc.cc/v2/embed/movie/1").kind
    ).toBe("embed");
  });

  it("is case-insensitive about the extension", () => {
    expect(classifyDownloadUrl("https://archive.org/download/i/A.MP4").kind).toBe(
      "progressive"
    );
    expect(classifyDownloadUrl("https://archive.org/download/i/A.M3U8").kind).toBe(
      "hls"
    );
  });

  it("ignores a query string when reading the extension", () => {
    expect(
      classifyDownloadUrl("https://archive.org/download/i/Movie.mp4?start=0").kind
    ).toBe("progressive");
  });

  it("rejects empty and malformed input", () => {
    expect(classifyDownloadUrl("").kind).toBe("unsupported");
    expect(classifyDownloadUrl(null).kind).toBe("unsupported");
    expect(classifyDownloadUrl(undefined).kind).toBe("unsupported");
    expect(classifyDownloadUrl("   ").kind).toBe("unsupported");
    expect(classifyDownloadUrl("not-a-url").kind).toBe("unsupported");
  });

  it("does not treat an extensionless path as progressive", () => {
    expect(classifyDownloadUrl("https://archive.org/download/i/stream").kind).toBe(
      "unsupported"
    );
  });
});

describe("pickDownloadCandidate", () => {
  it("prefers a progressive rendition over the primary HLS playlist", () => {
    // The primary URL is usually the playlist; taking it unconditionally would
    // make every download fail for titles that do have an mp4.
    const candidate = pickDownloadCandidate({
      title: "Movie",
      stream_url: M3U8,
      streams: [{ url: M3U8 }, { url: MP4 }],
    });
    expect(candidate.kind).toBe("progressive");
    expect(candidate.url).toBe(MP4);
  });

  it("falls back to the playlist when no file exists", () => {
    const candidate = pickDownloadCandidate({ stream_url: M3U8 });
    expect(candidate.kind).toBe("hls");
  });

  it("falls back to the embed when that is all there is", () => {
    expect(pickDownloadCandidate({ stream_url: EMBED }).kind).toBe("embed");
  });

  it("reports unsupported for an empty payload", () => {
    expect(pickDownloadCandidate(null).kind).toBe("unsupported");
    expect(pickDownloadCandidate({}).kind).toBe("unsupported");
    expect(pickDownloadCandidate({ streams: [] }).kind).toBe("unsupported");
  });

  it("skips blank stream entries", () => {
    const candidate = pickDownloadCandidate({
      stream_url: "",
      streams: [{ url: "" }, { url: null }, { url: MP4 }],
    });
    expect(candidate.kind).toBe("progressive");
  });
});

describe("sanitizeFilenamePart", () => {
  it("removes path separators and quotes", () => {
    expect(sanitizeFilenamePart('a/b\\c"d')).toBe("abcd");
  });

  it("removes control characters", () => {
    expect(sanitizeFilenamePart("a\r\nb")).toBe("ab");
  });

  it("strips leading and trailing dots and spaces", () => {
    expect(sanitizeFilenamePart("  ..name..  ")).toBe("name");
  });

  it("collapses internal whitespace", () => {
    expect(sanitizeFilenamePart("The   Matrix")).toBe("The Matrix");
  });

  it("preserves unicode and punctuation", () => {
    expect(sanitizeFilenamePart("Amélie (2001)")).toBe("Amélie (2001)");
  });
});

describe("buildDownloadFilename", () => {
  it("uses the title and year with a real container extension", () => {
    const name = buildDownloadFilename(
      { title: "The Matrix", year: 1999 },
      { kind: "progressive", url: MP4 }
    );
    expect(name).toBe("The Matrix 1999.mp4");
  });

  it("keeps an mk4/mkv source from being mislabelled as mp4", () => {
    const name = buildDownloadFilename(
      { title: "Film" },
      { kind: "progressive", url: "https://archive.org/download/i/a.mkv" }
    );
    expect(name).toBe("Film.mkv");
  });

  it("keeps the playlist extension for a non-progressive candidate", () => {
    const hls = buildDownloadFilename(
      { title: "Film", year: "2001" },
      { kind: "hls", url: M3U8 }
    );
    expect(hls).toBe("Film 2001.m3u8");
    const dash = buildDownloadFilename(
      { title: "Film" },
      { kind: "hls", url: MPD }
    );
    expect(dash).toBe("Film.mpd");
  });

  it("falls back when the title is missing or unusable", () => {
    const name = buildDownloadFilename({}, { kind: "progressive", url: MP4 });
    expect(name).toBe("video.mp4");
  });

  it("ignores a non four-digit year", () => {
    const name = buildDownloadFilename(
      { title: "Film", year: "19" },
      { kind: "progressive", url: MP4 }
    );
    expect(name).toBe("Film.mp4");
  });

  it("never leaves a path separator in the name", () => {
    const name = buildDownloadFilename(
      { title: "../../etc/passwd" },
      { kind: "progressive", url: MP4 }
    );
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });
});

describe("downloadUnavailableReason", () => {
  it("explains each distinct failure", () => {
    expect(downloadUnavailableReason({ kind: "embed", url: EMBED })).toMatch(/embed/i);
    expect(downloadUnavailableReason({ kind: "hls", url: M3U8 })).toMatch(/playlist/i);
    expect(downloadUnavailableReason({ kind: "unsupported", url: "" })).toMatch(
      /another source/i
    );
  });

  it("gives a progressive candidate no complaint copy", () => {
    // Only called for non-progressive candidates; ensure it still returns text
    // rather than undefined if a caller is careless.
    expect(typeof downloadUnavailableReason({ kind: "progressive", url: MP4 })).toBe(
      "string"
    );
  });
});
