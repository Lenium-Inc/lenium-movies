/**
 * Canonical paths for shared lists.
 *
 * An invite is minted as `/list/share/<token>` and is read at both that path and
 * the older `/share/<token>`, so links handed out before the rename keep
 * working. The path is defined once here rather than assembled at each call
 * site: ShareListDialog mints it, ShareInvite returns to it after sign-in, and
 * drifted copies of a route string are exactly how a link ends up 404ing for
 * only some of the people who received it.
 */

/** Path of the public invite page for `token`. */
export function sharePath(token: string): string {
  return `/list/share/${encodeURIComponent(token)}`;
}

/** Path of the public read-only view of `ownerId`'s list. */
export function sharedListPath(ownerId: string): string {
  return `/list/share/shared/${encodeURIComponent(ownerId)}`;
}
