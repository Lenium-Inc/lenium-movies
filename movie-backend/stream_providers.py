"""
Stream provider registry and server-side failover.

Why this module exists
----------------------
Playback used to be resolved by two independent, disjoint provider lists: two
hardcoded `vidsrc.*` hosts in `app.py` and five unrelated hosts in
`client/src/lib/embedSources.ts`. Neither list knew about the other, so "the
primary provider is down" was decided in the browser, by a viewer, one click at
a time. The frontend had to expose a "Try another source" button precisely
because the backend could not express a fallback chain.

This module makes the backend the single source of truth:

* one ordered manifest of every provider (direct catalog + embeds),
* a health record per provider, so a provider that just failed is skipped for a
  cooldown instead of being re-probed on the very next request,
* `resolve()`, which walks the chain in priority order and returns the first
  provider that yields a playable source, together with the full ordered list
  of remaining candidates so the player can still fail over client-side.

A request only fails once every enabled provider has been attempted.

Provider tiers
--------------
`direct`  Archive.org-backed catalog entries. Real HLS/MP4 URLs the native
          player boots directly. Highest quality, no third-party frame, but
          only covers titles the catalog carries.
`embed`   Third-party iframe players. Always available for a valid TMDB id, so
          they act as the terminal fallback that keeps a title playable when
          the direct catalog has nothing.

Env configuration
-----------------
`STREAM_PROVIDER_ORDER`  Comma-separated provider ids defining priority.
                         Providers named here but absent from the built-in
                         manifest are ignored; manifest providers not named keep
                         their default relative order and follow the configured
                         ones.
`STREAM_PROVIDER_DISABLED`  Comma-separated provider ids to remove entirely.
"""

from __future__ import annotations

import os
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Iterable

from runtime_config import load_env_file, ssl_context

load_env_file()

UA = "Mozilla/5.0 (FreeStream-movie-backend; +http://localhost:5000)"

#: Character class a TMDB id (or manifest-supplied id) must match before it is
#: allowed anywhere in a provider URL. Mirrors `safeId` in
#: `client/src/lib/embedSources.ts`; the two must stay identical.
_SAFE_ID_PATTERN = re.compile(r"[A-Za-z0-9-]+")

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EmbedProvider:
    """A third-party iframe player addressed by TMDB id.

    `build` is a pure URL template: no scraping, no proxying. A provider going
    away is therefore a manifest edit rather than a code change.
    """

    id: str
    label: str
    host: str
    priority: int

    def build(self, tmdb_id: int | str, media_type: str, season: int, episode: int) -> str:
        """Addressable URL for this provider, or "" if the target cannot be keyed.

        URL shapes are duplicated verbatim in `client/src/lib/embedSources.ts`.
        That duplication is deliberate but fragile, so the two are asserted
        against each other in `embedSources.test.ts`: a provider whose builder
        drifts here is a title the backend will hand to the player and the
        client will not recognise as an embed.
        """
        safe = _safe_id(tmdb_id)
        if not safe:
            return ""

        if self.id == "autoembed":
            if media_type == "tv":
                return f"https://{self.host}/embed/tv/{safe}?season={season}&episode={episode}"
            return f"https://{self.host}/embed/movie/tmdb/{safe}"

        if self.id == "multiembed":
            if media_type == "tv":
                return (
                    f"https://{self.host}/directstream.php"
                    f"?video_id={safe}&tmdb=1&season={season}&episode={episode}"
                )
            return f"https://{self.host}/directstream.php?video_id={safe}&tmdb=1"

        # vidsrc.cc is served under /v2 while the other vidsrc hosts are not.
        # Building these by convention is how the two drifted in the first place.
        prefix = "/v2/embed" if self.id == "vidsrc_alt" else "/embed"
        if media_type == "tv":
            return f"https://{self.host}{prefix}/tv/{safe}/{season}/{episode}"
        return f"https://{self.host}{prefix}/movie/{safe}"


def _safe_id(value: object) -> str:
    """Provider ids reach a URL path, so only `[A-Za-z0-9-]` is ever allowed.

    `/api/get-stream` validates with `_parse_tmdb_id`, but this registry is
    also driven by manifest data and must not be the weaker link. The character
    class matches the TypeScript `safeId` exactly so a value accepted by one
    side is never rejected by the other.
    """
    if value is None:
        return ""
    text = str(value).strip()
    return text if text and _SAFE_ID_PATTERN.fullmatch(text) else ""


EMBED_PROVIDERS: tuple[EmbedProvider, ...] = (
    EmbedProvider("vidsrc", "Server 1", "vidsrc.me", 10),
    EmbedProvider("vidsrc_alt", "Server 2", "vidsrc.cc", 20),
    EmbedProvider("vidsrc_to", "Server 3", "vidsrc.to", 30),
    EmbedProvider("autoembed", "Server 4", "autoembed.to", 40),
    EmbedProvider("mycima", "Server 5", "mycima.tv", 50),
    EmbedProvider("2embed", "Server 6", "2embed.org", 60),
    EmbedProvider("multiembed", "Server 7", "multiembed.mov", 70),
)

DIRECT_PROVIDER_ID = "archive_direct"

#: Every host the app may ever load a third-party frame from. The frontend
#: derives its equivalent list from this same manifest, so a provider added here
#: is recognised as an embed by both sides on the same deploy.
EMBED_HOSTS: tuple[str, ...] = tuple(dict.fromkeys(p.host for p in EMBED_PROVIDERS))


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@dataclass
class ProviderHealth:
    """Rolling failure record for one provider.

    Consecutive failures open a circuit for `cooldown_seconds`, which is what
    stops a dead provider from costing every request a probe timeout. Any
    success closes it immediately.
    """

    consecutive_failures: int = 0
    open_until: float = 0.0
    last_error: str = ""
    last_ok_at: float = 0.0

    def available(self, now: float) -> bool:
        return now >= self.open_until

    def record_success(self, now: float) -> None:
        self.consecutive_failures = 0
        self.open_until = 0.0
        self.last_error = ""
        self.last_ok_at = now

    def record_failure(self, now: float, error: str, cooldown: float, threshold: int) -> None:
        self.consecutive_failures += 1
        self.last_error = error
        if self.consecutive_failures >= threshold:
            self.open_until = now + cooldown


class HealthRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._health: dict[str, ProviderHealth] = {}

    def get(self, provider_id: str) -> ProviderHealth:
        with self._lock:
            record = self._health.get(provider_id)
            if record is None:
                record = ProviderHealth()
                self._health[provider_id] = record
            return record

    def reset(self) -> None:
        with self._lock:
            self._health.clear()


HEALTH = HealthRegistry()

#: Consecutive failures before a provider is benched.
FAILURE_THRESHOLD = 3
#: How long a benched provider is skipped. Long enough that a blip does not
#: remove a provider for the rest of a session, short enough that a genuine
#: outage recovers without a deploy.
COOLDOWN_SECONDS = 120.0
#: How long a direct-catalog miss stays benched before it is worth re-scraping.
DIRECT_MISS_COOLDOWN_SECONDS = 300.0

#: A single embed probe must not be able to hold a worker for the whole request
#: budget. Two providers down at 5s each would already exceed it.
EMBED_PROBE_TIMEOUT_SECONDS = 5.0
#: Result of a successful probe, so a healthy provider is not re-probed on
#: every request.
EMBED_PROBE_TTL_SECONDS = 300.0
#: Ceiling on the embed phase of a single resolution. Probes are sequential, so
#: without this a fully-down chain of seven providers would block the worker for
#: `7 * EMBED_PROBE_TIMEOUT_SECONDS` -- past the client-side resolve timeout, so
#: the request would die before the chain had even finished. The budget is spent
#: in priority order: providers earlier in the chain are guaranteed a probe,
#: and only the tail is ever cut short.
EMBED_PHASE_BUDGET_SECONDS = 12.0


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def _configured_ids(raw: str) -> list[str]:
    return [part.strip() for part in (raw or "").split(",") if part.strip()]


def active_embed_providers() -> list[EmbedProvider]:
    """Embed providers in priority order, after env overrides.

    Invalid or unknown ids in `STREAM_PROVIDER_ORDER` are ignored rather than
    fatal: a typo in a dashboard variable should degrade to the default chain,
    not take playback down.
    """
    disabled = {pid.lower() for pid in _configured_ids(os.environ.get("STREAM_PROVIDER_DISABLED", ""))}
    pool = [p for p in EMBED_PROVIDERS if p.id.lower() not in disabled]

    ordered_raw = _configured_ids(os.environ.get("STREAM_PROVIDER_ORDER", ""))
    if not ordered_raw:
        return sorted(pool, key=lambda p: (p.priority, p.id))

    rank = {pid.lower(): index for index, pid in enumerate(ordered_raw)}
    known = [p for p in pool if p.id.lower() in rank]
    # Providers the operator did not mention keep their manifest order but are
    # tried after the ones they did, so a partial list cannot silently demote
    # the rest of the chain.
    rest = [p for p in pool if p.id.lower() not in rank]
    return sorted(known, key=lambda p: rank[p.id.lower()]) + sorted(rest, key=lambda p: (p.priority, p.id))


def is_embed_host(host: str) -> bool:
    """True when `host` belongs to a known provider (or its subdomains)."""
    target = (host or "").lower().strip(".")
    return any(target == h or target.endswith(f".{h}") for h in EMBED_HOSTS)


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------

_probe_lock = threading.Lock()
#: provider id -> (probed_at, reachable). Keyed by provider rather than by URL
#: because a provider is a host, and one reachability answer covers every title
#: it is asked about.
_probe_cache: dict[str, tuple[float, bool]] = {}


def probe_embed(url: str, timeout: float = EMBED_PROBE_TIMEOUT_SECONDS) -> bool:
    """One shallow liveness check against a provider's embed page.

    Deliberately shallow: a GET that only asks whether the host responds. It
    cannot tell whether the provider actually carries the title -- nothing
    server-side can, short of scraping and parsing a player -- so it is a
    liveness signal, not a content guarantee. That is the same guarantee the
    frontend's iframe watchdog gives, and it is enough to keep a dead host out
    of the chain.

    No caching and no health accounting here. Both belong to `probe_provider`,
    which is the seam the resolver uses, so a chain can be driven without a
    socket anywhere.
    """
    if not url:
        return False
    try:
        request = urllib.request.Request(
            url,
            method="GET",
            headers={"User-Agent": UA, "Range": "bytes=0-1023"},
        )
        with urllib.request.urlopen(request, context=ssl_context(), timeout=timeout) as response:
            # A 4xx/5xx still means the host is up. Treating a rate-limit as a
            # dead host would bench a provider that is merely throttling us.
            status = getattr(response, "status", None) or response.getcode()
            return 200 <= status < 400 or status in (401, 403, 429)
    except urllib.error.HTTPError as exc:
        # An HTTP error is a response, not a transport failure: the host is up.
        return exc.code in (401, 403, 429)
    except Exception:  # noqa: BLE001 - any transport error means "not up"
        return False


def probe_provider(provider: EmbedProvider, url: str, timeout: float) -> bool:
    """Probe a provider, caching the result and recording the outcome.

    Caching matters because the chain is walked on every resolve: without it, a
    healthy provider would cost a real network request per title per viewer.

    Health accounting is here rather than in `probe_embed` because the resolver
    needs the provider *id* to attribute the outcome, and because a cached
    negative must still count as a failure. That last part is the whole reason
    the cache is not just a shortcut: if only fresh probes were counted, a dead
    provider would be asked once per TTL forever and its failure count would
    never reach the threshold, so the circuit would never open and the breaker
    would be decorative. A cached negative is still evidence the provider is
    down, and each request that observes it is a genuine independent attempt.
    """
    now = time.time()
    with _probe_lock:
        cached = _probe_cache.get(provider.id)

    # A cached *negative* is only trusted for as long as the provider would
    # have stayed benched anyway. If it outlived the cooldown, the chain would
    # keep re-benching a provider on the strength of an answer that is now
    # older than the timeout it was meant to be benched for, and it would never
    # re-probe -- so a provider that came back would stay invisible until the
    # full TTL elapsed. A cached positive can safely live longer, since being
    # optimistic only costs a failed frame that the client watchdog handles.
    ttl = EMBED_PROBE_TTL_SECONDS if (cached and cached[1]) else COOLDOWN_SECONDS
    if cached and (now - cached[0]) < ttl:
        ok = cached[1]
        # Fall through to accounting, but skip the network call.
    else:
        ok = probe_embed(url, timeout=timeout)
        with _probe_lock:
            _probe_cache[provider.id] = (now, ok)

    record = HEALTH.get(provider.id)
    if ok:
        record.record_success(time.time())
    else:
        record.record_failure(time.time(), "probe failed", COOLDOWN_SECONDS, FAILURE_THRESHOLD)
    return ok


def _provider_for_url(url: str) -> str:
    host = (url or "").split("/")[2].lower() if "//" in (url or "") else ""
    for provider in EMBED_PROVIDERS:
        if host == provider.host or host.endswith(f".{provider.host}"):
            return provider.id
    return "unknown"


def clear_probe_cache() -> None:
    """Drop cached liveness. Exposed for tests and for a manual provider reset."""
    with _probe_lock:
        _probe_cache.clear()


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


@dataclass
class ResolvedProvider:
    """One provider's contribution to a resolution attempt."""

    id: str
    kind: str  # "direct" | "embed"
    label: str
    url: str
    payload: dict | None = None
    error: str = ""
    #: False when the URL was built from the manifest but not liveness-probed,
    #: because the request was already carrying a working direct source. The
    #: client watchdog still vets it before it is trusted with playback.
    verified: bool = True


@dataclass
class Resolution:
    """Outcome of walking the provider chain."""

    winner: ResolvedProvider | None
    #: Every provider that could serve the target, winner first. The frontend
    #: uses this for client-side failover when the winning URL dies mid-play.
    candidates: list[ResolvedProvider] = field(default_factory=list)
    #: Per-provider outcome, in the order attempted. Server log / debugging aid.
    attempts: list[dict] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.winner is not None

    @property
    def is_embed(self) -> bool:
        return bool(self.winner and self.winner.kind == "embed")

    @property
    def url(self) -> str:
        return self.winner.url if self.winner else ""

    def candidate_urls(self) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for candidate in self.candidates:
            if candidate.url and candidate.url not in seen:
                seen.add(candidate.url)
                out.append(candidate.url)
        return out


def resolve_direct(
    direct_lookup,
    *,
    tmdb_id: int | str,
    media_type: str,
    title: str,
    year,
    season: int,
    episode: int,
    refresh: bool,
    extra_requirements: Iterable[str] = (),
) -> Resolution:
    """Walk the chain for a title, direct catalog first.

    Order is the point. The direct catalog is a real MP4/HLS the native player
    boots without a third-party frame, so it is asked first and, when it hits,
    the request is done -- no embed is probed at all. Embeds are only walked
    when the direct catalog genuinely has nothing, which keeps the common path
    to a single lookup and keeps a dead embed from costing a viewer any latency.

    `direct_lookup` is injected rather than imported so the caller keeps
    ownership of caching and scraping, and so tests can drive the chain without
    touching the network.

    The embed phase is bounded by `EMBED_PHASE_BUDGET_SECONDS`. Probes are
    sequential, so an unbounded walk of seven dead providers would exceed the
    client's resolve timeout and return nothing at all -- worse than a shorter
    chain that answers. Priority order is preserved under the budget: the head
    of the chain is always probed, only the tail can be cut.
    """
    now = time.time()
    attempts: list[dict] = []
    deadline = time.monotonic() + EMBED_PHASE_BUDGET_SECONDS

    # ---- Phase 1: direct catalog -----------------------------------------
    # Only reachable for movies the catalog can actually be keyed by. A title
    # with extra requirements (subtitles, a specific quality tier) is not the
    # one Archive.org was scraped for.
    if media_type != "tv" and title and not tuple(extra_requirements):
        record = HEALTH.get(DIRECT_PROVIDER_ID)
        if record.available(now):
            direct_entry = None
            try:
                direct_entry = direct_lookup(title, year, refresh=refresh)
            except Exception as error:  # noqa: BLE001 - one provider failing is not fatal
                attempts.append(
                    {"id": DIRECT_PROVIDER_ID, "kind": "direct", "outcome": "error", "detail": type(error).__name__}
                )
            else:
                if direct_entry and direct_entry.get("stream_url"):
                    record.record_success(now)
                    winner = ResolvedProvider(
                        DIRECT_PROVIDER_ID,
                        "direct",
                        "Archive.org",
                        direct_entry.get("stream_url", ""),
                        payload=direct_entry,
                    )
                    attempts.append({"id": DIRECT_PROVIDER_ID, "kind": "direct", "outcome": "ok"})
                    return Resolution(winner, [winner] + _unprobed_embeds(tmdb_id, media_type, season, episode), attempts)
                attempts.append(
                    {"id": DIRECT_PROVIDER_ID, "kind": "direct", "outcome": "empty", "detail": "no direct source"}
                )
                # A miss is expensive to recompute (a full scrape), so it is
                # benched for longer than a transport blip.
                record.record_failure(now, "no direct source", DIRECT_MISS_COOLDOWN_SECONDS, FAILURE_THRESHOLD)
        else:
            attempts.append({"id": DIRECT_PROVIDER_ID, "kind": "direct", "outcome": "benched", "detail": record.last_error})
    else:
        attempts.append(
            {"id": DIRECT_PROVIDER_ID, "kind": "direct", "outcome": "skipped", "detail": "not addressable by the direct catalog"}
        )

    # ---- Phase 2: embeds --------------------------------------------------
    embed_candidates: list[ResolvedProvider] = []
    for provider in active_embed_providers():
        url = provider.build(tmdb_id, media_type, season, episode)
        if not url:
            attempts.append(
                {"id": provider.id, "kind": "embed", "outcome": "skipped", "detail": "no addressable url"}
            )
            continue
        record = HEALTH.get(provider.id)
        if not record.available(now):
            attempts.append(
                {"id": provider.id, "kind": "embed", "outcome": "benched", "detail": record.last_error}
            )
            continue

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            attempts.append({"id": provider.id, "kind": "embed", "outcome": "budget", "detail": "phase budget exhausted"})
            continue

        if not probe_provider(provider, url, min(EMBED_PROBE_TIMEOUT_SECONDS, remaining)):
            attempts.append(
                {"id": provider.id, "kind": "embed", "outcome": "unreachable", "detail": record.last_error}
            )
            continue
        embed_candidates.append(ResolvedProvider(provider.id, "embed", provider.label, url))

    if embed_candidates:
        return Resolution(embed_candidates[0], embed_candidates, attempts)

    return Resolution(None, [], attempts)


def _unprobed_embeds(tmdb_id: int | str, media_type: str, season: int, episode: int) -> list[ResolvedProvider]:
    """Embed URLs from the manifest, without paying a probe for any of them.

    Used when a direct source already won. The chain is still worth handing
    back -- if the direct MP4 dies mid-play the client needs somewhere to go --
    but nothing here has been liveness-checked, so each is marked unverified
    rather than passed off as a vetted candidate.
    """
    out: list[ResolvedProvider] = []
    for provider in active_embed_providers():
        url = provider.build(tmdb_id, media_type, season, episode)
        if url:
            out.append(ResolvedProvider(provider.id, "embed", provider.label, url, verified=False))
    return out
