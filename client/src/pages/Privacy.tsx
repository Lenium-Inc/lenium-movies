import {
  LegalLayout,
  LegalList,
  LegalSection,
} from "@/components/layout/LegalLayout";
import { LEGAL_CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE } from "@/lib/legal";

/**
 * Privacy notice.
 *
 * This page existed only as a promise. The cookie banner linked to `/terms`
 * under the label "Privacy terms", and the terms page never covered privacy:
 * no list of what is collected, no deletion route, and a cookie banner
 * promising a choice the backend had no record of.
 *
 * Everything claimed below is checked against the code. `authdb.py` is the
 * schema of record — the tables named here are the ones that exist, and the
 * analysis store is only raw search text that is hashed into a token before it
 * is written. The one genuinely external party is the metadata provider and the
 * playback hosts, both named, because a notice that hides who else sees your
 * activity is not a notice.
 */
export default function Privacy() {
  return (
    <LegalLayout
      title="Privacy Notice"
      intro={`Last updated ${LEGAL_EFFECTIVE_DATE}. What Stream Vy records, why, how long it keeps it, and what you can do about it.`}
    >
      <LegalSection heading="The short version">
        <p>
          We store your email address, your watch history, your list, and the
          signals about what you like. That is what lets the service remember
          you between visits and build recommendations for each person in a
          shared household. We do not sell any of it, we do not use it for
          advertising, and we do not run third-party analytics.
        </p>
        <p>
          You can delete individual history entries, clear your whole history,
          and delete your entire account — permanently, with everything
          attached to it.
        </p>
      </LegalSection>

      <LegalSection heading="What we collect">
        <LegalList
          items={[
            "Account details: the email address and display name you sign up with, and a hashed password. We cannot read your password back.",
            "Viewer profiles: the up to four profiles on your account, each with a name, an optional avatar, an optional kids flag, and an optional PIN stored only as a salted hash.",
            "Watch history: which titles you played, when, and how far through you got, so Continue Watching and your history survive a sign-out.",
            "My List: the titles you save.",
            "Taste signals: which titles and genres you liked, disliked, saved or skipped. This is what the recommendations are computed from.",
            "Play counts per day: used only to apply the daily viewing limit.",
            "Referral codes, if you use them, and which accounts redeemed them.",
            "Shared lists: if you invite someone to your list, their membership and the email you invited.",
          ]}
        />
        <p>
          History, lists, taste and play counts are recorded against the
          viewer profile that was active when you used the service, not just
          against your account. That is why people can share one account without
          overwriting each other's recommendations.
        </p>
      </LegalSection>

      <LegalSection heading="Who else sees your activity">
        <p>
          When you play a title, your browser contacts the host that holds that
          copy, and that host sees the request — including your IP address —
          the same way it would if you visited their site directly. Some
          playback happens in an embedded third-party player, which gives that
          provider the same visibility and lets it set its own cookies.
        </p>
        <p>
          Catalogue metadata — titles, synopses, artwork, cast, ratings — comes
          from TMDB. We send search and title requests to their API; we do not
          send your account details or your watch history to them.
        </p>
      </LegalSection>

      <LegalSection heading="Analytics and cookies">
        <p>
          There are no third-party analytics scripts in this product. There is
          no advertising network and no cross-site tracking.
        </p>
        <p>
          Essential storage in your browser holds your session, your list, your
          history, your preferences and your theme. Clearing your browser data
          removes those, and you will have to sign in again.
        </p>
      </LegalSection>

      <LegalSection heading="Your choices">
        <LegalList
          items={[
            "Remove a single title from your history at any time, from your account page.",
            "Clear your entire watch history from the same page.",
            "Delete your account permanently from your account page. This removes every profile, history entry, saved title, taste signal, referral code and shared-list membership attached to it, and signs out every device. It cannot be undone.",
          ]}
        />
        <p>
          Deleting your account asks you to confirm your email address and
          password. That is deliberate: your session is a long-lived token, and
          a token alone should not be enough to destroy someone's history.
        </p>
      </LegalSection>

      <LegalSection heading="Security">
        <p>
          Passwords and profile PINs are stored as salted PBKDF2-SHA256 hashes
          and are never stored or transmitted in plain text. Session tokens are
          random values held in hashed form; the token itself is kept in your
          browser's local storage and sent with each request.
        </p>
        <p>
          Being plain about the limits: because the session token lives in
          local storage rather than an HttpOnly cookie, a script that manages to
          run on this origin could read it. Keep your device secure and do not
          use Stream Vy on a machine you do not trust.
        </p>
      </LegalSection>

      <LegalSection heading="Retention">
        <p>
          Data is kept while your account exists. Watch history and taste
          signals are what make the service remember you, so they are kept
          until you remove them or delete your account — there is no separate
          expiry schedule. Deleting your account is the only event that
          removes them.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about this notice, or a request about your data, can go to{" "}
          <a
            href={`mailto:${LEGAL_CONTACT_EMAIL}`}
            className="text-violet-300 underline underline-offset-4 hover:text-violet-200"
          >
            {LEGAL_CONTACT_EMAIL}
          </a>
          .
        </p>
        <p>
          Our{" "}
          <a href="/terms" className="text-violet-300 underline underline-offset-4 hover:text-violet-200">
            terms of service
          </a>{" "}
          and{" "}
          <a href="/dmca" className="text-violet-300 underline underline-offset-4 hover:text-violet-200">
            copyright notice
          </a>{" "}
          cover the rest.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}