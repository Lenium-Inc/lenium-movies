"""Locale configuration: which languages this product speaks, and for whom.

One source of truth for the locale surface (`GET|POST /api/v1/locale/config`)
and for the locale seeds that playback init applies. Three responsibilities:

- **The supported language table.** A language appears here only if something
  in the product can actually honour it: labels for language pickers, an
  endonym so a viewer finds their own language in their own script, and the
  writing direction a browser needs to render that language correctly. The
  direction is *derived from the language*, never sent by the client -- an RTL
  mismatch is the kind of layout bug that looks like a rendering failure.

- **The inverse of `geo_locale.COUNTRY_LANGUAGE`.** Detection answers country
  -> language; configuration is written the other way round (a viewer picks
  Spanish, the product suggests the region whose catalogues match). The inverse
  is built from the detection table rather than maintained separately, so the
  two can never disagree: add a country to detection and the language's region
  suggestion picks it up on the next import.

- **Merge and validate.** A stored profile choice, the geo/Accept-Language
  seed, and the defaults collapse into one effective config; POSTs are
  validated strictly before they touch a profile (unknown language codes are
  rejected with the allowed set, not silently coerced -- a typo that silently
  becomes English hides itself forever).
"""

from __future__ import annotations

import re
import unicodedata

from geo_locale import COUNTRY_LANGUAGE, DEFAULT_LANGUAGE, detect_locale

__all__ = [
    "SUPPORTED_LANGUAGES",
    "RTL_LANGUAGES",
    "available_languages",
    "available_regions",
    "is_supported_language",
    "effective_config",
    "validate_config",
    "direction_for",
    "language_label",
]

#: code -> endonym as its own speakers write it. The endonym is what a language
#: picker shows: a Vietnamese speaker scanning for Vietnamese reads "Tiếng
#: Việt", not the English word for it. English names live in the response's
#: `english` field for search and for logs.
_LANGUAGE_TABLE: dict[str, tuple[str, str]] = {
    "en": ("English", "English"),
    "es": ("Español", "Spanish"),
    "fr": ("Français", "French"),
    "de": ("Deutsch", "German"),
    "it": ("Italiano", "Italian"),
    "pt": ("Português", "Portuguese"),
    "ru": ("Русский", "Russian"),
    "uk": ("Українська", "Ukrainian"),
    "pl": ("Polski", "Polish"),
    "cs": ("Čeština", "Czech"),
    "sk": ("Slovenčina", "Slovak"),
    "hu": ("Magyar", "Hungarian"),
    "ro": ("Română", "Romanian"),
    "bg": ("Български", "Bulgarian"),
    "el": ("Ελληνικά", "Greek"),
    "hr": ("Hrvatski", "Croatian"),
    "sr": ("Српски", "Serbian"),
    "nl": ("Nederlands", "Dutch"),
    "da": ("Dansk", "Danish"),
    "fi": ("Suomi", "Finnish"),
    "no": ("Norsk", "Norwegian"),
    "sv": ("Svenska", "Swedish"),
    "tr": ("Türkçe", "Turkish"),
    "ar": ("العربية", "Arabic"),
    "he": ("עברית", "Hebrew"),
    "fa": ("فارسی", "Persian"),
    "hi": ("हिन्दी", "Hindi"),
    "id": ("Bahasa Indonesia", "Indonesian"),
    "ms": ("Bahasa Melayu", "Malay"),
    "vi": ("Tiếng Việt", "Vietnamese"),
    "th": ("ไทย", "Thai"),
    "ja": ("日本語", "Japanese"),
    "ko": ("한국어", "Korean"),
    "zh": ("中文", "Chinese"),
}

#: Languages written right-to-left. A browser cannot infer direction from a
#: two-letter code (Hebrew and Yiddish share one script direction but not a
#: code relationship), so the set is explicit and small.
RTL_LANGUAGES = frozenset({"ar", "he", "fa"})

#: Every language code detection can produce, plus the extras in the table
#: above that no single country maps to but viewers still pick.
SUPPORTED_LANGUAGES = frozenset(_LANGUAGE_TABLE)

#: Subtitle/off sentinel accepted by the config endpoint: "the viewer turned
#: subtitles off", distinct from "no preference, use the default".
SUBTITLES_OFF = "off"

_LANGUAGE_CODE = re.compile(r"^[a-z]{2,3}$")
_REGION_CODE = re.compile(r"^[A-Z]{2}$")

#: ISO 639-2 to 639-1: both the bibliographic (`/b`) and terminologic (`/t`)
#: spellings are listed where they differ (`fre`/`fra`, `ger`/`deu`), because
#: packagers emit either and getting this wrong tags a French track `fra`,
#: which no player matches against `fr` audio. Codes we have never seen are
#: passed through untouched -- guessing a language is worse than carrying a
#: tag the player ignores, since a wrong tag silently selects the wrong audio.
LANG_3_TO_2 = {
    "ara": "ar", "aze": "az", "bos": "bs", "bul": "bg",
    "cat": "ca", "ces": "cs", "cha": "zh", "chi": "zh",
    "cze": "cs", "dan": "da", "deu": "de", "dut": "nl", "ell": "el",
    "eng": "en", "est": "et", "eus": "eu", "fas": "fa", "fin": "fi",
    "fra": "fr", "fre": "fr", "ger": "de", "gle": "ga", "glg": "gl",
    "gre": "el", "heb": "he", "hrv": "hr", "hun": "hu", "hye": "hy",
    "ice": "is", "ind": "id", "isl": "is", "ita": "it", "jpn": "ja",
    "kat": "ka", "kor": "ko", "lav": "lv", "lit": "lt", "mkd": "mk",
    "msa": "ms", "nld": "nl", "nor": "no", "pol": "pl", "por": "pt",
    "ron": "ro", "rum": "ro", "rus": "ru", "slk": "sk", "slv": "sl",
    "spa": "es", "sqi": "sq", "srp": "sr", "swe": "sv", "tha": "th",
    "tur": "tr", "ukr": "uk", "vie": "vi", "zho": "zh",
}


def _inverse_country_table() -> dict[str, str]:
    """Language -> the first country detection lists for it.

    Built from `COUNTRY_LANGUAGE` in insertion order, so "first" means "the
    country that detection itself associates first" (US before GB for English)
    -- no second ordering rule to keep in sync.
    """
    inverse: dict[str, str] = {}
    for country, language in COUNTRY_LANGUAGE.items():
        inverse.setdefault(language, country)
    return inverse


LANGUAGE_COUNTRY = _inverse_country_table()


def language_label(code: str) -> str | None:
    """Endonym for `code`, or None when we do not speak it."""
    entry = _LANGUAGE_TABLE.get((code or "").lower())
    return entry[0] if entry else None


def _name_index() -> tuple[dict[str, str], dict[str, str]]:
    """(folded label -> code, exact lowercased label -> code).

    Two indexes rather than one fold: Latin-script names fold diacritics away
    so `espanol` finds `Español`, but folding strips every non-`[a-z0-9]`
    character -- which is the *entirety* of Arabic, Hebrew, Greek, Cyrillic,
    CJK and Thai endonyms. Those are therefore also indexed exactly
    (lowercased only), so `العربية` matches itself.
    """
    folded_index: dict[str, str] = {}
    exact_index: dict[str, str] = {}
    for code, (endonym, english) in _LANGUAGE_TABLE.items():
        for name in (endonym, english):
            folded = _fold_name(name)
            if folded:
                folded_index.setdefault(folded, code)
            exact = name.strip().lower()
            if exact:
                exact_index.setdefault(exact, code)
    return folded_index, exact_index


def _fold_name(name: str) -> str:
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    stripped = stripped.split("(")[0]
    return re.sub(r"[^a-z0-9]+", " ", stripped.lower()).strip()


_NAME_TO_CODE, _NAME_EXACT = _name_index()


def normalise_language_hint(hint) -> str:
    """Fold any language hint onto a language code, or `""` when unrecognised.

    Accepts, in the order sources actually emit them: a two-letter code, a
    three-letter ISO 639-2 code (either spelling), an endonym, an English name,
    or a label with a parenthetical qualifier. Unrecognised text returns `""`
    rather than guessing -- a hint misread as a language silently plays the
    wrong subtitles, which is worse than falling back to the viewer's default.
    """
    if not isinstance(hint, str):
        return ""
    value = hint.strip()
    if not value or len(value) > 60:
        return ""
    lowered = value.lower()
    if _LANGUAGE_CODE.match(lowered):
        if len(lowered) == 2:
            return lowered
        return LANG_3_TO_2.get(lowered, lowered)
    exact = _NAME_EXACT.get(lowered)
    if exact:
        return exact
    return _NAME_TO_CODE.get(_fold_name(value), "")


def direction_for(code: str) -> str:
    """`"ltr"` or `"rtl"` for a language code; unknown codes are LTR."""
    return "rtl" if (code or "").lower() in RTL_LANGUAGES else "ltr"


def is_supported_language(code: str | None) -> bool:
    return bool(code) and code.lower() in SUPPORTED_LANGUAGES


def available_languages() -> list[dict]:
    """Language picker rows, sorted by endonym. Complete response, no lookups
    left for the client to reconstruct."""
    rows = [
        {
            "code": code,
            "label": label,
            "english": english,
            "direction": direction_for(code),
            "region": LANGUAGE_COUNTRY.get(code),
        }
        for code, (label, english) in _LANGUAGE_TABLE.items()
    ]
    rows.sort(key=lambda row: row["label"].lower())
    return rows


def available_regions() -> list[dict]:
    """Countries detection recognises, with their default language.

    Only countries in the detection table: a region override exists to steer
    catalogue seeding, and a country we cannot map to a language would be an
    override that changes nothing while looking like it did.
    """
    return [
        {"code": country, "language": language, "label": country}
        for country, language in sorted(COUNTRY_LANGUAGE.items())
    ]


def validate_config(payload: dict, *, field_prefix: str = "") -> dict:
    """Strictly validate a locale config body. Returns normalised values.

    Raises `ValueError` with a message that names the field and the accepted
    values -- the API contract is that bad input gets one precise answer, not a
    generic 400 that sends the client guessing which of three fields was wrong.
    """
    where = field_prefix or "config"
    if not isinstance(payload, dict):
        raise ValueError(f"{where} must be an object")

    result: dict[str, str] = {}
    if "language" in payload:
        language = str(payload["language"] or "").strip().lower()
        if language and not is_supported_language(language):
            raise ValueError(f"{where}.language must be one of: en, es, fr, de, ...")
        result["language"] = language

    if "subtitle_language" in payload:
        subtitle = str(payload["subtitle_language"] or "").strip().lower()
        if subtitle and subtitle != SUBTITLES_OFF and not is_supported_language(subtitle):
            raise ValueError(
                f"{where}.subtitle_language must be a supported language or '{SUBTITLES_OFF}'"
            )
        result["subtitle_language"] = subtitle

    if "region" in payload:
        region = str(payload["region"] or "").strip().upper()
        if region and not _REGION_CODE.match(region):
            raise ValueError(f"{where}.region must be a two-letter country code")
        if region and region not in COUNTRY_LANGUAGE:
            raise ValueError(f"{where}.region must be a region detection knows: {region}")
        result["region"] = region

    return result


def _stored_profile_locale(profile) -> dict:
    """Locale fields off a profile row/dict, tolerating rows that predate the
    columns (the migration backfills empty strings, but a cached serializer
    may hand us a dict without them)."""
    if not profile:
        return {}
    read = profile.get if isinstance(profile, dict) else lambda key: getattr(profile, key, None)
    return {
        "language": (read("preferred_language") or "").strip(),
        "subtitle_language": (read("preferred_subtitle") or "").strip(),
        "region": (read("locale_region") or "").strip(),
    }


def effective_config(request, profile=None) -> dict:
    """The locale playback should start with, and where each value came from.

    Precedence per field: stored profile choice > geo/Accept-Language seed >
    English. `source` is reported per field because "why did it pick Spanish"
    is otherwise unanswerable from a response that only contains the answer --
    and a wrong seed vs. a wrong saved preference are different bugs.
    """
    seed = detect_locale(request)
    stored = _stored_profile_locale(profile)

    language = stored.get("language") or seed["language"] or DEFAULT_LANGUAGE
    region = stored.get("region") or (seed["country"] or "")
    subtitle = stored.get("subtitle_language") or ""

    return {
        "language": language,
        "subtitle_language": subtitle,
        "region": region,
        "direction": direction_for(language),
        "country": seed["country"],
        "sources": {
            "language": "profile" if stored.get("language") else "geo",
            "region": "profile" if stored.get("region") else ("geo" if seed["country"] else "default"),
            "subtitle_language": "profile" if subtitle else "default",
        },
        "available": {
            "languages": available_languages(),
            "regions": available_regions(),
            "subtitles_off": SUBTITLES_OFF,
        },
    }
