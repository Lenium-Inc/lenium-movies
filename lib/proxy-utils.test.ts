import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAuthorizedMediaUrl,
  createProxyToken,
  getVodCatalog,
  parseMasterAudio,
  parseMasterQualities,
  parseMasterSubtitles,
  readProxyToken,
  RequestInputError,
  rewriteManifest,
} from "./proxy-utils";

afterEach(() => {
  vi.unstubAllEnvs();
});

function configureProxy() {
  vi.stubEnv("VOD_PROXY_SECRET", "test-only-proxy-secret-with-more-than-32-chars");
  vi.stubEnv(
    "VOD_ALLOWED_ORIGINS",
    "https://media.example.org,https://backup.example.org"
  );
  vi.stubEnv("NODE_ENV", "test");
}

describe("authorized HLS proxy utilities", () => {
  it("encrypts origin URLs in expiring proxy tokens", () => {
    configureProxy();
    const origin = "https://media.example.org/hls/title/master.m3u8";
    const token = createProxyToken(origin);

    expect(token).not.toContain("media.example.org");
    expect(readProxyToken(token)).toBe(origin);
  });

  it("rejects URLs outside the configured origin allowlist", () => {
    configureProxy();
    expect(() =>
      assertAuthorizedMediaUrl("https://untrusted.example.net/stream.m3u8")
    ).toThrowError(RequestInputError);
  });

  it("rewrites variant playlists and segments into encrypted same-origin routes", () => {
    configureProxy();
    const manifest = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720",
      "variants/720.m3u8",
      "#EXTINF:4.0,",
      "segments/00001.m4s",
      "",
    ].join("\n");

    const rewritten = rewriteManifest(
      manifest,
      "https://media.example.org/hls/title/master.m3u8"
    );
    const playlistRoute = rewritten.match(/\/api\/v1\/proxy\/m3u8\?token=([^ \n]+)/);
    const segmentRoute = rewritten.match(/\/api\/v1\/proxy\/segment\?token=([^ \n]+)/);

    expect(playlistRoute).not.toBeNull();
    expect(segmentRoute).not.toBeNull();
    expect(
      readProxyToken(decodeURIComponent(playlistRoute![1]))
    ).toBe("https://media.example.org/hls/title/variants/720.m3u8");
    expect(
      readProxyToken(decodeURIComponent(segmentRoute![1]))
    ).toBe("https://media.example.org/hls/title/segments/00001.m4s");
  });

  it("keeps audio rendition manifests on the manifest route and subtitles on the segment route", () => {
    configureProxy();
    const rewritten = rewriteManifest(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio/index.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="captions/en.vtt"',
      ].join("\n"),
      "https://media.example.org/hls/title/master.m3u8"
    );

    const routes = [...rewritten.matchAll(/\/api\/v1\/proxy\/(m3u8|segment)\?token=([^"\n]+)/g)];
    expect(routes.map(match => match[1])).toEqual(["m3u8", "segment"]);
    expect(readProxyToken(decodeURIComponent(routes[0][2]))).toContain("audio/index.m3u8");
    expect(readProxyToken(decodeURIComponent(routes[1][2]))).toContain("captions/en.vtt");
  });

  it("rejects unallowlisted origins embedded in manifests", () => {
    configureProxy();
    expect(() =>
      rewriteManifest(
        "#EXTM3U\n#EXTINF:4,\nhttps://evil.example/segment.ts",
        "https://media.example.org/hls/title/master.m3u8"
      )
    ).toThrowError(RequestInputError);
  });

  it("normalizes configured variants to sorted quality options", () => {
    configureProxy();
    const options = parseMasterQualities(
      [
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480",
        "480.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1920x1080",
        "1080.m3u8",
      ].join("\n"),
      "https://media.example.org/hls/title/master.m3u8"
    );

    expect(options.map(option => option.height)).toEqual([1080, 480]);
    expect(options[0].url).toContain("/api/v1/proxy/m3u8?token=");
  });

  it("keeps every declared rung instead of collapsing to a fixed ladder", () => {
    // A 4K release and a low-bandwidth rung both have to survive, because a
    // selector that reports both as 1080p/480p cannot offer either.
    configureProxy();
    const options = parseMasterQualities(
      [
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720",
        "720.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360",
        "360.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=18000000,RESOLUTION=3840x2160",
        "2160.m3u8",
      ].join("\n"),
      "https://media.example.org/hls/title/master.m3u8"
    );

    expect(options.map(option => option.height)).toEqual([2160, 720, 360]);
    expect(options[0].label).toBe("4K");
    expect(options[2].label).toBe("360p");
  });

  it("surfaces the English dub of a foreign-language title", () => {
    configureProxy();
    const audio = parseMasterAudio(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Korean",LANGUAGE="ko",DEFAULT=YES,URI="audio/ko.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",URI="audio/en.m3u8"',
      ].join("\n"),
      "https://media.example.org/hls/title/master.m3u8",
      "ko"
    );

    expect(audio.map(track => track.language)).toEqual(["ko", "en"]);
    expect(audio[0].isDefault).toBe(true);
    expect(audio[0].isDub).toBe(false);
    // The English rendition on a Korean title is the dub, and the URL has to be
    // a proxied playlist -- a rendition is media, not a single segment.
    expect(audio[1].isDub).toBe(true);
    expect(audio[1].url).toContain("/api/v1/proxy/m3u8?token=");
  });

  it("does not call an English original track a dub", () => {
    configureProxy();
    const audio = parseMasterAudio(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en-US",DEFAULT=YES,URI="audio/en.m3u8"',
      ].join("\n"),
      "https://media.example.org/hls/title/master.m3u8",
      "en"
    );

    expect(audio[0].isDub).toBe(false);
    expect(audio[0].channels).toBeUndefined();
  });

  it("assumes no original language rather than guessing one", () => {
    configureProxy();
    const audio = parseMasterAudio(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="eng",URI="audio/en.m3u8"',
      "https://media.example.org/hls/title/master.m3u8"
    );

    expect(audio).toHaveLength(1);
    expect(audio[0].isDub).toBe(false);
  });

  it("routes subtitle renditions through the segment route", () => {
    configureProxy();
    const tracks = parseMasterSubtitles(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English SDH",LANGUAGE="en",URI="cap/en.vtt"',
      "https://media.example.org/hls/title/master.m3u8"
    );

    expect(tracks).toHaveLength(1);
    expect(tracks[0].url).toContain("/api/v1/proxy/segment?token=");
    expect(readProxyToken(new URL(tracks[0].url, "https://x.test").searchParams.get("token")!))
      .toBe("https://media.example.org/hls/title/cap/en.vtt");
  });

  it("requires explicit verified ownership or distribution rights", () => {
    configureProxy();
    vi.stubEnv(
      "VOD_CATALOG_JSON",
      JSON.stringify([
        {
          titleId: "film-1",
          title: "Film",
          synopsis: "",
          kind: "movie",
          year: 2025,
          rating: null,
          genres: [],
          posterUrl: "",
          backdropUrl: "",
          masterPlaylist: "https://media.example.org/film/master.m3u8",
          distribution: "unknown",
          rightsVerified: false,
        },
      ])
    );

    expect(() => getVodCatalog()).toThrow(/authorization/i);
  });
});
