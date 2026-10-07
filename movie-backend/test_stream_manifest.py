"""Tests for the server-side trailer resolver and HLS master inventory.

Run with:  python3 test_stream_manifest.py

Why these exist
---------------
Two resolvers were added that both answer "what can the player offer?" from
text a remote server sent, and both failed silently when they were wrong.

The HLS resolver reads an `#EXTM3U` master. Its whole reason to exist is the
alternate audio renditions, because the English dub of a Korean or Chinese
release exists *only* as an `#EXT-X-MEDIA:TYPE=AUDIO` entry -- a resolver that
reads nothing else resolves the video ladder perfectly and never once offers the
dub. That is a wrong answer with no error attached, which is the worst kind.

The trailer resolver ranks a TMDB `videos.results` list and builds the player
URL server-side. It used to hand the browser a bare key and let it reconstruct
the provider URL, which made "no trailer exists" and "a trailer from a site this
build has no builder for" the same 200 response, and the second rendered as a
blank frame.

Both are pure functions here, so they are tested without a socket, a Flask
client, or a network.
"""

import sys
import traceback

import catalog_lib
import tmdb_service


def _video(**kwargs):
    base = {
        "site": "YouTube",
        "key": "k",
        "type": "Trailer",
        "official": True,
        "name": "Trailer",
        "iso_639_1": "en",
        "published_at": "2020-01-01T00:00:00.000Z",
    }
    base.update(kwargs)
    return base


# --- trailer ranking ---------------------------------------------------------


def test_official_beats_non_official():
    # A non-official "Trailer" is usually a reupload, which is what gets taken
    # down or has embedding disabled. The official one is the same video quality
    # and a far better chance of ever playing.
    ranked = tmdb_service.rank_trailers(
        [
            _video(key="reupload", official=False, name="Reupload"),
            _video(key="official", official=True, name="Official"),
        ]
    )
    assert ranked[0]["key"] == "official", ranked


def test_a_trailer_outranks_a_featurette_from_the_same_uploader():
    ranked = tmdb_service.rank_trailers(
        [
            _video(key="bts", type="Behind the Scenes"),
            _video(key="teaser", type="Trailer"),
        ]
    )
    assert ranked[0]["key"] == "teaser", ranked


def test_undubbed_audio_outranks_a_dub():
    # `iso_639_1` is the audio track's language. A dubbed official trailer is
    # better than an undubbed *third-party* one but worse than an official
    # undubbed trailer, which is what the ranking encodes.
    ranked = tmdb_service.rank_trailers(
        [
            _video(key="dub", iso_639_1="ko"),
            _video(key="original", iso_639_1="en"),
        ]
    )
    assert ranked[0]["key"] == "original", ranked


def test_an_undated_upload_does_not_outrank_a_dated_one():
    # Negating a sortable date to make `min` sort descending only works if the
    # missing case maps to 0 rather than to an empty string, which would
    # otherwise compare as the newest possible value.
    ranked = tmdb_service.rank_trailers(
        [
            _video(key="undated", published_at=""),
            _video(key="dated", published_at="2019-05-01T00:00:00.000Z"),
        ]
    )
    assert ranked[0]["key"] == "dated", ranked


def test_unframable_sites_are_dropped_before_ranking():
    # Handing an <iframe> a site that refuses framing produces a black rectangle
    # with no error, so the site list has to be the filter.
    ranked = tmdb_service.rank_trailers([_video(key="blocked", site="SomeHost")])
    assert ranked == [], ranked


def test_youtube_is_matched_case_insensitively():
    # TMDB spells the site "YouTube" while the embed builders key off
    # "youtube". Comparing those directly drops every trailer there is.
    ranked = tmdb_service.rank_trailers([_video(site="YouTube")])
    assert len(ranked) == 1, ranked
    assert ranked[0]["site"] == "YouTube"


def test_embed_urls_are_built_server_side():
    descriptor = tmdb_service.trailer_descriptor(_video(key="abc123"))
    assert descriptor["provider"] == "youtube"
    assert descriptor["embed_url"].endswith("/embed/abc123")
    assert descriptor["thumb_url"].endswith("/vi/abc123/hqdefault.jpg")


def test_vimeo_embeds_are_built_too():
    # Only building YouTube URLs is how a Vimeo upload turns into a broken frame.
    descriptor = tmdb_service.trailer_descriptor(_video(key="999", site="Vimeo"))
    assert descriptor["provider"] == "vimeo"
    assert "player.vimeo.com" in descriptor["embed_url"]
    # Vimeo exposes no public thumbnail endpoint.
    assert "thumb_url" not in descriptor


def test_a_keyless_video_is_never_ranked():
    assert tmdb_service.rank_trailers([_video(key="")]) == []


def test_the_legacy_key_selector_still_returns_a_youtube_key():
    # `/api/movies/trailer` and `/api/catalog/movieTrailer` still answer with a
    # bare key, and the deployed frontend still reads it. Both paths have to
    # agree on which video is best.
    videos = [
        _video(key="aaa", official=False),
        _video(key="bbb", official=True),
    ]
    assert tmdb_service.select_trailer_key(videos) == "bbb"


# --- HLS master inventory ----------------------------------------------------

MASTER = "\n".join(
    [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Korean",LANGUAGE="ko",'
        "DEFAULT=YES,CHANNELS=6,URI=\"audio/ko.m3u8\"",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English, 5.1",LANGUAGE="en",'
        'URI="audio/en.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English SDH",'
        'LANGUAGE="en",URI="cap/en.vtt"',
        "#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360",
        "v/360.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=18000000,RESOLUTION=3840x2160",
        "v/2160.m3u8",
        "",
    ]
)


def test_the_master_ladder_is_read_best_first():
    inventory = catalog_lib.parse_hls_master(MASTER, "https://cdn.test/h/master.m3u8")
    heights = [variant["height"] for variant in inventory["variants"]]
    assert heights == [2160, 360], heights
    # 2160 is labelled the way a viewer reads it on a badge.
    assert inventory["variants"][0]["quality"] == "4K", inventory["variants"][0]


def test_the_english_dub_is_found_on_a_foreign_title():
    inventory = catalog_lib.parse_hls_master(
        MASTER, "https://cdn.test/h/master.m3u8", "ko"
    )
    languages = [track["language"] for track in inventory["audio"]]
    assert languages == ["ko", "en"], languages
    dub = next(track for track in inventory["audio"] if track["language"] == "en")
    assert dub["is_dub"] is True, dub
    # A rendition is a media playlist, so it has to resolve to a playable URL.
    assert dub["url"] == "https://cdn.test/h/audio/en.m3u8", dub["url"]


def test_english_original_audio_is_not_called_a_dub():
    inventory = catalog_lib.parse_hls_master(
        MASTER, "https://cdn.test/h/master.m3u8", "en"
    )
    assert all(track["is_dub"] is False for track in inventory["audio"]), inventory


def test_no_original_language_means_no_dub_claims():
    inventory = catalog_lib.parse_hls_master(MASTER, "https://cdn.test/h/master.m3u8")
    assert all(track["is_dub"] is False for track in inventory["audio"]), inventory


def test_a_quoted_name_containing_a_comma_does_not_break_parsing():
    # `NAME="English, 5.1"` is ordinary in a real master and a naive comma split
    # would truncate it into two attributes.
    inventory = catalog_lib.parse_hls_master(MASTER, "https://cdn.test/h/master.m3u8")
    assert any(track["name"] == "English, 5.1" for track in inventory["audio"]), inventory


def test_default_rendition_sorts_first():
    inventory = catalog_lib.parse_hls_master(MASTER, "https://cdn.test/h/master.m3u8")
    assert inventory["audio"][0]["language"] == "ko", inventory["audio"][0]
    assert inventory["audio"][0]["is_default"] is True


def test_a_media_playlist_reports_no_ladder():
    # An empty variant list is not an error: a media playlist simply has no
    # ladder to advertise.
    inventory = catalog_lib.parse_hls_master(
        "#EXTM3U\n#EXTINF:4,\nseg/1.m4s\n#EXTINF:4,\nseg/2.m4s\n"
    )
    assert inventory["variants"] == [], inventory


def test_a_segment_uri_is_not_mistaken_for_a_variant():
    # The URI after `#EXTINF` belongs to the current media segment, not to a
    # pending `#EXT-X-STREAM-INF`, so it must not become a quality option.
    inventory = catalog_lib.parse_hls_master(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=320x240\nv/240.m3u8\n"
        "#EXTINF:4,\nseg/1.m4s\n"
    )
    assert len(inventory["variants"]) == 1, inventory
    assert inventory["variants"][0]["url"].endswith("v/240.m3u8"), inventory


def test_a_rendition_without_a_uri_is_not_selectable():
    # No URI means the audio is muxed into the variant, so there is nothing for
    # a switcher to point at.
    inventory = catalog_lib.parse_hls_master(
        "#EXTM3U\n"
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Korean",LANGUAGE="ko"\n'
    )
    assert inventory["audio"] == [], inventory


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