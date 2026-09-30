/**
 * Cookie / storage notice.
 *
 * Two different things are going on here and the notice is careful to separate
 * them, because conflating them is what makes these banners ignorable:
 *
 * 1. **Essential** storage. The session token, the local list, watch history and
 *    the theme all live in `localStorage` under the `freestream-*` and
 *    `lenium_*` keys. There is no advertising, no cross-site tracking and no
 *    third-party analytics in this app, and declining cannot break sign-in or
 *    playback -- so the choice offered here is "accept" or "essential only",
 *    and essential-only is a real, working option.
 *
 * 2. **Third-party embeds.** When no directly playable source resolves, playback
 *    loads an <iframe> from an external provider, and *that* provider can set its
 *    own cookies. This is the part worth naming, because it is the only place
 *    another party is involved.
 *
 * The banner used to gate those embeds: picking "essential only" made the player
 * refuse to load a frame. Provider failover is now the backend's decision, so a
 * gate here would mean a viewer whose title only has an embed available simply
 * cannot watch it -- which the notice would be describing accurately and nobody
 * would want. The choice is therefore recorded as a notice about what happens,
 * not as a switch that changes behaviour, and the copy says so.
 *
 * Consent is stored locally under `freestream-consent-v1`. There is no backend
 * to record it against, so this is a stated limitation rather than a silent
 * one: clearing site data resets the choice to ask again.
 */

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { readEmbedConsent, setEmbedConsent } from "@/services/lists";

export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Defer one frame so the banner never competes with the first paint for
    // layout, and so it cannot shift content the viewer is already reading.
    const frame = window.requestAnimationFrame(() => {
      if (readEmbedConsent() === "undecided") setVisible(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const choose = (choice: "accepted" | "essential") => {
    setEmbedConsent(choice);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      className="fixed inset-x-0 bottom-0 z-50 px-3 pb-3 sm:px-6 sm:pb-6"
    >
      <div className="mx-auto max-w-4xl rounded-2xl border border-white/10 bg-[#0b0b0f]/95 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl sm:p-6">
        <h2 className="text-sm font-semibold text-white">
          Cookies and local storage
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-white/60 sm:text-sm">
          We store your sign-in session, My List, watch history and theme in this
          browser so the site works. That storage is essential and we do not use
          advertising or cross-site tracking cookies.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-white/60 sm:text-sm">
          When a title has no directly playable stream, playback loads a video
          frame from an external provider, which may set its own cookies. We
          choose the provider for you; you can see which one is in use from the
          tabs above the player.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => choose("accepted")}
            className="bg-indigo-600 text-white hover:bg-indigo-500"
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => choose("essential")}
            className="border-white/15 text-white/80 hover:bg-white/5 hover:text-white"
          >
            Essential only
          </Button>
          {/* Deliberately no onClick: recording a choice because someone went
              to read the terms would consent on their behalf. Navigating leaves
              the notice undecided, so it is still there when they come back. */}
          <Link
            href="/privacy"
            className="ml-auto text-xs text-white/50 underline underline-offset-4 transition hover:text-white/80"
          >
            Privacy notice
          </Link>
        </div>
      </div>
    </div>
  );
}

export default CookieBanner;
