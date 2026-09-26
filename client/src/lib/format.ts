/**
 * Display formatters for runtime and player position.
 *
 * Runtime arrives in two shapes depending on the endpoint: a bare number of
 * minutes from the catalog payloads, or an already-suffixed string like "86m"
 * from TMDB. Both are normalised to the same "1h 26m" / "26m" badge so a title
 * does not change appearance between the details page and the player.
 */

/**
 * Format a runtime as `1h 26m`, or plain `26m` under an hour.
 *
 * Accepts minutes as a number, or a string that may already carry an `m`
 * suffix. Returns an empty string for missing or unparseable input so callers
 * can omit the badge entirely.
 */
export function formatRuntime(minutes: string | number | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes === "") return "";

  const mins =
    typeof minutes === "string" ? parseInt(minutes.replace(/[m\s]/gi, ""), 10) : minutes;

  if (typeof mins !== "number" || !Number.isFinite(mins) || mins <= 0) return "";

  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;

  // A trailing "0m" reads as noise: 120 -> "2h", not "2h 0m".
  if (hours === 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

/**
 * Format a player position as `H:MM:SS`, or `MM:SS` under an hour.
 *
 * The hour segment is omitted rather than zero-padded for sub-hour media,
 * matching how Netflix, YouTube and the native browser control render a 36
 * minute title. Negative and non-finite input clamps to `00:00` so a bad
 * duration from a stream manifest can never render as `NaN:NaN`.
 */
export function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";

  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");

  return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}
