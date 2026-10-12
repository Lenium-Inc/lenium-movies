"""Tests for the extractor's HLS ladder pass-through and quality labels.

Run with:  python3 test_stream_ladder.py

Why these exist
---------------
The client can only offer every rung a source actually has -- 4K and 8K
included -- plus the `#EXT-X-MEDIA` audio groups a dubbed film needs, if the
*master* playlist reaches it. The extractor used to return only the master's
split children, which silently threw the ladder and the audio groups away the
moment hls.js loaded a single-quality media playlist. These tests pin the
master-first contract, the 8K label tier, and the ordering that makes the
master the default stream.

Everything here is a pure function of a stubbed fetch -- no network, no
Flask, same harness style as test_stream_manifest.py.
"""

import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extractors  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

MASTER = "\n".join(
    [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Korean",LANGUAGE="ko",'
        'DEFAULT=YES,URI="audio/ko.m3u8"',
        "#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360",
        "v/360.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160",
        "v/2160.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=7680x4320",
        "v/4320.m3u8",
        "",
    ]
)

MEDIA = "#EXTM3U\n#EXTINF:4,\nseg/1.m4s\n#EXTINF:4,\nseg/2.m4s\n"


class _Response:
    def __init__(self, text: str):
        self.text = text


def _stub_get(text: str):
    def _get(url, referer="", timeout=None):
        return _Response(text)

    return _get


def _with_get(text: str, fn):
    original = extractors._get
    extractors._get = _stub_get(text)
    try:
        return fn()
    finally:
        extractors._get = original


# ---------------------------------------------------------------------------
# Master pass-through
# ---------------------------------------------------------------------------


def test_the_master_is_the_first_stream():
    # The default stream the client opens is streams[0]. It has to be the
    # master, or hls.js loads one child and the whole ladder (and every
    # alternate audio group) is invisible for the session.
    out = _with_get(MASTER, lambda: extractors._streams_from(
        "https://cdn.test/h/master.m3u8", "https://cdn.test/"
    ))
    assert out[0]["url"] == "https://cdn.test/h/master.m3u8", out


def test_the_master_carries_the_best_rungs_label():
    # A bare "Auto" label would sort the master last (see _order) and hand the
    # default slot to a child, undoing the whole point of the pass-through.
    out = _with_get(MASTER, lambda: extractors._streams_from(
        "https://cdn.test/h/master.m3u8", "https://cdn.test/"
    ))
    assert out[0]["label"] == "8K", out[0]


def test_the_children_stay_as_failover_candidates():
    # They are same-CDN siblings of the master, so they cost nothing and keep
    # source cycling alive if the master route ever fails for a host.
    out = _with_get(MASTER, lambda: extractors._streams_from(
        "https://cdn.test/h/master.m3u8", "https://cdn.test/"
    ))
    urls = [s["url"] for s in out]
    assert urls == [
        "https://cdn.test/h/master.m3u8",
        "https://cdn.test/h/v/360.m3u8",
        "https://cdn.test/h/v/2160.m3u8",
        "https://cdn.test/h/v/4320.m3u8",
    ], urls


def test_every_child_is_labelled_from_its_resolution():
    # No rung is dropped: the label is the viewer-facing tier, and 4320 must
    # read as 8K rather than collapsing into 4K.
    out = _with_get(MASTER, lambda: extractors._streams_from(
        "https://cdn.test/h/master.m3u8", "https://cdn.test/"
    ))
    labels = [s["label"] for s in out[1:]]
    assert labels == ["360p", "4K", "8K"], labels


def test_the_sort_keeps_the_master_ahead_of_an_equal_label():
    # _sort_streams is stable, and the master ties with its own best child on
    # label -- so it must be inserted first for that stability to hold.
    out = _with_get(MASTER, lambda: extractors._streams_from(
        "https://cdn.test/h/master.m3u8", "https://cdn.test/"
    ))
    sorted_out = extractors._sort_streams(out)
    assert sorted_out[0]["url"] == "https://cdn.test/h/master.m3u8", sorted_out


def test_a_media_playlist_still_yields_one_auto_stream():
    # Not every .m3u8 is a master, and a media playlist is a legitimate
    # single-rung answer -- it must not be rewritten into something else.
    out = _with_get(MEDIA, lambda: extractors._streams_from(
        "https://cdn.test/h/media.m3u8", "https://cdn.test/"
    ))
    assert out == [
        {"url": "https://cdn.test/h/media.m3u8", "label": "Auto", "referer": "https://cdn.test/"}
    ], out


def test_a_non_hls_url_is_returned_untouched():
    # A progressive file never had a ladder to split.
    out = extractors._streams_from("https://cdn.test/f/movie.mp4", "https://cdn.test/")
    assert out == [
        {"url": "https://cdn.test/f/movie.mp4", "label": "Auto", "referer": "https://cdn.test/"}
    ], out


# ---------------------------------------------------------------------------
# Labels and ordering
# ---------------------------------------------------------------------------


def test_4320_is_labelled_8k():
    assert extractors._label(4320) == "8K", extractors._label(4320)


def test_2160_is_still_labelled_4k():
    assert extractors._label(2160) == "4K", extractors._label(2160)


def test_8k_sorts_ahead_of_4k():
    # The best rung must be first: it is what the default stream inherits and
    # what the viewer sees before ABR picks.
    assert extractors._order("8K") < extractors._order("4K")


def test_unknown_labels_sort_last():
    # "Auto" and anything unrecognised fall behind every real rung.
    assert extractors._order("Auto") > extractors._order("360p")
    assert extractors._order("2K") > extractors._order("360p")


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


def _run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for fn in tests:
        name = fn.__name__
        try:
            fn()
            print(f"  PASS  {name}")
        except Exception:
            failures += 1
            print(f"  FAIL  {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run() else 0)
