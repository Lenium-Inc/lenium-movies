import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EMBED_HOSTS, EMBED_SOURCES, chainFromBackend } from "./embedSources";
import { STREAM_PROVIDERS, buildProviderUrl, safeStreamId } from "./streamProviders";

/**
 * The backend is the authority on which hosts exist. The client keeps its own
 * copy of the manifest for exactly one playback-relevant job: recognising a
 * third-party host as an embed, so a stale or raw provider URL is never handed
 * to `<video>`/hls.js as though it were an MP4. Playback itself only ever loads
 * a tokenised handle the backend minted.
 *
 * That duplication is only safe if the two cannot silently drift, which is what
 * this file enforces.
 *
 * The failure this guards against is specific: a provider added to
 * `stream_providers.py` but not here. The backend reports the title as playable,
 * the client does not recognise the host as an embed, and the URL is handed to
 * `<video>`/hls.js as though it were an MP4 -- a silent failure with no error
 * anywhere.
 *
 * The check runs one way, backend -> client. The client carrying a host the
 * backend no longer uses is harmless (it merely widens recognition); the
 * backend carrying one the client does not is the bug.
 */
const PYTHON_PROVIDERS = path.resolve(
  import.meta.dirname,
  "../../../movie-backend/stream_providers.py"
);
const pythonSource = readFileSync(PYTHON_PROVIDERS, "utf8");

/** The `EMBED_PROVIDERS` list literal, parsed structurally rather than by import. */
function parsePythonManifest(): Array<{
  id: string;
  name: string;
  movieUrl: string;
  tvUrl: string;
}> {
  const literal = pythonSource.match(
    /EMBED_PROVIDERS: list\[EmbedProvider\] = \[([\s\S]*?)\n\]/
  );
  if (!literal)
    throw new Error("EMBED_PROVIDERS list not found in stream_providers.py");
  const out: Array<{ id: string; name: string; movieUrl: string; tvUrl: string }> = [];
  // Each entry is one `EmbedProvider("id", "name", "movie_url", "tv_url")`
  // call, wrapped over several lines by the formatter. `\s` covers the line
  // breaks, so the pattern is shape-driven rather than indentation-driven.
  const pattern =
    /EmbedProvider\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\s*\)/g;
  for (const match of literal[1].matchAll(pattern)) {
    out.push({
      id: match[1],
      name: match[2],
      movieUrl: match[3],
      tvUrl: match[4],
    });
  }
  return out;
}

/** The host a backend template addresses, read off the template itself. */
function hostOfTemplate(template: string): string {
  return new URL(template).hostname.toLowerCase();
}

/** Render a backend `{id}`/`{season}`/`{episode}` template the way `build()` does. */
function renderTemplate(
  template: string,
  id: string,
  season: number,
  episode: number
): string {
  return template
    .replaceAll("{id}", id)
    .replaceAll("{season}", String(season))
    .replaceAll("{episode}", String(episode));
}

describe("embed provider manifest parity with the backend", () => {
  const manifest = parsePythonManifest();

  it("parses the backend manifest at all", () => {
    // A silent regex miss would make every assertion below vacuously pass, so
    // the parser itself is checked first.
    expect(manifest.length).toBeGreaterThan(0);
  });

  it("recognises every provider id the backend declares", () => {
    const clientIds = new Set(STREAM_PROVIDERS.map(p => p.id));
    const missing = manifest.map(p => p.id).filter(id => !clientIds.has(id));
    expect(missing, `providers the client does not know about: ${missing}`).toEqual(
      []
    );
  });

  it("recognises every host the backend's templates address", () => {
    // This is the safety property. A backend host the client does not carry is
    // a URL the client will happily feed to the native player.
    const clientHosts = new Set(EMBED_HOSTS);
    const missing = Array.from(
      new Set(manifest.map(p => hostOfTemplate(p.movieUrl)))
    ).filter(host => !clientHosts.has(host));
    expect(missing, `hosts the client does not recognise: ${missing}`).toEqual([]);
  });

  it("builds the same URLs the backend's templates produce", () => {
    for (const provider of manifest) {
      const client = STREAM_PROVIDERS.find(p => p.id === provider.id);
      expect(client, `no client manifest entry for ${provider.id}`).toBeTruthy();
      expect(buildProviderUrl(client!, 603, "movie")).toBe(
        renderTemplate(provider.movieUrl, "603", 2, 5)
      );
      expect(buildProviderUrl(client!, 603, "tv", 2, 5)).toBe(
        renderTemplate(provider.tvUrl, "603", 2, 5)
      );
    }
  });

  it("derives EMBED_HOSTS from the manifest with no duplicates", () => {
    expect(EMBED_HOSTS).toEqual(
      Array.from(new Set(EMBED_SOURCES.map(s => s.host)))
    );
  });

  it("declares the same host its own URL builder addresses", () => {
    // A `host` field that disagrees with `getUrl` would let the parity check
    // above pass while `EMBED_HOSTS` still failed to match the URL the
    // provider is actually reached at.
    for (const provider of STREAM_PROVIDERS) {
      expect(new URL(provider.getUrl("1", "movie")).hostname).toBe(provider.host);
    }
  });

  it("refuses an id that could break out of the URL path", () => {
    // `safeStreamId` is the only gate before an id is interpolated into a
    // path. The backend no longer mirrors this check -- its `build()` formats
    // straight through -- so the class is pinned here, on the side that still
    // has it.
    expect(safeStreamId("123")).toBe("123");
    expect(safeStreamId("abc-XYZ0189")).toBe("abc-XYZ0189");
    [" ", "/", "?", "#", "&", ".", "_", "'", "\n"].forEach(char => {
      expect(safeStreamId(`12${char}3`)).toBe(null);
    });
    const provider = STREAM_PROVIDERS[0];
    expect(buildProviderUrl(provider, "12 3", "movie")).toBe("");
    expect(buildProviderUrl(provider, undefined, "movie")).toBe("");
  });
});

describe("chainFromBackend", () => {
  const frameHandle = (token: string) => `/api/v1/playback/frame?token=${token}`;

  it("walks the server's chain in the order it was sent", () => {
    const chain = chainFromBackend([
      { name: "Prime HD", url: frameHandle("a"), is_embed: true },
      { name: "Backup Stream", url: frameHandle("b"), is_embed: true },
    ]);
    expect(chain.map(s => s.id)).toEqual(["vidsrc-pro", "autoembed"]);
    expect(chain.map(s => s.url)).toEqual([frameHandle("a"), frameHandle("b")]);
  });

  it("gives an unlabelled candidate a usable id instead of dropping it", () => {
    const chain = chainFromBackend([{ url: frameHandle("c"), is_embed: true }]);
    expect(chain).toHaveLength(1);
    expect(chain[0].id).toBe("server-0");
    expect(chain[0].type).toBe("embed");
  });

  it("deduplicates repeated handles and ids", () => {
    const chain = chainFromBackend([
      { name: "Prime HD", url: frameHandle("a"), is_embed: true },
      { name: "Prime HD", url: frameHandle("a"), is_embed: true },
      { name: "Cinema Plus", url: frameHandle("b"), is_embed: true },
    ]);
    expect(chain.map(s => s.id)).toEqual(["vidsrc-pro", "vidsrc-cc"]);
  });

  it("skips entries the backend marked as files rather than frames", () => {
    const chain = chainFromBackend([
      { name: "Archive.org", url: "/api/v1/playback/media?token=x", is_embed: false },
      { name: "Prime HD", url: frameHandle("a"), is_embed: true },
    ]);
    expect(chain.map(s => s.id)).toEqual(["vidsrc-pro"]);
  });

  it("returns an empty chain when the payload carries none", () => {
    // Nothing to walk is the honest answer: a locally assembled chain would
    // mean the browser constructing a raw provider URL the server never vetted.
    // The no-iframe backend sends no chain at all, so this is the normal case.
    expect(chainFromBackend(undefined)).toEqual([]);
    expect(chainFromBackend([])).toEqual([]);
    expect(chainFromBackend(null)).toEqual([]);
  });
});
