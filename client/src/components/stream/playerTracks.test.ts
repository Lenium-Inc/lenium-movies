import { describe, expect, it } from "vitest";

import { deriveHlsAudioTracks, deriveHlsSubtitleTracks } from "./VideoPlayer";

/**
 * The menus read these two lists and then hand `id` straight back to hls.js's
 * `audioTrack` / `subtitleTrack` setters, so an id that is not the library's own
 * id selects the wrong rendition or nothing at all. The ordering also has to be
 * the manifest's: unlike the quality ladder, which is sorted for display, these
 * are positions in somebody else's array.
 */
describe("deriveHlsAudioTracks", () => {
  it("returns nothing for a missing or unparsed instance", () => {
    expect(deriveHlsAudioTracks(null)).toEqual([]);
    expect(deriveHlsAudioTracks(undefined)).toEqual([]);
    expect(deriveHlsAudioTracks({ audioTracks: [] } as never)).toEqual([]);
  });

  it("keeps manifest order and hls.js's own ids", () => {
    const tracks = deriveHlsAudioTracks({
      audioTracks: [
        { id: 0, name: "English", lang: "en" },
        { id: 3, name: "日本語", lang: "ja" },
        { id: 7, name: "Español", lang: "es" },
      ],
    } as never);

    expect(tracks).toEqual([
      { id: 0, label: "English", language: "en" },
      { id: 3, label: "日本語", language: "ja" },
      { id: 7, label: "Español", language: "es" },
    ]);
  });

  it("falls back to the language, then to a position, when there is no name", () => {
    const tracks = deriveHlsAudioTracks({
      audioTracks: [
        { id: 0, lang: "fr" },
        { id: 1 },
        { id: 2, name: "   " },
      ],
    } as never);

    expect(tracks.map(t => t.label)).toEqual(["FR", "Track 2", "Track 3"]);
  });

  it("reports no language when the manifest carried none", () => {
    const tracks = deriveHlsAudioTracks({
      audioTracks: [{ id: 0, name: "Commentary" }],
    } as never);

    expect(tracks).toEqual([{ id: 0, label: "Commentary", language: null }]);
  });
});

describe("deriveHlsSubtitleTracks", () => {
  it("returns nothing for a missing or unparsed instance", () => {
    expect(deriveHlsSubtitleTracks(null)).toEqual([]);
    expect(deriveHlsSubtitleTracks({} as never)).toEqual([]);
  });

  it("keeps manifest order and hls.js's own ids", () => {
    const tracks = deriveHlsSubtitleTracks({
      subtitleTracks: [
        { id: 0, name: "English CC", lang: "en" },
        { id: 1, name: "English SDH", lang: "en" },
        { id: 2, lang: "es" },
      ],
    } as never);

    // Not sorted, not deduplicated by language: a position in this array is
    // what `hls.subtitleTrack` expects, and reordering it would point the
    // setter at a different track.
    expect(tracks).toEqual([
      { id: 0, label: "English CC", language: "en" },
      { id: 1, label: "English SDH", language: "en" },
      { id: 2, label: "ES", language: "es" },
    ]);
  });

  it("distinguishes two tracks sharing a display name", () => {
    const tracks = deriveHlsSubtitleTracks({
      subtitleTracks: [
        { id: 0, name: "Subtitles", lang: "en" },
        { id: 1, name: "Subtitles", lang: "en-GB" },
      ],
    } as never);

    expect(tracks).toHaveLength(2);
    expect(tracks[0].id).not.toBe(tracks[1].id);
  });
});
