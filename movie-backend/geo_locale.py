"""Where a viewer is, and therefore which language to start playback in.

Two questions, one lookup: which country is this IP in, and what does that
country watch in. The answer only ever *seeds* the player's default audio and
subtitle track -- the viewer can change it from the same menus, so a wrong
answer costs one click rather than a broken player.

The lookup is offline on purpose. Every alternative -- a per-request call to a
geo service -- puts a third party's availability and latency on the critical
path to first frame, and the previous failure modes in this codebase (a TMDB
DNS outage turning a resolve into a 404) are exactly what that buys. A bundled
database costs a few MB in the repo and answers in microseconds.

Database
--------
DB-IP Country Lite (`https://db-ip.com/db/ip/ip-db-vr-to-country-lite.php`),
CC BY 4.0, refreshed monthly. The snapshot is committed gzipped because that
is roughly half the size; it is decompressed next to itself the first time it
is needed, and the decompressed copy is gitignored.

An older monthly snapshot going stale is a real risk, so the file name carries
its month and `open_reader()` falls back to whatever snapshot is present rather
than failing on a rename.

Fallbacks
---------
Not every deployment carries a client IP a database can resolve: a local dev
server has only `127.0.0.1`, which the database correctly declines to map. In
that case the browser's own `Accept-Language` says what the viewer asked for,
and it is a better signal than guessing anyway. English is the floor, because
the player needs a value even when both are absent.
"""

from __future__ import annotations

import gzip
import ipaddress
import os
import re
import shutil
import threading

__all__ = [
    "DEFAULT_LANGUAGE",
    "detect_locale",
    "language_for_country",
    "client_country",
    "client_ip",
]

#: What playback starts in when nothing about the viewer is known.
DEFAULT_LANGUAGE = "en"

_GEOIP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "geoip")

#: Country -> primary audio language. Only countries whose dominant language is
#: unambiguous are listed; anything missing falls through to the viewer's own
#: `Accept-Language` and then to `DEFAULT_LANGUAGE`, rather than to a guess.
#: Regions with several official languages (Belgium, Switzerland, India) are
#: deliberately absent: naming one would be wrong for a large share of the
#: viewers there, and the fallback already does better -- a browser in Brussels
#: or Bengaluru asks for the right language in its own header.
COUNTRY_LANGUAGE = {
    "US": "en",
    "GB": "en",
    "IE": "en",
    "AU": "en",
    "NZ": "en",
    "CA": "en",
    "ES": "es",
    "MX": "es",
    "AR": "es",
    "CL": "es",
    "CO": "es",
    "PE": "es",
    "VE": "es",
    "EC": "es",
    "UY": "es",
    "PY": "es",
    "BO": "es",
    "GT": "es",
    "HN": "es",
    "SV": "es",
    "NI": "es",
    "CR": "es",
    "PA": "es",
    "DO": "es",
    "CU": "es",
    "PR": "es",
    "FR": "fr",
    "HT": "fr",
    "SN": "fr",
    "ML": "fr",
    "CI": "fr",
    "CM": "fr",
    "MG": "fr",
    "DE": "de",
    "AT": "de",
    "IT": "it",
    "PT": "pt",
    "BR": "pt",
    "JP": "ja",
    "KR": "ko",
    "CN": "zh",
    "TW": "zh",
    "SG": "en",
    "SA": "ar",
    "AE": "ar",
    "EG": "ar",
    "MA": "ar",
    "DZ": "ar",
    "TN": "ar",
    "IQ": "ar",
    "JO": "ar",
    "LB": "ar",
    "LY": "ar",
    "SY": "ar",
    "YE": "ar",
    "KW": "ar",
    "QA": "ar",
    "BH": "ar",
    "OM": "ar",
    "IL": "he",
    "TR": "tr",
    "RU": "ru",
    "UA": "ru",
    "BY": "ru",
    "KZ": "ru",
    "NL": "nl",
    "PL": "pl",
    "SE": "sv",
    "NO": "no",
    "DK": "da",
    "FI": "fi",
    "ID": "id",
    "MY": "ms",
    "TH": "th",
    "VN": "vi",
    "GR": "el",
    "CZ": "cs",
    "HU": "hu",
    "RO": "ro",
    "BG": "bg",
    "SK": "sk",
    "HR": "hr",
    "RS": "sr",
    "PH": "en",
    "ZA": "en",
    "NG": "en",
    "KE": "en",
    "GH": "en",
}

#: Two-letter header values that stand for a country rather than a language.
_COUNTRY_CODE_PATTERN = re.compile(r"^[A-Za-z]{2}$")

_reader = None
_reader_lock = threading.Lock()
_reader_failed = False


def language_for_country(country_code: str | None) -> str | None:
    """ISO-3166 country -> the language that country watches in, if we know."""
    if not country_code:
        return None
    return COUNTRY_LANGUAGE.get(country_code.strip().upper())


def _decompress_snapshot() -> str | None:
    """Path to the country database, unpacking it from gzip if needed.

    Compressed first, decompressed on demand: the repo stores the smaller file
    and every process that needs it gets the same path, so the work happens
    once per checkout rather than once per worker. An already-unpacked copy --
    including one a previous process produced, or one left behind after the
    gzip was pruned -- is simply found and used.
    """
    if not os.path.isdir(_GEOIP_DIR):
        return None
    names = os.listdir(_GEOIP_DIR)

    for name in sorted(names):
        if name.endswith(".mmdb"):
            target = os.path.join(_GEOIP_DIR, name)
            if os.path.getsize(target) > 0:
                return target

    compressed = None
    for name in sorted(names):
        if name.endswith(".mmdb.gz"):
            compressed = os.path.join(_GEOIP_DIR, name)
            break
    if compressed is None:
        return None

    target = compressed[: -len(".gz")]

    # Write beside the destination and rename, so a reader racing this sees
    # either nothing or a complete file -- never a half-written database.
    partial = f"{target}.{os.getpid()}.part"
    try:
        with gzip.open(compressed, "rb") as src, open(partial, "wb") as dst:
            shutil.copyfileobj(src, dst)
        os.replace(partial, target)
    except OSError as error:  # noqa: BLE001 - degrade to "no geo", never 500
        print(f"[GeoIP] could not unpack {compressed}: {error}")
        try:
            os.unlink(partial)
        except OSError:
            pass
        return None
    return target


def open_reader():
    """Lazily opened, process-wide reader. `None` when no database is present."""
    global _reader, _reader_failed

    if _reader is not None:
        return _reader
    if _reader_failed:
        return None

    with _reader_lock:
        if _reader is not None:
            return _reader
        if _reader_failed:
            return None

        path = os.environ.get("GEOIP_DB") or _decompress_snapshot()
        if not path or not os.path.exists(path):
            _reader_failed = True
            return None

        try:
            import maxminddb  # noqa: PLC0415 - optional until it is needed
        except ImportError:
            # The package is in requirements.txt; a venv installed before it
            # existed must not take the whole request down over a lookup.
            print("[GeoIP] maxminddb is not installed; country detection off")
            _reader_failed = True
            return None

        try:
            _reader = maxminddb.open_database(path)
        except Exception as error:  # noqa: BLE001
            print(f"[GeoIP] could not open {path}: {error}")
            _reader_failed = True
            return None
        return _reader


def close_reader() -> None:
    """Drop the reader so a test can reopen it against a different database."""
    global _reader, _reader_failed
    with _reader_lock:
        if _reader is not None:
            try:
                _reader.close()
            except Exception:  # noqa: BLE001
                pass
        _reader = None
        _reader_failed = False


def client_ip(request) -> str | None:
    """The viewer's own address, not the proxy's.

    `X-Forwarded-For` is a chain and the *first* entry is the client: every
    proxy appends the address it saw, so the last entry is whichever hop is
    closest to us. Taking `remote_addr` instead would resolve the load balancer
    on every deployment behind one, which is the common case.

    Only a plausible address is accepted. The header is client-controlled, so a
    value like `not-an-ip` must not reach a parser that will raise, and a
    private or loopback address is not something the database can map anyway.
    """
    candidates: list[str] = []

    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        candidates.extend(part.strip() for part in forwarded.split(","))
    real = request.headers.get("X-Real-IP", "")
    if real:
        candidates.append(real.strip())
    if request.remote_addr:
        candidates.append(str(request.remote_addr).strip())

    for candidate in candidates:
        if not candidate:
            continue
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if address.is_global:
            return str(address)
    return None


def client_country(request) -> str | None:
    """ISO-3166 country code for the viewer, or `None` when undetermined.

    The edge proxy is asked first. Cloudflare, Vercel and most CDNs have
    already resolved the address server-side and put the result in a header,
    which is both cheaper and more accurate than our own copy of a monthly
    snapshot -- the bundled database is the fallback for when no proxy spoke.
    """
    for header in ("CF-IPCountry", "x-vercel-ip-country", "x-country-code"):
        value = (request.headers.get(header) or "").strip()
        # The edge spells "unknown"/"T1"(Tor) for what it could not place.
        if not value or value.upper() in {"XX", "ZZ", "T1", "UNKNOWN"}:
            continue
        if _COUNTRY_CODE_PATTERN.match(value):
            return value.upper()

    ip = client_ip(request)
    if not ip:
        return None

    reader = open_reader()
    if reader is None:
        return None
    try:
        record = reader.get(ip)
    except Exception as error:  # noqa: BLE001 - a bad record is not a 500
        print(f"[GeoIP] lookup failed for {ip}: {error}")
        return None
    if not isinstance(record, dict):
        return None
    country = record.get("country") or record.get("registered_country") or {}
    code = country.get("iso_code") if isinstance(country, dict) else None
    return code.upper() if isinstance(code, str) and len(code) == 2 else None


def _language_from_accept_header(request) -> str | None:
    """Best language the browser itself asked for.

    The fallback of last resort before English, and the only signal that exists
    on a loopback address. Weighted parsing rather than a plain split: the
    header is `en-US,en;q=0.9,fr;q=0.8`, and taking `fr` off a `q=0.8` entry
    while `en` sits unweighted at the front would pick the viewer's *second*
    choice.
    """
    raw = request.headers.get("Accept-Language", "")
    best_q = -1.0
    best_lang = None
    for part in raw.split(","):
        piece = part.strip()
        if not piece:
            continue
        code, _, params = piece.partition(";")
        code = code.strip().lower()
        if not code or code == "*":
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value.strip())
                except ValueError:
                    quality = 0.0
        if quality > best_q:
            best_q = quality
            best_lang = code
    if not best_lang:
        return None
    # `en-gb` -> `en`: the player matches hls.js track languages, which are
    # almost always bare codes.
    return best_lang.split("-")[0]


def detect_locale(request) -> dict:
    """The stream's locale seed: `{"language": ..., "country": ...}`.

    Always returns both keys. A caller writing this into a response body should
    never have to branch on whether detection happened to work.
    """
    country = client_country(request)
    language = language_for_country(country)
    if not language:
        language = _language_from_accept_header(request)
    return {
        "language": language or DEFAULT_LANGUAGE,
        "country": country,
    }
