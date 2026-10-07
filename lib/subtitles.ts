/**
 * SubRip -> WebVTT conversion.
 *
 * Why this has to exist
 * ---------------------
 * A `<track kind="subtitles">` element hands its `src` to Chrome's WebVTT
 * parser, and that parser accepts exactly one format. A SubRip `.srt` track
 * fails it for two independent reasons, and both fail *silently*: the parser
 * drops the file, no cue ever fires, and the UI still reports the subtitle as
 * "selected", so the only symptom is a viewer who turned subtitles on and saw
 * nothing happen.
 *
 *   1. There is no `WEBVTT` magic line. A manifest is not a WebVTT file, period.
 *   2. SubRip writes milliseconds with a comma (`00:00:01,500`). WebVTT requires
 *      a full stop, and rejects the whole timestamp rather than coercing it.
 *
 * Serving the file as-is therefore never works, which is why this lives on the
 * server. It cannot be done in the browser: the bytes are cross-origin, and the
 * parser that rejects them is the one doing the rejecting -- there is no hook
 * between the two.
 *
 * Kept as pure functions so the conversion is testable without a socket or a
 * DOM, and so the route handler stays a straight pass-through.
 */

//: SRT timecode: `HH:MM:SS,mmm`, or the short `MM:SS,mmm` some tools emit.
const SUBRIP_TIMECODE = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

/**
 * WebVTT inline tags that survive the pass through unescaped.
 *
 * Anything else in angle brackets is escaped, because in WebVTT a `<` starts a
 * tag: SubRip's `<font color=...>` and `<00:00:01.000>` timestamp burn-ins are
 * common in archival captures and would otherwise either be swallowed as an
 * unknown tag or -- worse -- swallow the rest of the cue.
 */
const ALLOWED_TAGS = /^(?:\/?[ibu](?:\.[A-Za-z0-9-]+)?|v(?:\s[^>]*)?|c(?:\.[A-Za-z0-9-]+)?|lang(?:\([^)]{1,32}\))?|rt)$/i;

//: Private-use code points used as entity placeholders while escaping runs.
const ENTITY_SLOT_OPEN = "\uE000";
const ENTITY_SLOT_CLOSE = "\uE001";
const SLOT_PATTERN = /\uE000(\d+)\uE001/g;

/** Cue text safety: bare `&` and disallowed `<` must be entity-encoded. */
function escapeCueText(text: string): string {
  // Protect existing entities so `&amp;` is not turned into `&amp;amp;`.
  // The placeholder uses a private-use code point rather than a digit run,
  // because a numeric placeholder would collide with the real thing: a cue
  // reading "wait 3 seconds" would come back as "wait & seconds".
  const entities: string[] = [];
  let working = text.replace(
    /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi,
    match => {
      entities.push(match);
      return `${ENTITY_SLOT_OPEN}${entities.length - 1}${ENTITY_SLOT_CLOSE}`;
    }
  );

  working = working.replace(/&/g, "&amp;");

  // Escape `<` unless it opens a tag WebVTT actually understands.
  working = working.replace(/<\/?[a-z][^>]*>|<[^>]*>/gi, tag => {
    const inner = tag.replace(/^<|>/g, "");
    return ALLOWED_TAGS.test(inner) ? tag : tag.replace("<", "&lt;");
  });

  return working.replace(SLOT_PATTERN, (_whole, index: string) => entities[Number(index)]);
}

/** Whether a body already carries the WebVTT signature. */
export function isWebVtt(text: string): boolean {
  return text.replace(/^﻿/, "").trimStart().startsWith("WEBVTT");
}

/**
 * One SubRip timestamp as a WebVTT timestamp.
 *
 * Returns null for anything that is not a timestamp, so a caller can leave
 * unrecognised lines alone rather than silently corrupting them.
 */
export function toWebVttTimecode(value: string): string | null {
  const match = SUBRIP_TIMECODE.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  return (
    `${hours.padStart(2, "0")}:${minutes}:${seconds}.` +
    `${millis.padEnd(3, "0").slice(0, 3)}`
  );
}

/** `00:00:01,500 --> 00:00:04,000` as a WebVTT cue timing line. */
function toCueTiming(line: string): string | null {
  // `-->`, and any cue settings after it (WebVTT's `align:`/`line:` are
  // carried through untouched).
  const separator = line.indexOf("-->");
  if (separator === -1) return null;
  const start = toWebVttTimecode(line.slice(0, separator));
  if (!start) return null;
  const rest = line.slice(separator + 3);
  // The match includes the leading whitespace, so slicing by its length removes
  // the separator gap as well as the timestamp -- slicing by the token alone
  // leaves that whitespace behind and produces `--> 00:00:02.000  position:...`.
  const endMatch = /^(\s*)(\S+)/.exec(rest);
  const end = endMatch ? toWebVttTimecode(endMatch[2]) : null;
  if (!end || !endMatch) return null;
  const settings = rest.slice(endMatch[0].length).trim();
  return `${start} --> ${end}${settings ? ` ${settings}` : ""}`;
}

/**
 * Normalize any subtitle body to WebVTT.
 *
 * Already-WebVTT input is returned with only the signature verified and the
 * body left intact: re-serializing a file that the browser can already read
 * risks changing cues that were fine.
 */
export function toWebVtt(text: string): string {
  const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (isWebVtt(body)) return body;

  const out: string[] = ["WEBVTT", ""];
  const blocks = body.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split("\n").filter(line => line.trim() !== "");
    if (!lines.length) continue;

    // A cue starts at its timing line. Anything above it in the block is a
    // cue index or a stray blank -- both are dropped, because a leading
    // number is legal WebVTT but a stray one between cues is not worth
    // carrying, and SubRip indices shift when a cue is deleted anyway.
    const timingIndex = lines.findIndex(line => line.includes("-->"));
    if (timingIndex === -1) continue;

    const timing = toCueTiming(lines[timingIndex]);
    if (!timing) continue;

    const payload = lines
      .slice(timingIndex + 1)
      .map(escapeCueText)
      .join("\n");
    if (!payload.trim()) continue;

    out.push(timing, payload, "");
  }

  // Exactly one trailing blank line, never two: a doubled terminator is read by
  // some parsers as an empty cue and can swallow the last real one.
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}