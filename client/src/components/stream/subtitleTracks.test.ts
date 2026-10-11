import { describe, expect, it } from "vitest";
import {
  sanitizeSubtitles,
  subtitleTrackUrl,
  type StreamSubtitle,
} from "@/services/api";
import { buildSubtitleTracks } from "@/components/stream/VideoPlayer";

const RAW = "https://archive.org/download/item/Movie_eng.vtt";

describe("sanitizeSubtitles", () => {
  it("keeps a well-formed descriptor", () => {
    expect(sanitizeSubtitles([{ label: "English", lang: "eng", url: RAW }])).toEqual([
      { label: "English", lang: "eng", url: RAW },
    ]);
  });

  it("returns nothing for a missing or non-array field", () => {
    expect(sanitizeSubtitles(undefined)).toEqual([]);
    expect(sanitizeSubtitles(null)).toEqual([]);
    expect(sanitizeSubtitles("nope")).toEqual([]);
    expect(sanitizeSubtitles({})).toEqual([]);
  });

  it("drops a descriptor with no url", () => {
    // A track with no src is a dead menu row, not a working option.
    expect(sanitizeSubtitles([{ label: "English", lang: "eng" }])).toEqual([]);
  });

  it("drops a descriptor with no language", () => {
    // `lang` becomes srcLang and is how a selection is matched back to a track.
    expect(sanitizeSubtitles([{ label: "English", url: RAW }])).toEqual([]);
  });

  it("falls back to the code when a label is missing", () => {
    expect(sanitizeSubtitles([{ lang: "eng", url: RAW }])[0].label).toBe("eng");
  });

  it("deduplicates by language", () => {
    const out = sanitizeSubtitles([
      { label: "English", lang: "eng", url: RAW },
      { label: "English (alt)", lang: "ENG", url: `${RAW}2` },
    ]);
    expect(out).toHaveLength(1);
  });

  it("ignores non-object entries", () => {
    expect(sanitizeSubtitles([null, "x", 3, { lang: "eng", url: RAW }])).toHaveLength(1);
  });

  it("trims surrounding whitespace", () => {
    const out = sanitizeSubtitles([{ label: " English ", lang: " eng ", url: ` ${RAW} ` }]);
    expect(out[0]).toEqual({ label: "English", lang: "eng", url: RAW });
  });
});

describe("subtitleTrackUrl", () => {
  it("passes a backend relay handle through untouched", () => {
    // The backend already mints every caption as `/api/proxy/subtitle?track=…`
    // — same-origin, CORS-safe, SRT converted. Re-wrapping that handle in the
    // retired `/api/subtitles?url=…` door turned every <track> into a 404.
    const handle = "/api/proxy/subtitle?track=abc123";
    expect(subtitleTrackUrl(handle)).toBe(handle);
  });

  it("passes a raw URL through unchanged as well", () => {
    // There is no raw-URL proxy any more, so mangling the URL into a dead
    // route cannot help; the browser applies the usual CORS rules either way.
    expect(subtitleTrackUrl(RAW)).toBe(RAW);
  });
});

describe("buildSubtitleTracks", () => {
  it("maps descriptors to <track> attributes", () => {
    const tracks = buildSubtitleTracks([
      { label: "English", lang: "eng", url: RAW },
      { label: "Spanish", lang: "spa", url: RAW.replace("eng", "spa") },
    ]);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      label: "English",
      srcLang: "eng",
      // The src is the backend's own relay handle, passed through as-is.
      src: RAW,
    });
    expect(tracks[1].srcLang).toBe("spa");
  });

  it("marks only the first track as default", () => {
    // Several `default` tracks each try to enable themselves and overwrite one
    // another; exactly one is allowed.
    const tracks = buildSubtitleTracks([
      { label: "English", lang: "eng", url: RAW },
      { label: "Spanish", lang: "spa", url: RAW },
    ]);
    expect(tracks.map(t => t.default)).toEqual([true, false]);
  });

  it("produces no tracks for no input", () => {
    expect(buildSubtitleTracks()).toEqual([]);
    expect(buildSubtitleTracks([])).toEqual([]);
  });

  it("skips descriptors that would not render a usable track", () => {
    // The parameter is typed for already-sanitized data, so the malformed
    // entries are forced in deliberately: this is the defensive re-check that
    // keeps a partial descriptor from becoming a dead menu row.
    const malformed = [
      { label: "English", lang: "eng" },
      { label: "French", url: RAW },
      { label: "Spanish", lang: "spa", url: RAW },
    ] as unknown as StreamSubtitle[];
    expect(buildSubtitleTracks(malformed)).toHaveLength(1);
  });

  it("gives every track a distinct React key", () => {
    // React needs stable, unique keys to reconcile <track> when the source
    // changes; two identical languages must not collide.
    const tracks = buildSubtitleTracks([
      { label: "English", lang: "eng", url: `${RAW}a` },
      { label: "English alt", lang: "eng", url: `${RAW}b` },
    ]);
    expect(new Set(tracks.map(t => t.key)).size).toBe(2);
  });

  it("falls back to the language code when the label is empty", () => {
    const tracks = buildSubtitleTracks([{ label: "", lang: "deu", url: RAW }]);
    expect(tracks[0].label).toBe("deu");
  });
});
