/**
 * User-facing playback copy.
 *
 * These strings are deliberately provider- and infrastructure-agnostic. The
 * resolver cycles through several upstream mirrors and the first one often has
 * a cold start; neither fact is something a viewer needs narrated, and naming
 * a specific mirror only makes the UI worse when that mirror is swapped out.
 *
 * Defined in one place because the same messages render in both the page shell
 * and the player, and they drifted apart when they were inline literals.
 */

export const preparingTitle = "Preparing your video…";

export const optimizingStream = "Optimizing high-definition stream…";

export const reconnecting = "Reconnecting…";

export const findingBestStream = "Finding the best stream…";

export const titleUnavailable =
  "This title is temporarily unavailable. Please try again later.";

/**
 * Shown when the backend resolved the title but reported no direct, ad-free
 * source for it. Distinct from `titleUnavailable` on purpose: the resolver is
 * working, the title simply is not in the direct catalog yet, so "temporarily
 * unavailable" reads as a fault and invites pointless retrying. A newer release
 * lands here.
 */
export const noDirectSource =
  "No direct source for this title yet. A backup provider may still have it.";

export const tryAgain = "Try again";

/**
 * Shown when the viewer picks a backup source but has not accepted third-party
 * embeds. Without this the button silently does nothing, which reads as a bug.
 */
export const embedConsentNeeded =
  "Backup playback is blocked because third-party embeds were declined. Update your choice in the cookie notice to allow them.";

/** Neutral label for the manual source-cycle control on the error card. */
export const tryAnotherSource = "Try another source";
