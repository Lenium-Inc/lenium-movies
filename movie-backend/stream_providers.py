"""
stream_providers.py — resolution chain. No iframes.

  tier  extract : browser-rendered provider  -> direct m3u8/mpd/mp4
  tier  archive : public-domain direct file  -> native playback

The extract tier renders `vidlink.pro` in a headless browser and takes the
playlist URL it names. That provider derives an opaque id with a `.wasm`
module before it will answer, so no plain-HTTP client can reach it -- which is
why this chain used to return nothing and why the app shipped iframes. The
browser gets the URL out; the player then owns quality, seeking and subtitles
on a real media element instead of handing the tab to a frame.

Archive remains the fallback, and is the only tier for titles the provider
does not carry (older and public-domain films). Set STREAM_EXTRACT=0 to skip
the browser entirely and resolve archive-only.
"""
from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import requests

import extractors
from proxy_util import playable, playable_sub, stream_format

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

PROBE_TIMEOUT = float(os.getenv("STREAM_PROBE_TIMEOUT", "3"))
TRAILER_CUTOFF_MIN = float(os.getenv("STREAM_TRAILER_CUTOFF_MIN", "40"))
MIN_FEATURE_MIN = float(os.getenv("STREAM_MIN_FEATURE_MIN", "15"))
#: The browser render is the only path to a stream URL for most films, so the
#: extract tier runs by default. Opting out is for a box with no Chrome, or
#: for measuring the archive tier on its own.
EXTRACT_OPT_IN = os.getenv("STREAM_EXTRACT", "1").lower() not in ("0", "false", "no")
#: Wall clock for the tier pair. The two tiers run at once, so the walk costs
#: the *faster* tier rather than the sum -- on a title neither could serve, the
#: serial version made the viewer pay the browser render *and* the catalog
#: scrape (~23s observed) to hear "unavailable". Defaults to the extract chain
#: budget so `EXTRACTOR_BUDGET_SECONDS` stays the one knob.
TIER_BUDGET = float(os.getenv("RESOLVE_TIER_BUDGET_SECONDS", extractors.BUDGET))


@dataclass
class Resolution:
    ok: bool
    provider: str = ""
    streams: list[dict] = field(default_factory=list)      # {url,label,referer}
    subtitles: list[dict] = field(default_factory=list)    # {url,label}
    referer: str = ""
    attempts: list[dict] = field(default_factory=list)

    @property
    def is_embed(self) -> bool:
        return False


# --------------------------------------------------------------------------- #
#  Reference list of embed hosts (kept for /api/media, not used for resolution)#
# --------------------------------------------------------------------------- #
@dataclass
class EmbedProvider:
    id: str
    name: str
    movie_url: str
    tv_url: str

    def build(self, tmdb_id, media_type="movie", season=1, episode=1) -> str:
        tpl = self.tv_url if media_type == "tv" else self.movie_url
        return tpl.format(id=tmdb_id, season=season, episode=episode)


EMBED_PROVIDERS: list[EmbedProvider] = [
    EmbedProvider("vidsrc-pro", "VidSrc.pro",
                  "https://vidsrc.pro/embed/movie/{id}",
                  "https://vidsrc.pro/embed/tv/{id}/{season}/{episode}"),
    EmbedProvider("vidsrc-cc", "VidSrc.cc",
                  "https://vidsrc.cc/v2/embed/movie/{id}",
                  "https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}"),
    EmbedProvider("vidlink", "VidLink",
                  "https://vidlink.pro/movie/{id}",
                  "https://vidlink.pro/tv/{id}/{season}/{episode}"),
    EmbedProvider("2embed", "2Embed",
                  "https://www.2embed.cc/embed/{id}",
                  "https://www.2embed.cc/embedtv/{id}&s={season}&e={episode}"),
]


def active_embed_providers() -> list[EmbedProvider]:
    return list(EMBED_PROVIDERS)


# --------------------------------------------------------------------------- #
#  Duration guard — a trailer must never win a feature film                    #
# --------------------------------------------------------------------------- #
def _manifest_duration(text: str) -> float:
    total = 0.0
    for line in text.splitlines():
        if line.startswith("#EXTINF:"):
            try:
                total += float(line[len("#EXTINF:"):].split(",")[0])
            except ValueError:
                pass
    return total


def _duration_ok(url: str, runtime) -> bool:
    try:
        runtime = int(runtime) if runtime else None
    except (TypeError, ValueError):
        runtime = None
    if not runtime or runtime < TRAILER_CUTOFF_MIN:
        return True
    if not url.split("?")[0].lower().endswith(".m3u8"):
        return True
    try:
        r = requests.get(url, headers={"User-Agent": BROWSER_UA}, timeout=PROBE_TIMEOUT)
        if r.status_code != 200:
            return True
        minutes = _manifest_duration(r.text) / 60.0
    except requests.exceptions.RequestException:
        return True
    return minutes >= MIN_FEATURE_MIN


# --------------------------------------------------------------------------- #
#  Tiers                                                                       #
# --------------------------------------------------------------------------- #
def _extract_tier(tmdb_id, media_type, season, episode, title, attempts):
    try:
        ext = extractors.extract_chain(tmdb_id, media_type, season, episode, title)
    except Exception as err:  # noqa: BLE001
        print(f"[providers] extraction failed: {err}")
        ext = None
    if not ext or not ext.streams:
        attempts.append({"tier": "extract", "ok": False})
        return None
    streams = [
        dict(
            s,
            url=playable(s["url"], s.get("referer", ""), s.get("headers")),
            format=stream_format(s["url"]),
        )
        for s in ext.streams
    ]
    subs = [
        dict(s, url=playable_sub(s["url"], ext.referer, s.get("headers")))
        for s in ext.subtitles
    ]
    attempts.append({"tier": "extract", "ok": True, "provider": ext.provider})
    return Resolution(True, ext.provider, streams, subs, ext.referer, attempts)


def _archive_tier(direct_fetcher, title, year, refresh, runtime, attempts):
    if not title:
        attempts.append({"tier": "archive", "ok": False, "reason": "no title"})
        return None
    try:
        src = direct_fetcher(title, year=year, refresh=refresh)
    except Exception as err:  # noqa: BLE001
        print(f"[providers] archive failed: {err}")
        src = None
    if not src or not src.get("streams"):
        attempts.append({"tier": "archive", "ok": False})
        return None
    streams = []
    for s in src["streams"]:
        u = s.get("url")
        if u and _duration_ok(u, runtime):
            streams.append({
                "url": playable(u, src.get("referer", "")),
                "label": s.get("label") or "Auto",
                "referer": src.get("referer", ""),
                "format": stream_format(u),
                "height": s.get("height") or 0,
                "width": s.get("width") or 0,
                "size": s.get("size") or 0,
            })
    if not streams:
        attempts.append({"tier": "archive", "ok": False, "reason": "duration guard"})
        return None
    subs = [dict(s, url=playable_sub(s["url"], src.get("referer", "")))
            for s in (src.get("subtitles") or []) if s.get("url")]
    attempts.append({"tier": "archive", "ok": True, "provider": "archive"})
    return Resolution(True, "archive", streams, subs, src.get("referer", ""), attempts)


def _settle(future, deadline: float):
    """The future's value if it lands before `deadline`, else `None` (a miss).

    A tier that overruns is abandoned, not cancelled: it finishes on its own
    and writes its cache (the extract chain's `MISS_TTL`, the archive's own),
    so the next viewer of the same title pays nothing for this one's
    impatience. An exception escaping a tier is a miss by the same rule the
    per-tier `try` blocks apply -- one broken provider must not 500 the walk.
    """
    try:
        return future.result(timeout=max(0.0, deadline - time.monotonic()))
    except Exception:  # noqa: BLE001 - overrun or a raising tier: both are misses
        return None


def resolve(
    direct_fetcher,
    tmdb_id,
    media_type: str = "movie",
    title: str = "",
    year=None,
    season: int = 1,
    episode: int = 1,
    refresh: bool = False,
    runtime=None,
    extract: bool = EXTRACT_OPT_IN,
) -> Resolution:
    """Return the first tier that yields playable streams, in priority order.

    Extract wins whenever it answers, because it is the only tier that can
    reach a modern film; the archive is the answer for titles the provider
    does not carry. The two run *concurrently* under one `TIER_BUDGET` so the
    walk costs the faster tier instead of the sum -- the archive's result is
    already in hand when the extract tier misses, and already cached when the
    extract tier wins with a manifest that needs a supplement. Passing
    `extract=False` skips the browser, which is what a box without Chrome --
    or a measurement of the archive tier alone -- needs.

    One supplement breaks the short-circuit. A provider answer can be
    playable-but-not-savable: HLS and DASH are manifests, and saving one as a
    single file would need a server-side remux this host does not do, so the
    download route refuses them by design. When the extract tier wins with
    manifest-only streams, the archive's concurrent answer -- a progressive
    file, if it has one -- rides along after the manifests. The play path is
    unchanged (the manifest stays first), but the client's download button
    gains a real file instead of an honest dead end.
    """
    attempts: list[dict] = []

    if not extract:
        res = _archive_tier(direct_fetcher, title, year, refresh, runtime, attempts)
        return res or Resolution(False, attempts=attempts)

    # Per-tier lists, merged in walk order afterwards: the tiers append from
    # different threads, and the attempt log answers to the client as
    # diagnostics -- it has to read `extract`, then `archive`, no matter
    # which of them finished first.
    extract_attempts: list[dict] = []
    archive_attempts: list[dict] = []
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="resolve-tier")
    try:
        extract_future = pool.submit(
            _extract_tier, tmdb_id, media_type, season, episode, title, extract_attempts
        )
        archive_future = pool.submit(
            _archive_tier,
            direct_fetcher, title, year, refresh, runtime, archive_attempts,
        )
        deadline = time.monotonic() + TIER_BUDGET

        res = _settle(extract_future, deadline)
        supplement = bool(
            res
            and res.streams
            and all(str(s.get("format") or "") in ("hls", "dash") for s in res.streams)
        )
        # A progressive extract win is playable *and* savable: the walk is
        # over, and waiting on the archive now would only add its latency to
        # an answer that is already complete.
        extra = _settle(archive_future, deadline) if (res is None or supplement) else None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    attempts.extend(extract_attempts)
    attempts.extend(archive_attempts)

    if res is None:
        # The archive answered while the provider missed: its attempt log
        # rides along with its streams, so the returned Resolution reports the
        # whole walk rather than only the tier that won.
        if extra is not None:
            extra.attempts = attempts
            return extra
        return Resolution(False, attempts=attempts)

    if supplement and extra:
        res.streams.extend(extra.streams)
        res.subtitles.extend(extra.subtitles)
    res.attempts = attempts
    return res
