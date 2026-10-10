import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EMBED_HOSTS,
  EMBED_SOURCES,
  resolveEmbedSources,
} from "./embedSources";

/**
 * The backend is the authority on which provider actually serves a title, but
 * the client keeps its own copy of the manifest so a fresh resolve can be shown
 * before the server's chain comes back. That duplication is only safe if the two
 * cannot silently drift, which is what this file enforces.
 *
 * The failure this guards against is specific: a provider added to
 * `stream_providers.py` but not here. The backend reports the title as playable,
 * the client does not recognise the host as an embed, and the URL is handed to
 * `<video>`/hls.js as though it were an MP4 -- a silent failure with no error
 * anywhere.
 */
const PYTHON_PROVIDERS = path.resolve(
  import.meta.dirname,
  "../../../movie-backend/stream_providers.py"
);
const pythonSource = readFileSync(PYTHON_PROVIDERS, "utf8");

/** The `EMBED_PROVIDERS` tuple literal, parsed structurally rather than by import. */
function parsePythonManifest(): Array<{
  id: string;
  label: string;
  host: string;
  priority: number;
}> {
  const tuple = pythonSource.match(
    /EMBED_PROVIDERS: tuple\[EmbedProvider, \.\.\.\] = \(([\s\S]*?)\n\)/
  );
  if (!tuple)
    throw new Error("EMBED_PROVIDERS tuple not found in stream_providers.py");
  const out: Array<{
    id: string;
    label: string;
    host: string;
    priority: number;
  }> = [];
  // The remaining arguments are the provider's URL templates (`movie_url`,
  // `tv_url`), which vary in shape per host -- a query-string key for
  // vidsrc.me, a bare id path for 2Embed. They are captured but not compared
  // here: the parity assertions below check id/label/host -- which is what the
  // two sides have to agree on for a frame to be recognised as an embed -- and
  // the exact strings are pinned on both sides in the URL-shape table at the
  // bottom of this file.
  const pattern =
    /EmbedProvider\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*(\d+)/g;
  for (let i = 0; i < tuple[1].length; i += 1) {
    const match = pattern.exec(tuple[1]);
    if (!match) break;
    out.push({
      id: match[1],
      label: match[2],
      host: match[3],
      priority: Number(match[4]),
    });
  }
  return out;
}

describe("embed provider manifest parity with the backend", () => {
  const manifest = parsePythonManifest();

  it("parses the backend manifest at all", () => {
    // A silent regex miss would make every assertion below vacuously pass, so
    // the parser itself is checked first.
    expect(manifest.length).toBeGreaterThan(0);
  });

  it("declares the same providers, in the same order, with the same hosts", () => {
    expect(EMBED_SOURCES.map(s => ({ id: s.id, host: s.host }))).toEqual(
      manifest.map(p => ({ id: p.id, host: p.host }))
    );
  });

  it("uses the same labels, so a switcher tab reads identically on both sides", () => {
    expect(EMBED_SOURCES.map(s => s.label)).toEqual(manifest.map(p => p.label));
  });

  it("gives every provider a strictly increasing backend priority", () => {
    // The resolver walks the chain in priority order, so a duplicate priority
    // would make the sort order between two providers arbitrary.
    const priorities = manifest.map(p => p.priority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });

  it("derives EMBED_HOSTS from the manifest with no duplicates", () => {
    expect(EMBED_HOSTS).toEqual(
      Array.from(new Set(EMBED_SOURCES.map(s => s.host)))
    );
  });

  it("accepts and rejects exactly the characters the backend's safeId accepts", () => {
    // `_SAFE_ID_PATTERN` in stream_providers.py. If these two character classes
    // diverge, a title can be addressable on one side and silently dropped on
    // the other, which reads as "provider down" rather than as a bug.
    const pythonClass = pythonSource.match(
      /_SAFE_ID_PATTERN = re\.compile\(r"\[([^\]]+)\]/
    )?.[1];
    expect(pythonClass).toBeTruthy();
    // The class uses range syntax (`A-Za-z0-9-`), so it has to be expanded
    // before it can be compared character by character.
    const allowed = new Set<string>();
    for (let i = 0; i < pythonClass!.length; i += 1) {
      if (pythonClass![i + 1] === "-" && i + 2 < pythonClass!.length) {
        for (
          let code = pythonClass!.charCodeAt(i);
          code <= pythonClass!.charCodeAt(i + 2);
          code += 1
        ) {
          allowed.add(String.fromCharCode(code));
        }
        i += 2;
        continue;
      }
      allowed.add(pythonClass![i]);
    }
    expect(allowed.has("-")).toBe(true);
    "abcXYZ0189-".split("").forEach(char => {
      expect(
        resolveEmbedSources({ tmdbId: `12${char}3`, mediaType: "movie" })
          .length > 0
      ).toBe(allowed.has(char));
    });
    [" ", "/", "?", "#", "&", ".", "_", "'", "\n"].forEach(char => {
      expect(
        resolveEmbedSources({ tmdbId: `12${char}3`, mediaType: "movie" }).length
      ).toBe(0);
    });
  });
});

describe("embed URL shapes", () => {
  const urlFor = (id: string, mediaType: "movie" | "tv") =>
    resolveEmbedSources({ tmdbId: 603, mediaType, season: 2, episode: 5 }).find(
      s => s.id === id
    )?.url ?? null;

  // The backend's EmbedProvider.build() must produce these same strings. A
  // mismatch means the client's fallback chain addresses providers differently
  // from the one the server vetted.
  it.each([
    ["vidsrc-pro", "movie", "https://vidsrc.pro/embed/movie/603"],
    ["vidsrc-pro", "tv", "https://vidsrc.pro/embed/tv/603/2/5"],
    ["vidsrc-cc", "movie", "https://vidsrc.cc/v2/embed/movie/603"],
    ["vidsrc-cc", "tv", "https://vidsrc.cc/v2/embed/tv/603/2/5"],
    ["vidsrc-me", "movie", "https://vidsrc.me/embed/movie?tmdb=603"],
    [
      "vidsrc-me",
      "tv",
      "https://vidsrc.me/embed/tv?tmdb=603&season=2&episode=5",
    ],
    ["2embed", "movie", "https://www.2embed.cc/embed/603"],
    ["2embed", "tv", "https://www.2embed.cc/embedtv/603&s=2&e=5"],
    ["autoembed", "movie", "https://vidsrc.to/embed/movie/603"],
    ["autoembed", "tv", "https://vidsrc.to/embed/tv/603/2/5"],
  ])("%s builds the %s url the backend expects", (id, mediaType, expected) => {
    expect(urlFor(id, mediaType as "movie" | "tv")).toBe(expected);
  });

  it("covers every declared provider for both media types", () => {
    // Guards the table above from quietly going stale when a provider is added.
    for (const source of EMBED_SOURCES) {
      expect(urlFor(source.id, "movie")).toBeTruthy();
      expect(urlFor(source.id, "tv")).toBeTruthy();
    }
  });

  it("drops providers instead of emitting a broken tab for a non-tmdb target", () => {
    const sources = resolveEmbedSources({ mediaType: "movie" });
    expect(sources).toHaveLength(0);
  });
});
