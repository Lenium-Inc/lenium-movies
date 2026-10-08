/**
 * User-facing playback copy.
 *
 * These strings are deliberately provider- and infrastructure-agnostic. The
 * resolver walks several upstream providers and the first one often has a cold
 * start; neither fact is something a viewer needs narrated, and naming a
 * specific provider only makes the UI worse when that provider is swapped out.
 *
 * Defined in one place because the same messages render in both the page shell
 * and the player, and they drifted apart when they were inline literals.
 *
 * Note what is *not* here. There used to be stage labels ("Optimizing
 * high-definition stream…", "Finding the best stream…"), a "no direct source
 * yet" message, an embed-consent explanation, and a "Try another source" label.
 * All of them described machinery the viewer cannot act on: the backend picks
 * the provider now, an embed is a normal way to play rather than a compromise
 * needing consent, and a failed title is either playable or it is not. The
 * waiting state is a wordless loader, so there is nothing to say while it runs.
 */

export const titleUnavailable = "This title is currently unavailable.";

export const tryAgain = "Try again";
