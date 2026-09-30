import { describe, expect, it } from "vitest";
import {
  directStreamRank,
  getStreamType,
  isExternalEmbedUrl,
  orderDirectStreams,
} from "./streamUtils";

describe("isExternalEmbedUrl", () => {
  it("matches registry hosts and their subdomains", () => {
    expect(isExternalEmbedUrl("https://vidsrc.to/embed/movie?tmdb=1")).toBe(true);
    expect(isExternalEmbedUrl("https://m.vidsrc.to/embed/movie")).toBe(true);
  });

  it("leaves media hosts alone", () => {
    expect(isExternalEmbedUrl("https://archive.org/download/x/master.m3u8")).toBe(
      false
    );
    expect(isExternalEmbedUrl("")).toBe(false);
    expect(isExternalEmbedUrl(null)).toBe(false);
  });
});

describe("directStreamRank", () => {
  it("puts HLS ahead of every other candidate", () => {
    expect(directStreamRank("https://cdn.example.com/master.m3u8")).toBe(0);
    expect(directStreamRank("https://cdn.example.com/movie.mp4")).toBe(1);
    expect(directStreamRank("https://cdn.example.com/movie.mpd")).toBe(1);
  });

  it("demotes URLs that are neither a known embed host nor a media file", () => {
    expect(directStreamRank("https://unknown-host.example.com/watch/page")).toBe(2);
    expect(directStreamRank("not a url")).toBe(2);
  });
});

describe("orderDirectStreams", () => {
  it("plays backend HLS first, ahead of a raw third-party player page", () => {
    const resolverOrder = [
      "https://unknown-host.example.com/play",
      "https://archive.org/download/item/master.m3u8",
      "https://cdn.example.com/movie.mp4",
    ];

    expect(orderDirectStreams(resolverOrder)).toEqual([
      "https://archive.org/download/item/master.m3u8",
      "https://cdn.example.com/movie.mp4",
      "https://unknown-host.example.com/play",
    ]);
  });

  it("keeps resolver order inside a tier", () => {
    const resolverOrder = [
      "https://cdn.example.com/first.mp4",
      "https://cdn.example.com/second.mp4",
    ];

    expect(orderDirectStreams(resolverOrder)).toEqual(resolverOrder);
  });

  it("keeps unclassifiable candidates, demoted rather than dropped", () => {
    const resolverOrder = [
      "https://a.example.com/watch.php",
      "https://a.example.com/movie.mp4",
    ];

    expect(orderDirectStreams(resolverOrder)).toEqual([
      "https://a.example.com/movie.mp4",
      "https://a.example.com/watch.php",
    ]);
  });
});

describe("getStreamType", () => {
  it("reports embed hosts as embeds even without a media extension", () => {
    expect(getStreamType("https://vidsrc.to/embed/movie?tmdb=1")).toBe("embed");
    expect(getStreamType("https://cdn.example.com/master.m3u8")).toBe("hls");
  });
});
