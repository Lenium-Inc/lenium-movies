"""Tests for the provider chain: order, budgets, health, and exhaustion.

Run with:  python3 test_stream_providers.py

Why these exist
---------------
The chain in `stream_providers.py` is the thing that decides whether a viewer
sees a movie or an error, and its failure modes are all timing- and
order-sensitive, which is exactly the kind of code that passes inspection and
still breaks in production:

* Probing embeds before the direct catalog turned every request into a walk of
  the whole chain, so a single dead provider cost a viewer several seconds even
  when a perfectly good MP4 was sitting in the catalog.
* Sequential probes with no total budget meant a fully-down chain of seven
  providers blocked the worker for ~35s -- past the client's own 30s resolve
  timeout, so the request died before the chain had finished and the viewer was
  told "unavailable" when the answer was merely "slow".
* A benched provider that never got benched, or one that never recovered, is
  invisible in either direction: a chain that is too eager to retry and a chain
  that gives up on a provider permanently both look like "the provider is
  broken" from the outside.

The resolver is a pure function of (manifest, health, injected lookup), so
these tests drive it with an injected lookup and a stubbed probe. No network,
no Flask, no framework -- same harness style as test_hardening.py.
"""

import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import stream_providers  # noqa: E402


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


def _reset():
    """Clear all module-level chain state between tests."""
    stream_providers.HEALTH.reset()
    stream_providers.clear_probe_cache()


class _Chain:
    """A resolver run with a controlled probe outcome per provider.

    Only `probe_embed` -- the single function that touches a socket -- is
    replaced. The cache and the health accounting above it are the real
    implementations, so the circuit-breaker behaviour under test is the one
    that actually ships rather than a reimplementation of it.

    `probe` maps provider id -> value or callable(timeout) -> bool, so a test
    can make one provider slow (to exercise the budget) or dead (to exercise
    the walk) without a network anywhere.
    """

    def __init__(self, probe=None):
        self.probe = probe or {}
        self.probed = []

    def __call__(self, url, timeout=stream_providers.EMBED_PROBE_TIMEOUT_SECONDS):
        provider_id = stream_providers._provider_for_url(url)
        self.probed.append((provider_id, timeout))
        handler = self.probe.get(provider_id)
        if handler is None:
            return True
        return handler(timeout) if callable(handler) else handler

    @property
    def probed_ids(self):
        return [pid for pid, _ in self.probed]


def _resolve(chain, *, direct=None, media_type="movie", **overrides):
    calls = []

    def lookup(title, year=None, refresh=False):
        calls.append((title, year, refresh))
        return direct

    kwargs = dict(
        tmdb_id=603,
        media_type=media_type,
        title="The Matrix",
        year=1999,
        season=1,
        episode=1,
        refresh=False,
    )
    kwargs.update(overrides)
    original = stream_providers.probe_embed
    stream_providers.probe_embed = chain
    try:
        resolution = stream_providers.resolve_direct(lookup, **kwargs)
    finally:
        stream_providers.probe_embed = original
    resolution.lookup_calls = calls  # type: ignore[attr-defined]
    return resolution


def _direct(url="https://archive.org/download/x/master.mp4", **extra):
    entry = {"stream_url": url, "streams": []}
    entry.update(extra)
    return entry


# ---------------------------------------------------------------------------
# Manifest and configuration
# ---------------------------------------------------------------------------


def test_manifest_priorities_are_unique_and_ordered():
    priorities = [p.priority for p in stream_providers.EMBED_PROVIDERS]
    assert priorities == sorted(priorities), f"manifest is not in priority order: {priorities}"
    assert len(set(priorities)) == len(priorities), f"duplicate priorities: {priorities}"


def test_manifest_hostnames_are_unique():
    hosts = [p.host for p in stream_providers.EMBED_PROVIDERS]
    assert len(set(hosts)) == len(hosts), f"duplicate hosts in the manifest: {hosts}"


def test_env_order_reorders_without_dropping_providers():
    os.environ["STREAM_PROVIDER_ORDER"] = "multiembed, vidsrc"
    try:
        ids = [p.id for p in stream_providers.active_embed_providers()]
    finally:
        del os.environ["STREAM_PROVIDER_ORDER"]
    assert set(ids) == {p.id for p in stream_providers.EMBED_PROVIDERS}, (
        "a partial STREAM_PROVIDER_ORDER must not remove the providers it omits"
    )
    assert ids[:2] == ["multiembed", "vidsrc"], f"configured order not honoured: {ids}"


def test_env_disable_removes_a_provider():
    os.environ["STREAM_PROVIDER_DISABLED"] = "vidsrc, autoembed"
    try:
        ids = {p.id for p in stream_providers.active_embed_providers()}
    finally:
        del os.environ["STREAM_PROVIDER_DISABLED"]
    assert "vidsrc" not in ids and "autoembed" not in ids
    assert "vidsrc_to" in ids


def test_unknown_ids_in_env_order_degrade_to_the_default_chain():
    # A typo in a dashboard variable must not take playback down.
    os.environ["STREAM_PROVIDER_ORDER"] = "vidsrc,definitely_not_a_provider"
    try:
        ids = [p.id for p in stream_providers.active_embed_providers()]
    finally:
        del os.environ["STREAM_PROVIDER_ORDER"]
    assert ids[0] == "vidsrc"
    assert set(ids) == {p.id for p in stream_providers.EMBED_PROVIDERS}


# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------


def test_build_rejects_ids_that_are_not_addressable():
    provider = stream_providers.EMBED_PROVIDERS[0]
    for bad in ("", "  ", "12/../../etc", "abc?", None, "../../x", "a b"):
        assert provider.build(bad, "movie", 1, 1) == "", f"{bad!r} produced a URL"


def test_build_addresses_movie_and_tv_for_every_provider():
    for provider in stream_providers.EMBED_PROVIDERS:
        assert provider.build(603, "movie", 1, 1), f"{provider.id} has no movie url"
        tv = provider.build(603, "tv", 2, 5)
        assert tv, f"{provider.id} has no tv url"
        if provider.id == "autoembed":
            assert "season=2" in tv and "episode=5" in tv
        elif provider.id == "multiembed":
            assert "season=2" in tv and "episode=5" in tv
        else:
            assert tv.endswith("/2/5"), f"{provider.id} tv url lost the episode: {tv}"


def test_is_embed_host_matches_subdomains_but_not_lookalikes():
    assert stream_providers.is_embed_host("vidsrc.me")
    assert stream_providers.is_embed_host("www.vidsrc.me")
    assert stream_providers.is_embed_host("VIDSRC.ME")
    assert not stream_providers.is_embed_host("notvidsrc.me")
    assert not stream_providers.is_embed_host("vidsrc.me.evil.com")
    assert not stream_providers.is_embed_host("")


# ---------------------------------------------------------------------------
# Order: direct before embeds
# ---------------------------------------------------------------------------


def test_direct_hit_answers_without_probing_a_single_embed():
    # The regression that motivated the reordering: probing first made every
    # request pay for the whole chain even when the catalog had the title.
    _reset()
    chain = _Chain()
    resolution = _resolve(chain, direct=_direct())

    assert resolution.ok
    assert resolution.winner.id == stream_providers.DIRECT_PROVIDER_ID
    assert not resolution.is_embed
    assert chain.probed == [], f"embed probes ran despite a direct hit: {chain.probed_ids}"


def test_direct_hit_still_returns_a_fallback_chain_for_mid_play_death():
    # The direct MP4 can still die. The embed chain is the answer, but it was
    # never probed, so it must be reported as unverified rather than vetted.
    _reset()
    resolution = _resolve(_Chain(), direct=_direct())

    assert len(resolution.candidates) == 1 + len(stream_providers.EMBED_PROVIDERS)
    assert resolution.candidates[0].kind == "direct"
    assert all(c.verified is False for c in resolution.candidates[1:]), (
        "unprobed embeds must not be presented as verified candidates"
    )


def test_embed_is_attempted_when_the_direct_catalog_misses():
    _reset()
    resolution = _resolve(_Chain(), direct=None)

    assert resolution.ok
    assert resolution.is_embed
    assert resolution.winner.kind == "embed"
    outcomes = {a["id"]: a["outcome"] for a in resolution.attempts}
    assert outcomes[stream_providers.DIRECT_PROVIDER_ID] == "empty"


def test_direct_lookup_raising_does_not_take_playback_down():
    _reset()

    def boom(*args, **kwargs):
        raise RuntimeError("archive.org is down")

    original = stream_providers.probe_embed
    stream_providers.probe_embed = _Chain()
    try:
        resolution = stream_providers.resolve_direct(
            boom,
            tmdb_id=603,
            media_type="movie",
            title="The Matrix",
            year=1999,
            season=1,
            episode=1,
            refresh=False,
        )
    finally:
        stream_providers.probe_embed = original

    assert resolution.ok and resolution.is_embed
    outcomes = {a["id"]: a["outcome"] for a in resolution.attempts}
    assert outcomes[stream_providers.DIRECT_PROVIDER_ID] == "error"


def test_tv_skips_the_direct_catalog_entirely():
    # Archive.org entries are scraped per movie title; asking it for a tv
    # episode can only return the wrong thing.
    _reset()
    resolution = _resolve(_Chain(), direct=_direct(), media_type="tv")

    assert resolution.lookup_calls == [], f"direct catalog queried for tv: {resolution.lookup_calls}"
    outcomes = {a["id"]: a["outcome"] for a in resolution.attempts}
    assert outcomes[stream_providers.DIRECT_PROVIDER_ID] == "skipped"


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


def test_dead_provider_is_skipped_and_benched_after_repeated_failures():
    _reset()
    dead = {"vidsrc": False}

    for _ in range(stream_providers.FAILURE_THRESHOLD):
        _resolve(_Chain(dead), direct=None)

    record = stream_providers.HEALTH.get("vidsrc")
    assert record.consecutive_failures >= stream_providers.FAILURE_THRESHOLD
    assert not record.available(time.time()), "a repeatedly dead provider was never benched"

    chain = _Chain(dead)
    resolution = _resolve(chain, direct=None)
    assert "vidsrc" not in chain.probed_ids, "a benched provider was re-probed immediately"
    outcomes = {a["id"]: a["outcome"] for a in resolution.attempts}
    assert outcomes["vidsrc"] == "benched"


def test_a_provider_that_recovers_is_probed_again_and_clears_its_record():
    # Recovery, end to end. Once a provider is benched the chain stops probing
    # it, so the only way back is for the cooldown to expire and a fresh probe to
    # succeed. This drives that whole path, because a breaker that can never
    # re-admit a provider is a permanent outage caused by one bad minute.
    _reset()
    for _ in range(stream_providers.FAILURE_THRESHOLD):
        _resolve(_Chain({"vidsrc": False}), direct=None)

    record = stream_providers.HEALTH.get("vidsrc")
    assert not record.available(time.time()), "the provider was never benched"

    # Let the whole cooldown elapse: both the circuit and the cached negative
    # are on the same clock, so a real expiry re-probes.
    record.open_until = 0.0
    with stream_providers._probe_lock:
        stamp, ok = stream_providers._probe_cache["vidsrc"]
        stream_providers._probe_cache["vidsrc"] = (
            stamp - stream_providers.COOLDOWN_SECONDS - 1.0,
            ok,
        )
    resolution = _resolve(_Chain({"vidsrc": True}), direct=None)

    assert resolution.ok
    recovered = stream_providers.HEALTH.get("vidsrc")
    assert recovered.consecutive_failures == 0
    assert recovered.available(time.time())
    assert recovered.last_ok_at > 0.0


def test_a_benched_provider_is_not_probed_again_during_its_cooldown():
    # The flip side: recovery must not be so eager that a provider down for a
    # moment costs every request in the window a full probe timeout.
    _reset()
    for _ in range(stream_providers.FAILURE_THRESHOLD):
        _resolve(_Chain({"vidsrc": False}), direct=None)

    chain = _Chain({"vidsrc": True})
    _resolve(chain, direct=None)
    assert "vidsrc" not in chain.probed_ids, "a benched provider was probed inside its cooldown"


def test_health_resets_cooldown_on_success():
    _reset()
    record = stream_providers.HEALTH.get("vidsrc")
    record.record_failure(time.time(), "boom", stream_providers.COOLDOWN_SECONDS, 1)
    assert not record.available(time.time())

    record.record_success(time.time())
    assert record.available(time.time())
    assert record.last_error == ""


# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------


def test_embed_phase_budget_bounds_a_fully_down_chain():
    # Without a total budget, seven dead providers cost 7 x 5s = 35s of worker
    # time -- past the client's 30s resolve timeout, so the chain would be cut
    # off before it could answer at all.
    _reset()
    original = stream_providers.EMBED_PHASE_BUDGET_SECONDS
    stream_providers.EMBED_PHASE_BUDGET_SECONDS = 0.3
    try:
        started = time.monotonic()
        resolution = _resolve(
            _Chain({p.id: (lambda _t: (time.sleep(0.2), False)[1]) for p in stream_providers.EMBED_PROVIDERS}),
            direct=None,
        )
        elapsed = time.monotonic() - started
    finally:
        stream_providers.EMBED_PHASE_BUDGET_SECONDS = original

    assert elapsed < 1.5, f"a fully down chain overran its budget: {elapsed:.2f}s"
    assert not resolution.ok
    outcomes = [a["outcome"] for a in resolution.attempts if a["kind"] == "embed"]
    assert "budget" in outcomes, f"the budget never cut the tail short: {outcomes}"


def test_budget_is_spent_in_priority_order():
    # Under pressure the head of the chain must still get probed. Cutting the
    # head would make the answer depend on which providers happen to be slow.
    _reset()
    original = stream_providers.EMBED_PHASE_BUDGET_SECONDS
    stream_providers.EMBED_PHASE_BUDGET_SECONDS = 0.25
    first = stream_providers.EMBED_PROVIDERS[0].id
    try:
        chain = _Chain({p.id: (lambda _t: (time.sleep(0.2), False)[1]) for p in stream_providers.EMBED_PROVIDERS})
        _resolve(chain, direct=None)
    finally:
        stream_providers.EMBED_PHASE_BUDGET_SECONDS = original

    assert chain.probed_ids and chain.probed_ids[0] == first, (
        f"the first provider was skipped: {chain.probed_ids}"
    )


def test_individual_probe_timeout_is_capped_by_the_remaining_budget():
    _reset()
    original = stream_providers.EMBED_PHASE_BUDGET_SECONDS
    stream_providers.EMBED_PHASE_BUDGET_SECONDS = 2.0
    try:
        chain = _Chain({p.id: (lambda _t: (time.sleep(0.3), False)[1]) for p in stream_providers.EMBED_PROVIDERS})
        _resolve(chain, direct=None)
    finally:
        stream_providers.EMBED_PHASE_BUDGET_SECONDS = original

    for _, timeout in chain.probed:
        assert timeout <= stream_providers.EMBED_PROBE_TIMEOUT_SECONDS + 0.5, (
            f"a single probe was allowed {timeout:.1f}s, past the per-probe cap"
        )


# ---------------------------------------------------------------------------
# Exhaustion
# ---------------------------------------------------------------------------


def test_every_provider_failing_returns_exhaustion_not_a_partial_answer():
    _reset()
    resolution = _resolve(_Chain({p.id: False for p in stream_providers.EMBED_PROVIDERS}), direct=None)

    assert not resolution.ok
    assert resolution.winner is None
    assert resolution.url == ""
    assert resolution.candidates == []
    assert len([a for a in resolution.attempts if a["kind"] == "embed"]) == len(
        stream_providers.EMBED_PROVIDERS
    ), f"not every provider was attempted: {resolution.attempts}"


def test_a_late_provider_still_wins_when_earlier_ones_are_dead():
    # The whole point of ordering by priority: a chain is a *fallback*, so the
    # last provider has to be reachable when it is the only one alive.
    _reset()
    last = stream_providers.EMBED_PROVIDERS[-1].id
    only_last = {p.id: (p.id == last) for p in stream_providers.EMBED_PROVIDERS}

    resolution = _resolve(_Chain(only_last), direct=None)
    assert resolution.ok
    assert resolution.winner.id == last
    assert resolution.candidates == [resolution.winner], (
        "a chain with exactly one working provider must not claim the others"
    )


def test_the_earliest_working_provider_wins():
    # Symmetric guard: priority is not just a tiebreak, it decides the winner.
    _reset()
    first, second = stream_providers.EMBED_PROVIDERS[0].id, stream_providers.EMBED_PROVIDERS[1].id
    both = {p.id: (p.id in (first, second)) for p in stream_providers.EMBED_PROVIDERS}

    resolution = _resolve(_Chain(both), direct=None)
    assert resolution.winner.id == first
    assert [c.id for c in resolution.candidates] == [first, second]


def test_unaddressable_target_yields_no_embed_candidates():
    # A target that cannot be safely placed in a URL path must produce no
    # candidates at all, rather than a chain of URLs that 404 or, worse, point
    # somewhere unintended. Note the id is rejected on characters alone: the
    # route layer also requires a purely numeric TMDB id, but the registry must
    # not be the weaker link.
    _reset()
    chain = _Chain()
    resolution = _resolve(chain, tmdb_id="603/../../admin", direct=None)

    assert not resolution.ok
    assert resolution.candidates == []
    assert chain.probed == [], f"probed a provider that has no url for this target: {chain.probed_ids}"


def test_resolution_url_and_candidate_urls_dedupe():
    _reset()
    resolution = _resolve(_Chain(), direct=None)
    urls = resolution.candidate_urls()

    assert len(urls) == len(set(urls)), "the candidate list contains duplicates"
    assert urls and urls[0] == resolution.url


def _run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for fn in tests:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except Exception:
            failures += 1
            print(f"  FAIL  {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run() else 0)
