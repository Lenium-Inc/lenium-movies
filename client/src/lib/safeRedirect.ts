/**
 * Post-authentication redirect targets.
 *
 * A share invite that a signed-out visitor opens is the main source of these
 * links: `/login?next=/list/share/<token>`. Without this, AuthPage always sent
 * people to `/profiles` and the invite was silently dropped, so the whole
 * "share with someone who has no account yet" path dead-ended at the login form.
 *
 * The value arrives from the query string, which makes it attacker-controllable,
 * so it is validated rather than trusted. `javascript:` and `https://evil.test`
 * both survive a naive "does it start with a slash?" check, and browsers treat
 * `/\evil.test` as protocol-relative, so all of those are rejected here instead
 * of being handed to `navigate()`.
 */

/** Where people land when they sign in without a `next`. */
export const DEFAULT_POST_AUTH_PATH = "/profiles";

// C0 controls, DEL, and the C1 range. Browsers strip some of these while
// parsing a URL, so `/%09/evil.test` can end up meaning something other than
// what the raw string looks like.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function isSafeInternalPath(candidate: string): boolean {
  if (CONTROL_CHARS.test(candidate)) return false;

  // Must be a single leading slash: `//host` and `/\host` are both
  // protocol-relative and would leave the origin.
  if (!candidate.startsWith("/")) return false;
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return false;

  // A backslash is treated as `/` by URL parsers, so `/path\..\..\x` style
  // traversal has to be checked with the separator normalised.
  const normalised = candidate.replace(/\\/g, "/");
  if (normalised.startsWith("//")) return false;

  return true;
}

/**
 * Resolve a `next` query value to a path that is safe to navigate to.
 *
 * Returns the `next` value when it is a same-origin path, otherwise `fallback`.
 * Never returns a value that could navigate off-origin.
 */
export function safeRedirectPath(
  next: string | null | undefined,
  fallback: string = DEFAULT_POST_AUTH_PATH
): string {
  if (typeof next !== "string") return fallback;
  const trimmed = next.trim();
  if (!trimmed || !isSafeInternalPath(trimmed)) return fallback;
  return trimmed;
}

/**
 * Read the `next` value out of a query string (with or without the leading `?`).
 *
 * Invites put a bare token in the path, so the value may legitimately contain
 * characters that must survive round-tripping; it is therefore decoded exactly
 * once, by `URLSearchParams`, and validated afterwards.
 */
export function nextPathFromSearch(
  search: string,
  fallback: string = DEFAULT_POST_AUTH_PATH
): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) return fallback;
  return safeRedirectPath(new URLSearchParams(query).get("next"), fallback);
}
