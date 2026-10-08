/**
 * Comparing two language tags that may have been written by different people.
 *
 * The player ends up holding tags from three places that never agreed on a
 * form: the backend reports a viewer's language as ISO 639-1 (`pt`), an HLS
 * manifest declares its tracks as BCP-47 (`pt-BR`), and Archive.org's subtitle
 * files are named with ISO 639-2/B codes (`por`) because that is what a
 * filename convention from the 1990s settled on. A naive string compare makes
 * a Portuguese viewer's Portuguese subtitles invisible, and the mismatch is
 * silent -- the track is simply never selected.
 *
 * So everything is reduced to a canonical 639-1 code before it is compared.
 * Tags that cannot be reduced still compare on their own terms rather than
 * being dropped, because a language we do not have a mapping for is still a
 * language somebody might be watching in.
 */

/**
 * ISO 639-2/B -> 639-1, for every code the subtitle picker can emit.
 *
 * Deliberately closed rather than derived: the set of codes that reach this
 * file is fixed by `catalog_lib.LANG_CODES` (plus whatever a manifest ships,
 * which is at worst a 639-1 code we already handle), so a table of what is
 * actually possible beats a general converter that has to be trusted blind.
 */
const THREE_TO_TWO: Record<string, string> = {
  ara: "ar",
  ces: "cs",
  dan: "da",
  deu: "de",
  eng: "en",
  fin: "fi",
  fra: "fr",
  hin: "hi",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  nld: "nl",
  nor: "no",
  pol: "pl",
  por: "pt",
  rus: "ru",
  spa: "es",
  swe: "sv",
  ukr: "uk",
  zho: "zh",
};

/**
 * Canonical 639-1 form of a tag, or `""` when there is nothing to match on.
 *
 * Lowercased and truncated at the first subtag, so `pt-BR`, `pt_br` and `PT`
 * all collapse to `pt` -- region and script are a refinement of a language, not
 * a different one, for the purpose of asking whether a track is in the
 * viewer's language.
 */
export function baseLanguage(code: string | null | undefined): string {
  if (typeof code !== "string") return "";
  const trimmed = code.trim().toLowerCase();
  if (!trimmed) return "";
  const primary = trimmed.split(/[-_]/)[0];
  if (!primary) return "";
  return THREE_TO_TWO[primary] ?? primary;
}

/**
 * Whether two tags name the same language, in any of the forms above.
 *
 * Empty on either side never matches: "unknown" is not evidence of agreement,
 * and treating it as one would let a track with no declared language satisfy
 * every viewer's preference.
 */
export function sameLanguage(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const a = baseLanguage(left);
  const b = baseLanguage(right);
  return a !== "" && a === b;
}
