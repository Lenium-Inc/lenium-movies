/**
 * Validation and conversion for subtitle files a viewer drops into the player.
 *
 * The contract with the viewer is deliberately one-sided: a file is either
 * good enough to render or it is refused outright. A half-parsed file that
 * silently shows nothing would be worse than a refusal, because the viewer
 * would sit through the movie believing their subtitles were on.
 */

export type SubtitleFileResult =
  | { ok: true; vtt: string }
  | { ok: false; reason: string };

/**
 * A cue timing line, tolerant of the two shapes real files arrive in:
 * `HH:MM:SS,mmm` (SRT), `HH:MM:SS.mmm` (VTT), and the short `MM:SS.mmm`
 * form WebVTT allows for cues inside the first hour.
 */
const TIMING_LINE =
  /(?:(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

const looksLikeVtt = (text: string): boolean =>
  text.split("\n", 1)[0]?.trimStart().startsWith("WEBVTT") ?? false;

/**
 * Convert SRT to WebVTT.
 *
 * Unlike a naive "skip the index line" pass, this finds the timing line
 * inside each block instead of assuming it sits at a fixed offset: SRT files
 * in the wild omit the numeric index, and a fixed-offset conversion silently
 * drops every cue from those files.
 */
const srtToVtt = (srt: string): string => {
  const blocks = srt.trim().split(/\n\s*\n/);
  const cues: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex(line => TIMING_LINE.test(line));
    if (timingIndex === -1) continue;

    const textLines = lines.slice(timingIndex + 1);
    if (textLines.length === 0) continue;

    // SRT separates milliseconds with a comma; WebVTT requires a period.
    const timing = lines[timingIndex].replace(/,/g, ".");
    cues.push(`${timing}\n${textLines.join("\n")}`);
  }

  return cues.length > 0 ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "";
};

/**
 * Parse a picked subtitle file into WebVTT, or explain why it cannot be used.
 *
 * Detection is by content, not extension: a `.vtt` holding an SRT body (or
 * vice versa, or a renamed script format with no cue timings at all) is
 * common enough that trusting the filename would let broken files through.
 */
export const parseSubtitleFile = (
  filename: string,
  raw: string
): SubtitleFileResult => {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  if (!text.trim()) {
    return { ok: false, reason: `"${filename}" is empty.` };
  }

  if (!TIMING_LINE.test(text)) {
    return {
      ok: false,
      reason: `"${filename}" has no cue timings, so there is nothing to show.`,
    };
  }

  if (looksLikeVtt(text)) {
    return { ok: true, vtt: text };
  }

  const vtt = srtToVtt(text);
  if (!vtt) {
    return {
      ok: false,
      reason: `"${filename}" has no readable cues.`,
    };
  }

  return { ok: true, vtt };
};
