"""Caption engine: ingest SRT/WebVTT assets, sanitise them, emit clean WebVTT.

Three jobs, deliberately in this order:

1. **Ingest.** Assets arrive in whichever form the source shipped them -- SRT
   with `,` milliseconds and bare numeric index lines, or WebVTT with a header
   and `WEBVTT` metadata blocks. Both are parsed into one internal cue shape so
   nothing downstream has to know which it got.
2. **Sanitise.** A cue payload is attacker-influenced text: it came off a
   third-party host. Positioning overrides (`{\\an8}`, `{\pos(10,20)}`),
   karaoke timing (`{\k80}`), font wrappers, `<meta>`/`<c.classname>` markers
   and NOTE/STYLE/REGION blocks are stripped to their readable text -- they are
   presentation metadata from another renderer, not content, and some of them
   are exactly where markup a browser would act on hides.
3. **Align and emit.** Cues are sorted, made monotonic, clamped to sane
   bounds, optionally shifted by a caller-supplied offset (the sync control a
   viewer actually needs when a track runs ahead), and written as standard
   WebVTT timestamps. What leaves this module is text a browser can play
   without a single interpretation decision of its own.

`parse_tracks` is the multi-track half: a source's subtitle candidates (a list
of assets with labels and language hints) are normalised, de-duplicated and
language-normalised into track descriptors, which is the shape playback maps
onto caption handles.
"""

from __future__ import annotations

import re

#: An SRT/VTT timing line: `[HH:]MM:SS,mmm` or `MM:SS.mmm`, end optional part
#: of the pair. Comma (SRT) and dot (VTT) milliseconds both accepted.
_TIMING = re.compile(
    r"(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*"
    r"(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})"
)

#: ASS/SSA style overrides carried over by sources that re-save SRT from an
#: authoring tool: `{\an8}`, `{\pos(1,2)}`, `{\k40}`, `{\i1}...{\i0}`.
_STYLE_OVERRIDE = re.compile(r"\{[^}]*\}")

#: Any HTML-ish tag. The safe subset is re-emitted by name below; everything
#: else drops to its inner text.
_TAG = re.compile(r'</?([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|[^>])*)>')

#: Tags a browser understands inside WebVTT and that carry no instruction
#: beyond emphasis -- kept so italics survive sanitisation. Voice (`<v>`),
#: language (`<lang>`), timestamp (`<00:00:01.000>`) and class tags are
#: dropped: they are metadata or styling hooks, not words.
_KEEP_TAGS = frozenset({"i", "b", "u"})

#: ASS line breaks that survive a round trip through an SRT export.
_ASS_BREAK = re.compile(r"\\[Nn]")

#: Control characters (including the BOM a Windows editor leaves behind) --
#: never legal in a cue, sometimes used to smuggle markup past naive filters.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

#: WebVTT/SRT cue-header lines that are directives rather than speech:
#: NOTE comments and STYLE/REGION blocks. Dropped whole.
_METADATA_BLOCK = re.compile(r"^(NOTE|STYLE|REGION)\b")


class CaptionError(ValueError):
    """A caption asset that cannot be turned into WebVTT."""


def _to_ms(hours: str | None, minutes: str, seconds: str, millis: str) -> int:
    """Milliseconds from a timing capture. Milliseconds are left-padded, so
    `.5` means 500ms rather than 5ms -- the ambiguity that makes hand-rolled
    SRT parsers drift by an order of magnitude on some files."""
    return (
        int(hours or 0) * 3_600_000
        + int(minutes) * 60_000
        + int(seconds) * 1000
        + int(millis.ljust(3, "0")[:3])
    )


def _stamp(ms: int) -> str:
    hours, rem = divmod(ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def detect_format(text: str) -> str:
    """`"vtt"` or `"srt"` -- by signature first, timing syntax as the tiebreak.

    The `WEBVTT` signature wins because a file may be *named* `.srt` while
    being WebVTT (sources relabel downloads constantly), and the reverse
    mistake -- feeding WebVTT to the SRT parser -- drops the header as a bogus
    sequence line and mis-reads `.000` milliseconds only sometimes.
    """
    head = text.lstrip("\ufeff").lstrip()
    if head[:6].upper() == "WEBVTT":
        return "vtt"
    if _TIMING.search(text):
        sample = _TIMING.search(text).group(0)
        return "vtt" if "." in sample.split("-->")[-1] else "srt"
    return "srt"


def sanitize_payload(payload: str) -> str:
    """Reduce a cue payload to readable text plus the emphasis tags.

    Every unknown tag loses its markup but keeps its words: dropping the whole
    run would delete dialogue that a source wrapped in `<font>` or `<c.yellow>`,
    which is a worse failure than a tag that rendered nothing.
    """
    text = _STYLE_OVERRIDE.sub("", payload)
    text = _ASS_BREAK.sub("\n", text)

    def _tag(match: re.Match) -> str:
        name = match.group(1).lower()
        if name not in _KEEP_TAGS:
            return ""
        closing = match.group(0).startswith("</")
        return f"</{name}>" if closing else f"<{name}>"

    text = _TAG.sub(_tag, text)
    text = _CONTROL.sub("", text)
    # Collapse runs of whitespace, then trim -- authoring tools leave trailing
    # spaces on every line and NBSP runs where a two-column layout was.
    text = re.sub(r"[ \t ]+", " ", text)
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join(line for line in lines if line)
    return text.strip()


def parse(text: str) -> list[dict]:
    """Parse SRT or WebVTT into `[{"start": ms, "end": ms, "payload": str}]`.

    Blank-line block splitting is the shared backbone; what differs per format
    is only the timing syntax and the SRT index line, and `_TIMING` accepts
    both syntaxes -- so the parser is one pass, with the index line dropped
    when it precedes a timing line (the SRT case) rather than maintained as two
    divergent implementations that drift.
    """
    if text is None:
        raise CaptionError("empty caption asset")
    body = text.lstrip("\ufeff")
    cues: list[dict] = []
    blocks = re.split(r"\r?\n\s*\r?\n", body.strip())
    for block in blocks:
        lines = [line.rstrip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        if lines[0].lstrip().startswith(("WEBVTT", "\ufeffWEBVTT")):
            # The header block: keep only a timing line if one somehow shares it.
            lines = lines[1:]
            if not lines:
                continue
        if _METADATA_BLOCK.match(lines[0].strip()):
            continue
        timing_index = None
        for index, line in enumerate(lines):
            if _TIMING.search(line):
                timing_index = index
                break
        if timing_index is None:
            # Not a cue: a NOTE, a stray line, or a sequence number without a
            # timing line. Speech never appears without timing, so this is safe
            # to drop rather than emit as a broken cue.
            continue
        # An SRT index line sits directly above the timing line and is not text.
        match = _TIMING.search(lines[timing_index])
        if not match:
            continue
        start = _to_ms(*match.group(1, 2, 3, 4))
        end = _to_ms(*match.group(5, 6, 7, 8))
        # Everything after the timing line is payload. Anything before it -- an
        # SRT sequence number, a WebVTT cue identifier -- is structure, not
        # speech, and is dropped with it.
        payload = sanitize_payload("\n".join(lines[timing_index + 1 :]))
        if not payload:
            continue
        cues.append({"start": start, "end": end, "payload": payload})
    return cues


def align(cues: list[dict], offset_ms: int = 0) -> list[dict]:
    """Order, shift and clamp cues into a playable timeline.

    "Automated alignment tracking" is these three invariants, and they are what
    a player silently assumes: starts are non-decreasing (out-of-order cues
    make a browser hide the previous line early), no cue starts below zero, and
    every cue has a positive duration (zero-length cues flash). The offset is
    the manual correction -- a viewer whose track runs two seconds ahead can
    shift it back without a second download.
    """
    shifted: list[dict] = []
    for cue in cues:
        start = cue["start"] + offset_ms
        end = cue["end"] + offset_ms
        if start < 0:
            end -= start
            start = 0
        if end <= start:
            continue
        shifted.append({"start": start, "end": end, "payload": cue["payload"]})
    shifted.sort(key=lambda cue: (cue["start"], cue["end"]))
    return shifted


def to_vtt(cues: list[dict]) -> str:
    """Standard WebVTT. One blank line between blocks, no metadata headers."""
    parts = ["WEBVTT"]
    for cue in cues:
        parts.append(f"{_stamp(cue['start'])} --> {_stamp(cue['end'])}")
        parts.append(cue["payload"])
        parts.append("")
    return "\n".join(parts).rstrip("\n") + "\n"


def convert(text: str, offset_ms: int = 0) -> str:
    """Full pipeline: detect, parse, sanitise, align, emit."""
    cues = align(parse(text), offset_ms)
    if not cues:
        raise CaptionError("no playable cues in caption asset")
    return to_vtt(cues)


def normalise_language(code: str | None) -> str:
    """Fold a language hint onto the two-letter code the player matches with.

    Delegates to `locale_settings` so the hint table has exactly one owner --
    config selection and subtitle selection agreeing on what `fra` means is the
    whole point of folding them in one place.
    """
    from locale_settings import normalise_language_hint

    return normalise_language_hint(code)


def parse_tracks(assets: list[dict], *, default_language: str = "en") -> list[dict]:
    """Normalise a source's subtitle candidates into de-duplicated track rows.

    One source ships English three times under `English`, `eng` and
    `en.srt`; another ships a rendition list where `label` carries the
    language and `lang` is empty. Both collapse onto track rows here, ordered
    so the viewer's own language comes first -- a track list that reorders
    between loads is a track list users re-pick every time.

    Exactly one row carries `default`: the first row matching
    `default_language`. Before, every English-labelled row claimed default and
    the flag stopped meaning anything; a player resolving "the default track"
    would then take whichever row happened to sort first.
    """
    tracks: list[dict] = []
    seen_keys: set[tuple[str, str]] = set()
    seen_urls: set[str] = set()
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        url = str(asset.get("url") or "").strip()
        if not url or url in seen_urls:
            continue
        language = normalise_language(asset.get("lang") or asset.get("language"))
        if not language:
            language = normalise_language(asset.get("label") or asset.get("name"))
        if not language:
            language = default_language
        label = str(asset.get("label") or asset.get("name") or "").strip()[:80]
        if not label:
            label = language.upper()
        key = (language, label.lower())
        if key in seen_keys:
            continue
        seen_keys.add(key)
        seen_urls.add(url)
        tracks.append({"language": language, "label": label, "url": url, "default": False})
    tracks.sort(key=lambda track: (track["language"] != default_language, track["label"].lower()))
    for track in tracks:
        if track["language"] == default_language:
            track["default"] = True
            break
    return tracks
