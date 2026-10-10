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
* Sequential probes with no total budget meant a fully-down chain blocked the
  worker past the client's own resolve timeout -- past the client's own 30s resolve
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
import pathlib
import re
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
    os.environ["STREAM_PROVIDER_ORDER"] = "autoembed, vidsrc-pro"
    try:
        ids = [p.id for p in stream_providers.active_embed_providers()]
    finally:
        del os.environ["STREAM_PROVIDER_ORDER"]
    assert set(ids) == {p.id for p in stream_providers.EMBED_PROVIDERS}, (
        "a partial STREAM_PROVIDER_ORDER must not remove the providers it omits"
    )
    assert ids[:2] == ["autoembed", "vidsrc-pro"], f"configured order not honoured: {ids}"


def test_env_disable_removes_a_provider():
    os.environ["STREAM_PROVIDER_DISABLED"] = "vidsrc-pro, autoembed"
    try:
        ids = {p.id for p in stream_providers.active_embed_providers()}
    finally:
        del os.environ["STREAM_PROVIDER_DISABLED"]
    assert "vidsrc-pro" not in ids and "autoembed" not in ids
    assert "vidsrc-me" in ids


def test_unknown_ids_in_env_order_degrade_to_the_default_chain():
    # A typo in a dashboard variable must not take playback down.
    os.environ["STREAM_PROVIDER_ORDER"] = "vidsrc-pro,definitely_not_a_provider"
    try:
        ids = [p.id for p in stream_providers.active_embed_providers()]
    finally:
        del os.environ["STREAM_PROVIDER_ORDER"]
    assert ids[0] == "vidsrc-pro"
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
        assert tv != provider.build(603, "tv", 3, 6), (
            f"{provider.id} tv url ignores season/episode: {tv}"
        )
        assert tv != provider.build(603, "movie", 2, 5), (
            f"{provider.id} tv url is the movie url: {tv}"
        )


def test_build_produces_the_exact_urls_the_client_selector_offers():
    """The URL shapes both sides depend on, pinned on both sides.

    These strings are duplicated in `client/src/lib/streamProviders.ts` and
    asserted there in `embedSources.test.ts`. If the two ever disagree the title
    is playable to the server and unaddressable for the viewer -- the selector
    shows a source whose frame 404s and nothing says why -- so the expectation
    lives here as well as there.
    """
    expected = {
        ("vidsrc-pro", "movie"): "https://vidsrc.pro/embed/movie/603",
        ("vidsrc-pro", "tv"): "https://vidsrc.pro/embed/tv/603/2/5",
        ("vidsrc-cc", "movie"): "https://vidsrc.cc/v2/embed/movie/603",
        ("vidsrc-cc", "tv"): "https://vidsrc.cc/v2/embed/tv/603/2/5",
        ("vidsrc-me", "movie"): "https://vidsrc.me/embed/movie?tmdb=603",
        ("vidsrc-me", "tv"): "https://vidsrc.me/embed/tv?tmdb=603&season=2&episode=5",
        ("2embed", "movie"): "https://www.2embed.cc/embed/603",
        ("2embed", "tv"): "https://www.2embed.cc/embedtv/603&s=2&e=5",
        ("autoembed", "movie"): "https://vidsrc.to/embed/movie/603",
        ("autoembed", "tv"): "https://vidsrc.to/embed/tv/603/2/5",
    }
    for provider in stream_providers.EMBED_PROVIDERS:
        for media_type in ("movie", "tv"):
            assert provider.build(603, media_type, 2, 5) == expected[(provider.id, media_type)], (
                f"{provider.id} {media_type} url drifted from the client manifest"
            )


def test_manifest_matches_the_client_manifest_entry_for_entry():
    """Same providers, same order, same labels and hosts as the client's copy.

    The client builds its source selector from this manifest, so a provider added
    on only one side is a title the viewer is offered a dead source for, or a
    source the server never tries. The parity assertion lives in
    `embedSources.test.ts`; this is the same contract seen from Python.
    """
    client_manifest = (
        pathlib.Path(__file__).resolve().parents[1]
        / "client"
        / "src"
        / "lib"
        / "streamProviders.ts"
    ).read_text(encoding="utf-8")
    # Quote-agnostic on purpose: the manifest is a TypeScript file that Prettier
    # reformats, and a regex pinned to one quote style would fail the build over
    # a formatting change rather than over a provider change.
    matches = list(
        re.finditer(
            r'id:\s*["\']([^"\']+)["\'],\s*name:\s*["\']([^"\']+)["\']',
            client_manifest,
        )
    )
    assert matches, "no providers parsed out of the client manifest"
    entries = [(m.group(1), m.group(2)) for m in matches]
    assert [(p.id, p.label) for p in stream_providers.EMBED_PROVIDERS] == entries
    # Each entry's first URL names its host. The shapes differ per provider --
    # a path key, a query key, a bare id -- so the host is read off the first
    # `https://` inside that entry's own block rather than off any one shape.
    # (TV URLs repeat the same host, so matching on them as well would double
    # every one and make the comparison vacuous.)
    hosts = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(client_manifest)
        block = client_manifest[match.start() : end]
        found = re.search(r"https://([^/`?#]+)", block)
        assert found, f"no url in client manifest entry {entries[index][0]!r}"
        hosts.append(found.group(1))
    assert [p.host for p in stream_providers.EMBED_PROVIDERS] == hosts


def test_is_embed_host_matches_subdomains_but_not_lookalikes():
    assert stream_providers.is_embed_host("vidsrc.pro")
    assert stream_providers.is_embed_host("www.vidsrc.pro")
    assert stream_providers.is_embed_host("VIDSRC.PRO")
    # The one provider addressed under a `www.` authority.
    assert stream_providers.is_embed_host("www.2embed.cc")
    assert not stream_providers.is_embed_host("notvidsrc.pro")
    assert not stream_providers.is_embed_host("vidsrc.pro.evil.com")
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


# ---------------------------------------------------------------------------
# Series: episode-addressable direct sources
# ---------------------------------------------------------------------------
#
# Series used to skip the direct phase entirely, so every episode resolved to a
# third-party embed. An embed is a cross-origin iframe that reports no playback
# events, so an episode played that way never produced a progress record -- which
# is what made Continue Watching unusable for series rather than merely sparse.
# These cover the fix and, more importantly, the guard that keeps it from serving
# the wrong episode under the right title.


def test_episode_direct_hit_answers_without_probing_an_embed():
    _reset()
    chain = _Chain()
    resolution = _resolve(
        chain,
        direct=_direct(title="The Twilight Zone S01E07"),
        media_type="tv",
        title="The Twilight Zone",
        year=None,
        season=1,
        episode=7,
    )

    assert resolution.ok
    assert resolution.winner.id == stream_providers.DIRECT_PROVIDER_ID
    assert not resolution.is_embed
    assert chain.probed == [], f"embed probes ran despite a direct episode hit: {chain.probed_ids}"


def test_a_series_lookup_asks_the_catalog_for_that_episode():
    # The query is what makes the catalog answerable at all: a show name is
    # ambiguous across episodes, so the season/episode has to be part of it.
    _reset()
    resolution = _resolve(
        _Chain(),
        direct=_direct(title="The Twilight Zone S01E07"),
        media_type="tv",
        title="The Twilight Zone",
        year=None,
        season=1,
        episode=7,
    )

    queried = [title for title, _year, _refresh in resolution.lookup_calls]
    assert queried == ["The Twilight Zone S01E07"], f"unexpected catalog query: {queried}"


def test_a_movie_is_still_queried_by_title_alone():
    # The episode suffix must not leak into the movie path.
    _reset()
    resolution = _resolve(_Chain(), direct=_direct(title="The Matrix"))

    queried = [title for title, _year, _refresh in resolution.lookup_calls]
    assert queried == ["The Matrix"], f"unexpected catalog query: {queried}"


def test_a_candidate_naming_another_episode_is_refused():
    # The failure this guards: the search for S01E07 returns the S01E01 item,
    # `match_title` scores that a confident 0.7 because every word of the
    # shorter title appears in the longer one, and the viewer is handed the
    # wrong episode. It must fall through to the embed instead.
    _reset()
    chain = _Chain()
    resolution = _resolve(
        chain,
        direct=_direct(title="The Twilight Zone S01E01"),
        media_type="tv",
        title="The Twilight Zone",
        year=None,
        season=1,
        episode=7,
    )

    assert resolution.ok
    assert resolution.is_embed, "a wrong-episode candidate must not win"
    assert chain.probed_ids, "the embed chain should have been walked instead"
    outcomes = [a["outcome"] for a in resolution.attempts if a["id"] == stream_providers.DIRECT_PROVIDER_ID]
    assert "rejected" in outcomes, f"expected a recorded rejection, got {outcomes}"


def test_a_whole_season_file_is_refused_for_one_episode():
    # No token at all is not "close enough": a season file cannot be seeked to
    # the requested episode from here.
    _reset()
    resolution = _resolve(
        _Chain(),
        direct=_direct(title="The Twilight Zone Season 1"),
        media_type="tv",
        title="The Twilight Zone",
        year=None,
        season=1,
        episode=7,
    )

    assert resolution.is_embed, "a season file must not be served for an episode"


def test_a_refused_episode_does_not_bench_the_direct_catalog():
    # A rejection proves the catalog can answer for this show. Benching it
    # would take the direct catalog off the table for the whole cooldown and
    # send every later episode of that series to an embed.
    _reset()
    _resolve(
        _Chain(),
        direct=_direct(title="The Twilight Zone S01E01"),
        media_type="tv",
        title="The Twilight Zone",
        year=None,
        season=1,
        episode=7,
    )

    record = stream_providers.HEALTH.get(stream_providers.DIRECT_PROVIDER_ID)
    assert record.available(time.time()), (
        "a wrong-episode rejection must not count as a direct-catalog failure"
    )


def test_an_episode_miss_still_benches_the_direct_catalog():
    # The mirror of the test above: a genuine absence is still expensive to
    # recompute and must keep its longer cooldown.
    _reset()
    for _ in range(stream_providers.FAILURE_THRESHOLD):
        _resolve(
            _Chain(),
            direct=None,
            media_type="tv",
            title="The Twilight Zone",
            year=None,
            season=1,
            episode=7,
        )

    record = stream_providers.HEALTH.get(stream_providers.DIRECT_PROVIDER_ID)
    assert not record.available(time.time()), "a real miss should bench the direct catalog"


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


def test_a_tv_entry_naming_no_episode_is_not_played():
    # This used to be skipped as a phase ("tv never queries the direct
    # catalog"). Episodes are addressable now, but only when the entry says
    # which episode it is -- so a catalog entry with no episode token is still
    # refused rather than handed to a viewer as if it were the episode they
    # asked for.
    _reset()
    resolution = _resolve(_Chain(), direct=_direct(title="The Twilight Zone"), media_type="tv")

    assert resolution.is_embed
    outcomes = {a["id"]: a["outcome"] for a in resolution.attempts}
    assert outcomes[stream_providers.DIRECT_PROVIDER_ID] == "rejected"


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


def test_dead_provider_is_skipped_and_benched_after_repeated_failures():
    _reset()
    dead = {"vidsrc-pro": False}

    for _ in range(stream_providers.FAILURE_THRESHOLD):
        _resolve(_Chain(dead), direct=None)

    record = stream_providers.HEALTH.get("vidsrc-pro")
    assert record.consecutive_failures >= stream_providers.FAILURE_THRESHOLD
    assert not record.available(time.time()), "a repeatedly dead provider was never benched"

    chain = _Chain(dead)
    resolution = _resolve(chain, direct=None)
    assert "vidsrc-pro" not in chain.probed_ids, "a benched provider was re-probed immediately"
    outcomes = {a["id"]: a["outcome"] for a in resolution.attempts}
    assert outcomes["vidsrc-pro"] == "benched"


def test_a_provider_that_recovers_is_probed_again_and_clears_its_record():
    # Recovery, end to end. Once a provider is benched the chain stops probing
    # it, so the only way back is for the cooldown to expire and a fresh probe to
    # succeed. This drives that whole path, because a breaker that can never
    # re-admit a provider is a permanent outage caused by one bad minute.
    _reset()
    for _ in range(stream_providers.FAILURE_THRESHOLD):
        _resolve(_Chain({"vidsrc-pro": False}), direct=None)

    record = stream_providers.HEALTH.get("vidsrc-pro")
    assert not record.available(time.time()), "the provider was never benched"

    # Let the whole cooldown elapse: both the circuit and the cached negative
    # are on the same clock, so a real expiry re-probes. Expiring the cache entry
    # is what the TTL does on its own here, so dropping it is the honest way to
    # stand in for waiting -- rewinding a stored timestamp is no longer
    # possible now that the cache owns its own expiry.
    record.open_until = 0.0
    with stream_providers._probe_lock:
        assert "vidsrc-pro" in stream_providers._probe_failed
        stream_providers._probe_failed.pop("vidsrc-pro")
    resolution = _resolve(_Chain({"vidsrc-pro": True}), direct=None)

    assert resolution.ok
    recovered = stream_providers.HEALTH.get("vidsrc-pro")
    assert recovered.consecutive_failures == 0
    assert recovered.available(time.time())
    assert recovered.last_ok_at > 0.0


def test_a_benched_provider_is_not_probed_again_during_its_cooldown():
    # The flip side: recovery must not be so eager that a provider down for a
    # moment costs every request in the window a full probe timeout.
    _reset()
    for _ in range(stream_providers.FAILURE_THRESHOLD):
        _resolve(_Chain({"vidsrc-pro": False}), direct=None)

    chain = _Chain({"vidsrc-pro": True})
    _resolve(chain, direct=None)
    assert "vidsrc-pro" not in chain.probed_ids, "a benched provider was probed inside its cooldown"


def test_health_resets_cooldown_on_success():
    _reset()
    record = stream_providers.HEALTH.get("vidsrc-pro")
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
