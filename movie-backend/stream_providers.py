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
from dataclasses import dataclass, field
from typing import Iterable

import requests
from cachetools import TTLCache

import catalog_lib
from runtime_config import load_env_file

load_env_file()

#: Identity the health probe presents to a provider.
#:
#: The backend's own UA used to go out on this request, and every probe came
#: back dead while the same URL played fine in a browser. These hosts sit
#: behind Cloudflare WAFs that fingerprint the client before the origin is
#: ever reached: a non-browser UA is challenged or dropped outright, so the
#: probe was reading `403`/`301` off a bot wall and benching a host that
#: serves a real viewer perfectly. The probe now asks the same question the
#: player will ask, from the same side of the WAF.
PROBE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

#: Character class a TMDB id (or manifest-supplied id) must match before it is
#: allowed anywhere in a provider URL. Mirrors `safeStreamId` in
#: `client/src/lib/streamProviders.ts`; the two must stay identical.
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

    #: The provider's two URL shapes, as format templates. `{id}` is the TMDB
    #: id (already restricted to `[A-Za-z0-9-]`); `{season}` and `{episode}`
    #: appear only in the TV shape.
    #:
    #: The shapes are declared rather than derived from the host because they
    #: genuinely differ: vidsrc.cc is served under `/v2`, vidsrc.me keys the id
    #: in a query string, and 2Embed addresses a movie by bare id with no
    #: `movie` segment at all. The old builder inferred one `/embed/...`
    #: convention from the provider id, which is exactly the kind of drift that
    #: produced URLs the client then refused to recognise.
    movie_url: str
    tv_url: str

    def build(self, tmdb_id: int | str, media_type: str, season: int, episode: int) -> str:
        """Addressable URL for this provider, or "" if the target cannot be keyed.

        URL shapes are duplicated verbatim in `client/src/lib/streamProviders.ts`.
        That duplication is deliberate but fragile, so the two are asserted
        against each other in `embedSources.test.ts`: a provider whose builder
        drifts here is a title the backend will hand to the player and the
        client will not recognise as an embed.
        """
        safe = _safe_id(tmdb_id)
        if not safe:
            return ""

        template = self.tv_url if media_type == "tv" else self.movie_url
        try:
            return template.format(id=safe, season=season, episode=episode)
        except (KeyError, IndexError, ValueError):
            # A placeholder the template never declared is a manifest typo.
            # Refusing to build is a title with no URL, which the resolver
            # already reports as skipped -- far better than emitting a
            # malformed URL that fails somewhere downstream.
            return ""


def _safe_id(value: object) -> str:
    """Target ids reach a provider URL (path or query), so only `[A-Za-z0-9-]`
    is ever allowed.

    `/api/get-stream` validates with `_parse_tmdb_id`, but this registry is
    also driven by manifest data and must not be the weaker link. The character
    class matches the TypeScript `safeStreamId` exactly so a value accepted by
    one side is never rejected by the other.
    """
    if value is None:
        return ""
    text = str(value).strip()
    return text if text and _SAFE_ID_PATTERN.fullmatch(text) else ""


#: Ordered chain. Priority is the failover order and is asserted against
#: `client/src/lib/streamProviders.ts` in `embedSources.test.ts` -- the client
#: selector is generated from this same order, so the two cannot disagree about
#: which source a viewer is offered first.
#:
#: Labels say what a source *is* rather than counting it. "Server 3" told a
#: viewer nothing about the hosts behind it and gave them no reason to try
#: the next one when the frame went blank; the label now carries the quality
#: tier that actually differs between them.
EMBED_PROVIDERS: tuple[EmbedProvider, ...] = (
    EmbedProvider(
        "vidsrc-pro",
        "Prime HD",
        "vidsrc.pro",
        10,
        "https://vidsrc.pro/embed/movie/{id}",
        "https://vidsrc.pro/embed/tv/{id}/{season}/{episode}",
    ),
    EmbedProvider(
        "vidsrc-cc",
        "Cinema Plus",
        "vidsrc.cc",
        20,
        "https://vidsrc.cc/v2/embed/movie/{id}",
        "https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}",
    ),
    EmbedProvider(
        "vidsrc-me",
        "Home Stream",
        "vidsrc.me",
        30,
        "https://vidsrc.me/embed/movie?tmdb={id}",
        "https://vidsrc.me/embed/tv?tmdb={id}&season={season}&episode={episode}",
    ),
    EmbedProvider(
        "2embed",
        "Studio HD",
        "www.2embed.cc",
        40,
        "https://www.2embed.cc/embed/{id}",
        "https://www.2embed.cc/embedtv/{id}&s={season}&e={episode}",
    ),
    EmbedProvider(
        "autoembed",
        "Backup Stream",
        "vidsrc.to",
        50,
        "https://vidsrc.to/embed/movie/{id}",
        "https://vidsrc.to/embed/tv/{id}/{season}/{episode}",
    ),
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
#: without this a fully-down chain of five providers would block the worker for
#: `5 * EMBED_PROBE_TIMEOUT_SECONDS` -- past the client-side resolve timeout, so
#: the request would die before the chain had even finished. The budget is spent
#: in priority order: providers earlier in the chain are guaranteed a probe,
#: and only the tail is ever cut short. Sized for the five-provider manifest --
#: probing three of five inside 12s beats returning nothing at all.
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
#: provider id -> liveness verdict, split by polarity because the two verdicts
#: have to expire on different clocks.
#:
#: Keyed by provider rather than by URL because a provider is a host, and one
#: reachability answer covers every title it is asked about.
#:
#: The split is the point. A cached *negative* is only trusted for as long as the
#: provider would have stayed benched anyway. If it outlived the cooldown, the
#: chain would keep re-benching a provider on the strength of an answer that is
#: now older than the timeout it was meant to be benched for, and it would never
#: re-probe -- so a provider that came back would stay invisible until the full
#: TTL elapsed. A cached positive can safely live longer, since being optimistic
#: only costs a failed frame that the client watchdog handles.
#:
#: One dict with a single TTL cannot express that, and picking either TTL makes
#: the other verdict wrong. Both are `TTLCache`s, so both are bounded and both
#: expire themselves -- there is no timestamp bookkeeping left to get wrong.
#: The bound is generous: the key space is the provider manifest, not titles.
_PROBE_CACHE_MAX_SIZE = 1000
_probe_healthy: TTLCache = TTLCache(
    maxsize=_PROBE_CACHE_MAX_SIZE, ttl=EMBED_PROBE_TTL_SECONDS
)
_probe_failed: TTLCache = TTLCache(
    maxsize=_PROBE_CACHE_MAX_SIZE, ttl=COOLDOWN_SECONDS
)


def _probe_cached(provider_id: str) -> bool | None:
    """The cached verdict for a provider, or None if there is a live one.

    Caller must hold `_probe_lock`.
    """
    if provider_id in _probe_healthy:
        return True
    if provider_id in _probe_failed:
        return False
    return None


def _probe_record(provider_id: str, ok: bool) -> None:
    """Store a verdict, dropping any opposite one.

    Caller must hold `_probe_lock`. Clearing the other container matters: with
    one dict the write overwrote the previous value, and here a leftover positive
    would keep answering for a provider that has just been recorded as dead.
    """
    if ok:
        _probe_failed.pop(provider_id, None)
        _probe_healthy[provider_id] = True
    else:
        _probe_healthy.pop(provider_id, None)
        _probe_failed[provider_id] = False


def _is_cross_origin_framable(headers) -> bool:
    """Whether the response permits being framed by a different origin.

    Reachability is not the same question as framability, and for an embed
    provider only the second one matters: a host that answers a perfectly good
    `200` while declaring `X-Frame-Options: SAMEORIGIN` will render nothing at
    all inside our `<iframe>`, and the viewer sees a black rectangle with no
    error and no way to tell it from a slow page.

    That is not hypothetical. `vidsrc.cc` answers `403` *and*
    `X-Frame-Options: SAMEORIGIN`, and a scoring rule that read those headers
    off the `403` would bench the host for a policy the *challenge page*
    declared. `probe_embed` therefore applies this check only to a real `2xx`
    response: a `403` from a WAF is a verdict on the client, not on the page,
    and the headers describing it say nothing about what the browser will be
    allowed to frame once the challenge clears.

    Both headers are honoured because they are independent and both are common:

    * `X-Frame-Options: SAMEORIGIN` / `DENY` blocks all cross-origin framing.
      `ALLOW-FROM` is long dead and ignored by browsers, so it is not honoured.
    * CSP `frame-ancestors` supersedes `X-Frame-Options` where they disagree,
      and a directive that is present at all narrows who may embed. Only `*` is
      treated as permitting us: anything else names specific allowed ancestors,
      and this probe does not know our own origin to check them against. That is
      a deliberate refusal to guess -- an allowlist we cannot evaluate is not
      one we may assume we satisfy, and admitting the provider on the hope that
      it works is exactly the failure this function exists to prevent.

    Returns True when no framing restriction is declared at all, which is the
    common case and must not be treated as a failure.
    """
    try:
        xfo = (headers.get("X-Frame-Options") or "").strip().upper()
        if xfo in ("SAMEORIGIN", "DENY"):
            return False

        csp = headers.get("Content-Security-Policy") or ""
        for directive in csp.split(";"):
            name, _, value = directive.partition(" ")
            if name.strip().lower() != "frame-ancestors":
                continue
            allowed = {token.strip().lower() for token in value.split()}
            # '*' allows any embedding origin. Anything narrower cannot be
            # matched against our origin without knowing it, and an allowlist we
            # cannot satisfy is, from the frame's point of view, a refusal.
            if "*" not in allowed:
                return False
            return True
    except Exception:  # noqa: BLE001 - odd header objects must not break a probe
        return True

    return True


def probe_embed(url: str, timeout: float = EMBED_PROBE_TIMEOUT_SECONDS) -> bool:
    """One shallow liveness check against a provider's embed page.

    Deliberately shallow: a GET that only asks whether the host responds. It
    cannot tell whether the provider actually carries the title -- nothing
    server-side can, short of scraping and parsing a player -- so it is a
    liveness signal, not a content guarantee. That is the same guarantee the
    frontend's iframe watchdog gives, and it is enough to keep a dead host out
    of the chain.

    Liveness here means *the host answered*, not *the host answered 200*:

    * `200`/`206` -- the page came back. It is also the only status whose
      headers describe the page that would actually be framed, so it is the
      only one put through `_is_cross_origin_framable`.
    * `301`/`302`/`307`/`308` -- DNS, TLS and HTTP all worked; the origin
      moved the request somewhere else. The browser follows that chain
      itself, and this probe deliberately does not (`allow_redirects=False`),
      because chasing a WAF's challenge redirect server-side is how a probe
      burns its whole timeout in a loop the client would have exited.
    * `403` (and `401`/`429`) -- a Cloudflare bot challenge, a rate limit, or
      a WAF rule that fired on our client class. The host is demonstrably up;
      it is the *client* it refused, and the viewer's browser is a different
      client. Its headers describe the challenge page, not the real one, so
      they are not judged as framing policy.
    * `5xx` -- the origin is up but failing to serve, which is what a dead
      provider looks like from here. Benched.
    * A transport exception (connection refused, timeout, DNS failure, TLS
      failure) -- nothing answered. Benched.

    In short: any HTTP response is evidence of a live host, and only a
    transport failure or a server error is evidence of a dead one. The old
    rule read a WAF handshake as a bench, which is how healthy providers were
    being benched while the same URLs played in a browser.

    No caching and no health accounting here. Both belong to `probe_provider`,
    which is the seam the resolver uses, so a chain can be driven without a
    socket anywhere.
    """
    if not url:
        return False
    try:
        response = requests.get(
            url,
            headers={
                "User-Agent": PROBE_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Range": "bytes=0-1023",
            },
            timeout=timeout,
            allow_redirects=False,
        )
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        # ConnectionError is where requests files DNS failures (socket.gaierror),
        # refused connections and TLS handshake failures: the host never
        # answered. Timeout is the same verdict reached more slowly.
        return False
    except requests.exceptions.RequestException:
        # Anything else transport-shaped (bad URL, unsupported scheme) is not
        # a provider that can serve a viewer either.
        return False
    except Exception:  # noqa: BLE001 - any transport error means "not up"
        return False

    status = response.status_code
    if status >= 500:
        return False
    if 200 <= status < 300:
        return _is_cross_origin_framable(response.headers)
    return True


def probe_provider(provider: EmbedProvider, url: str, timeout: float) -> bool:
    """Probe a provider, caching the result and recording the outcome.

    Caching matters because the chain is walked on every resolve: without it,
    a healthy provider would cost a real network request per title per viewer.

    Health accounting is here rather than in `probe_embed` because the resolver
    needs the provider *id* to attribute the outcome, and because a cached
    negative must still count as a failure. That last part is the whole reason
    the cache is not just a shortcut: if only fresh probes were counted, a dead
    provider would be asked once per TTL forever and its failure count would
    never reach the threshold, so the circuit would never open and the breaker
    would be decorative. A cached negative is still evidence the provider is
    down, and each request that observes it is a genuine independent attempt.

    By the time a False reaches here it means transport failure or `5xx` --
    `probe_embed` already decided that a WAF `403` or a redirect is a live
    host -- so what is recorded as a failure is genuinely a dead provider.
    """
    with _probe_lock:
        cached = _probe_cached(provider.id)

    if cached is not None:
        ok = cached
        # Fall through to accounting, but skip the network call.
    else:
        ok = probe_embed(url, timeout=timeout)
        with _probe_lock:
            _probe_record(provider.id, ok)

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
        _probe_healthy.clear()
        _probe_failed.clear()


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

    def candidate_entries(self) -> list[dict]:
        """The chain in the one shape every client of the resolver expects.

        `{name, url, is_embed}`, winner first, deduplicated by URL. The client
        walks this list on its own timer instead of asking the server again, so
        the order and the labels here are the whole contract -- a consumer that
        had to correlate `candidates` against the manifest to learn a URL's
        provider would drift from it the moment the manifest and the resolution
        disagreed.
        """
        seen: set[str] = set()
        out: list[dict] = []
        for candidate in self.candidates:
            if not candidate.url or candidate.url in seen:
                continue
            seen.add(candidate.url)
            out.append(
                {
                    "name": candidate.label,
                    "url": candidate.url,
                    "is_embed": candidate.kind == "embed",
                }
            )
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
    sequential, so an unbounded walk of dead providers would exceed the
    client's resolve timeout and return nothing at all -- worse than a shorter
    chain that answers. Priority order is preserved under the budget: the head
    of the chain is always probed, only the tail can be cut.
    """
    now = time.time()
    attempts: list[dict] = []
    deadline = time.monotonic() + EMBED_PHASE_BUDGET_SECONDS

    # ---- Phase 1: direct catalog -----------------------------------------
    # A title with extra requirements (subtitles, a specific quality tier) is not
    # the one Archive.org was scraped for.
    #
    # Series used to be excluded outright (`media_type != "tv"`), because the
    # catalog is keyed by title and a show name does not identify one episode.
    # That made every episode embed-only, and an embed reports no playback
    # events, so no progress was ever recorded for a series -- Continue Watching
    # could only ever fill from films. Archive.org indexes public-domain series
    # one item per episode, titled `Show S01E02`, so an episode is addressable
    # after all: ask for that exact query, then refuse anything whose title does
    # not name the same episode.
    if title and not tuple(extra_requirements):
        wants_episode = media_type == "tv"
        lookup_title = (
            catalog_lib.episode_query(title, season, episode) if wants_episode else title
        )
        record = HEALTH.get(DIRECT_PROVIDER_ID)
        if record.available(now):
            direct_entry = None
            try:
                direct_entry = direct_lookup(lookup_title, year, refresh=refresh)
            except Exception as error:  # noqa: BLE001 - one provider failing is not fatal
                attempts.append(
                    {"id": DIRECT_PROVIDER_ID, "kind": "direct", "outcome": "error", "detail": type(error).__name__}
                )
            else:
                wrong_episode = bool(
                    direct_entry
                    and direct_entry.get("stream_url")
                    and wants_episode
                    and not catalog_lib.accept_episode(
                        direct_entry.get("title") or "", season, episode
                    )
                )
                if wrong_episode:
                    # A confident title match on the wrong episode. Left to the
                    # generic "empty" path this would look like a catalog miss
                    # and bench the provider, hiding a title that does have a
                    # direct file under its correct name.
                    attempts.append(
                        {
                            "id": DIRECT_PROVIDER_ID,
                            "kind": "direct",
                            "outcome": "rejected",
                            "detail": "candidate does not name the requested episode",
                        }
                    )
                elif direct_entry and direct_entry.get("stream_url"):
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
                else:
                    attempts.append(
                        {"id": DIRECT_PROVIDER_ID, "kind": "direct", "outcome": "empty", "detail": "no direct source"}
                    )
                    # A miss is expensive to recompute (a full scrape), so it is
                    # benched for longer than a transport blip. Only a real miss
                    # benches it: a wrong-episode rejection proves the catalog
                    # answerable this show, and benching on that would take the
                    # direct catalog off the table for the whole cooldown.
                    record.record_failure(
                        now, "no direct source", DIRECT_MISS_COOLDOWN_SECONDS, FAILURE_THRESHOLD
                    )
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


def planned_candidate_entries(
    tmdb_id: int | str, media_type: str, season: int, episode: int
) -> list[dict]:
    """The full manifest chain for a target, as `{name, url, is_embed}` entries.

    Nothing here is liveness-checked -- these are the URLs every configured
    provider *would* serve, in priority order, for the addresses to hand the
    client when a resolution came back empty.

    A resolution can legitimately be empty: every provider benched, every probe
    timed out, the embed phase budget spent. Answering with `providers: []` in
    that case leaves the client with nothing to try and no way to tell "no such
    title" from "everything was down", so it can only show a dead end. Emitting
    the planned chain instead means the caller always hands back an ordered list
    for an addressable target, and whether an entry was verified travels with it
    (`Resolution.candidate_entries` covers only probed candidates).
    """
    return [
        {
            "name": provider.label,
            "url": url,
            "is_embed": True,
        }
        for provider in active_embed_providers()
        if (url := provider.build(tmdb_id, media_type, season, episode))
    ]
