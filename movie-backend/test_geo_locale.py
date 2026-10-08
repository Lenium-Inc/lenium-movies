"""Tests for country/language detection in the stream payload.

Run with:  python3 test_geo_locale.py

Why these exist
---------------
The locale seed decides which audio and subtitle track a viewer starts on, so a
wrong answer here is a wrong first frame rather than a wrong database row. The
three ways it can be wrong are all asserted directly:

  * taking the *last* X-Forwarded-For entry instead of the first, which resolves
    the proxy rather than the viewer and gives every request on a reverse-proxied
    deployment the same country;
  * letting a malformed header reach an address parser that raises, turning a
    client-supplied string into a 500;
  * answering "I don't know" by omitting the field, so the client has to branch
    on whether detection worked.

No Flask app, no database, no network: `detect_locale` takes a request, and a
request context is enough.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask  # noqa: E402

import geo_locale  # noqa: E402

_flask = Flask(__name__)

GEOIP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "geoip")
MMDB = os.path.join(GEOIP_DIR, "dbip-country-lite.mmdb")


def _snapshot_present() -> bool:
    """A database to open is there already, or can be unpacked into one.

    The committed copy is gzipped and month-stamped, so it is matched by
    suffix rather than by name: a refreshed snapshot replaces the previous
    one under a new file name and this check must keep seeing it.
    """
    if os.path.exists(MMDB):
        return True
    if not os.path.isdir(GEOIP_DIR):
        return False
    return any(name.endswith(".mmdb.gz") for name in os.listdir(GEOIP_DIR))


def _request(path="/", headers=None, remote_addr=None):
    # The real Request, not Flask's context proxy: the proxy raises as soon as
    # the test context is gone, and every helper under test takes a request it
    # is free to hold on to.
    with _flask.test_request_context(path, headers=headers or {}):
        from flask import request

        real = request._get_current_object()
        if remote_addr is not None:
            real.remote_addr = remote_addr
        return real


def test_locale_is_always_present_even_when_nothing_is_known():
    # The response body carries this field unconditionally, so the client never
    # has to ask whether detection happened. Loopback has no country, and with
    # no Accept-Language there is no fallback either -- English is the floor.
    geo_locale.close_reader()
    try:
        locale = geo_locale.detect_locale(_request())
    finally:
        geo_locale.close_reader()
    assert locale == {"language": "en", "country": None}, locale


def test_locale_falls_back_to_what_the_browser_asked_for():
    # Local development has only 127.0.0.1, which the database correctly
    # declines to map. The browser's own preference is a better signal there
    # than guessing from nothing.
    geo_locale.close_reader()
    try:
        locale = geo_locale.detect_locale(_request(headers={"Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"}))
    finally:
        geo_locale.close_reader()
    assert locale["language"] == "fr", locale
    assert locale["country"] is None, locale


def test_accept_language_takes_the_best_weight_and_strips_the_region():
    geo_locale.close_reader()
    try:
        # `fr` sits behind `en` in this header, so `en` must win; the bare code
        # is what the player matches track languages with.
        assert geo_locale._language_from_accept_header(
            _request(headers={"Accept-Language": "fr;q=0.4, en-US,en;q=0.9"})
        ) == "en"
        assert geo_locale._language_from_accept_header(
            _request(headers={"Accept-Language": "de-DE"})
        ) == "de"
        assert geo_locale._language_from_accept_header(_request(headers={"Accept-Language": ""})) is None
        assert geo_locale._language_from_accept_header(_request(headers={"Accept-Language": "*"})) is None
        # A malformed weight must not raise out of a lookup.
        assert geo_locale._language_from_accept_header(
            _request(headers={"Accept-Language": "es;q=oops, en;q=0.5"})
        ) == "en"
    finally:
        geo_locale.close_reader()


def test_client_ip_takes_the_first_forwarded_entry_not_the_last():
    # Every proxy appends what it saw, so the *first* entry is the client and
    # the last is whichever hop is closest to us. Resolving the last one gives
    # the load balancer's country on every deployment behind one -- which is the
    # common case -- and the same answer for every viewer on it.
    request = _request(
        headers={"X-Forwarded-For": "200.160.2.3, 10.0.0.7, 192.168.1.4"},
        remote_addr="10.0.0.1",
    )
    assert geo_locale.client_ip(request) == "200.160.2.3", geo_locale.client_ip(request)


def test_client_ip_refuses_a_header_that_is_not_an_address():
    # The header is client-controlled, so it must not reach a parser that raises
    # on a value like "banana", and a private address is not something a country
    # database can map anyway -- `remote_addr` is the better answer than a
    # resolved 10.x.
    assert geo_locale.client_ip(_request(headers={"X-Forwarded-For": "banana, 8.8.8.8"})) == "8.8.8.8"
    assert geo_locale.client_ip(_request(headers={"X-Forwarded-For": "not-an-ip"})) is None
    assert geo_locale.client_ip(_request(headers={"X-Forwarded-For": "10.0.0.9"}, remote_addr="10.0.0.1")) is None
    # A loopback literal is the local machine, not a viewer the database can
    # place, so it must not be returned as one.
    assert geo_locale.client_ip(_request(remote_addr="127.0.0.1")) is None
    # A valid literal still wins over a bogus one listed ahead of it.
    assert geo_locale.client_ip(_request(headers={"X-Forwarded-For": "garbage, 1.1.1.1"})) == "1.1.1.1"


def test_edge_country_header_is_preferred_and_never_leaked_through():
    # Cloudflare and Vercel resolve the address server-side and tell us, which
    # is both cheaper and more current than a monthly snapshot. Their spellings
    # for "unknown" must not be taken as a country code.
    geo_locale.close_reader()
    try:
        for header, value, expected in (
            ("CF-IPCountry", "BR", "BR"),
            ("CF-IPCountry", "XX", None),
            ("CF-IPCountry", "T1", None),
            ("x-vercel-ip-country", "de", "DE"),
        ):
            request = _request(headers={header: value})
            assert geo_locale.client_country(request) == expected, (header, value)
    finally:
        geo_locale.close_reader()


def test_country_maps_to_a_language_and_unmapped_stays_unmapped():
    # Deliberately not a guess: a country with no entry gets None from here and
    # `detect_locale` supplies the Accept-Language fallback or English, rather
    # than this function inventing a language for a region it does not model.
    assert geo_locale.language_for_country("br") == "pt"
    assert geo_locale.language_for_country("ES") == "es"
    assert geo_locale.language_for_country("gb") == "en"
    assert geo_locale.language_for_country("ZZ") is None
    assert geo_locale.language_for_country("") is None
    assert geo_locale.language_for_country(None) is None
    # Belgium, Switzerland and India carry several official languages, so
    # naming one would be wrong for a large share of the viewers there.
    assert geo_locale.language_for_country("BE") is None
    assert geo_locale.language_for_country("CH") is None
    assert geo_locale.language_for_country("IN") is None


def test_detect_locale_uses_a_country_from_the_edge_header():
    geo_locale.close_reader()
    try:
        locale = geo_locale.detect_locale(_request(headers={"CF-IPCountry": "BR"}))
    finally:
        geo_locale.close_reader()
    assert locale == {"language": "pt", "country": "BR"}, locale


def test_bundled_database_resolves_a_public_address():
    # `open_reader` unpacks the committed gzip on first use, so this runs on a
    # checkout that has never played a title rather than only on one that has.
    if not _snapshot_present():
        import pytest

        pytest.skip("geoip snapshot not present")

    geo_locale.close_reader()
    try:
        assert geo_locale.open_reader() is not None, "the bundled database did not open"
        assert geo_locale.client_country(_request(remote_addr="8.8.8.8")) == "US"
        assert geo_locale.client_country(_request(remote_addr="200.160.2.3")) == "BR"
        # A loopback address is a normal development address, not a crash.
        assert geo_locale.client_country(_request(remote_addr="127.0.0.1")) is None
        # A database with no record returns None/{} rather than raising.
        assert geo_locale.client_country(_request(remote_addr="192.0.2.1")) is None
    finally:
        geo_locale.close_reader()


def test_a_missing_database_degrades_instead_of_failing_the_request():
    # `GEOIP_DB` points at nothing: detection turns off for the process and the
    # request still succeeds with the browser's preference. A missing optional
    # lookup must never become a 500 on the path to first frame.
    geo_locale.close_reader()
    previous = os.environ.get("GEOIP_DB")
    os.environ["GEOIP_DB"] = "/nonexistent/nope.mmdb"
    try:
        assert geo_locale.open_reader() is None
        locale = geo_locale.detect_locale(
            _request(headers={"Accept-Language": "ja-JP"}, remote_addr="8.8.8.8")
        )
    finally:
        if previous is None:
            os.environ.pop("GEOIP_DB", None)
        else:
            os.environ["GEOIP_DB"] = previous
        geo_locale.close_reader()
    assert locale == {"language": "ja", "country": None}, locale
