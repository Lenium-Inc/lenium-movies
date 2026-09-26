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

export const tryAgain = "Try again";

/** Neutral label for the manual source-cycle control on the error card. */
export const tryAnotherSource = "Try another source";
