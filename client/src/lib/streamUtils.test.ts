import { describe, expect, it } from "vitest";
import { EMBED_HOSTS } from "./embedSources";
import {
  EXTERNAL_EMBED_HOSTS,
  directStreamRank,
  getStreamType,
  isEmbedSourceUrl,
  isExternalEmbedUrl,
  isFrameHandle,
  orderDirectStreams,
} from "./streamUtils";

const FRAME_HANDLE = "/api/v1/playback/frame?token=opaque";
const MEDIA_HANDLE = "/api/v1/playback/media?token=opaque";
const MANIFEST_HANDLE = "/api/proxy/manifest?token=opaque";

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

  it("is exactly the provider manifest, with nothing bolted on", () => {
    // The hand-list that used to sit beside this -- a dozen provider hosts the
    // backend manifest does not declare, kept "in case a cached payload still
    // carried one" -- was a second, drifting copy of what may be framed.
    // `embedSources.test.ts` pins `EMBED_HOSTS` to the Python manifest, so
    // pinning this to `EMBED_HOSTS` transitively forbids every non-manifest
    // host from ever being admitted back.
    expect(EXTERNAL_EMBED_HOSTS).toEqual(EMBED_HOSTS);

    for (const host of [
      "embed.not-a-provider.test",
      "player.not-a-provider.test",
      "archive.org",
    ]) {
      expect(isExternalEmbedUrl(`https://${host}/embed/movie/1`)).toBe(false);
    }
  });
});

describe("tokenised playback handles", () => {
  it("recognises the frame handle as an embed", () => {
    expect(isFrameHandle(FRAME_HANDLE)).toBe(true);
    expect(isFrameHandle("https://vy.example/api/v1/playback/frame?token=x")).toBe(
      true
    );
    expect(isEmbedSourceUrl(FRAME_HANDLE)).toBe(true);
    expect(getStreamType(FRAME_HANDLE)).toBe("embed");
  });

  it("keeps the two direct relays out of the embed set", () => {
    // Feeding either of these to an <iframe> instead of <video> is the exact
    // failure the old host allowlist could not catch: they have no host at all.
    expect(isFrameHandle(MEDIA_HANDLE)).toBe(false);
    expect(isEmbedSourceUrl(MEDIA_HANDLE)).toBe(false);
    expect(getStreamType(MEDIA_HANDLE)).toBe("mp4");
    expect(getStreamType(MANIFEST_HANDLE)).toBe("hls");
  });

  it("still reads a raw provider URL as an embed", () => {
    expect(isEmbedSourceUrl("https://vidsrc.pro/embed/movie/603")).toBe(true);
    expect(getStreamType("https://vidsrc.pro/embed/movie/603")).toBe("embed");
  });

  it("does not mistake an arbitrary path for a handle", () => {
    expect(isFrameHandle("/api/v1/playback/framee?token=x")).toBe(false);
    expect(isFrameHandle("/watch/603")).toBe(false);
    expect(isFrameHandle(null)).toBe(false);
  });
});

describe("directStreamRank", () => {
  it("puts HLS ahead of every other candidate", () => {
    expect(directStreamRank("https://cdn.example.com/master.m3u8")).toBe(0);
    expect(directStreamRank("https://cdn.example.com/movie.mp4")).toBe(1);
    expect(directStreamRank("https://cdn.example.com/movie.mpd")).toBe(1);
  });

  it("ranks the backend's own relays by what they actually carry", () => {
    expect(directStreamRank(MANIFEST_HANDLE)).toBe(0);
    expect(directStreamRank(MEDIA_HANDLE)).toBe(1);
    expect(directStreamRank(FRAME_HANDLE)).toBe(2);
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

  it("never puts a frame handle ahead of a real media file", () => {
    expect(
      orderDirectStreams([FRAME_HANDLE, "/api/v1/playback/media?token=x"])
    ).toEqual(["/api/v1/playback/media?token=x", FRAME_HANDLE]);
  });
});

describe("getStreamType", () => {
  it("reports embed hosts as embeds even without a media extension", () => {
    expect(getStreamType("https://vidsrc.to/embed/movie?tmdb=1")).toBe("embed");
    expect(getStreamType("https://cdn.example.com/master.m3u8")).toBe("hls");
  });
});

