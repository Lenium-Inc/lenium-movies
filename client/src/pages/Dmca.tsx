import { Mail } from "lucide-react";
import {
  LegalLayout,
  LegalList,
  LegalSection,
} from "@/components/layout/LegalLayout";
import { LEGAL_CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE } from "@/lib/legal";

/**
 * Copyright and DMCA notice page.
 *
 * The service hosts no media of its own, so a takedown cannot be satisfied by
 * deleting a file from our infrastructure. What we can do is stop serving a
 * title, drop it from the catalogue so it is not re-listed, and pass the notice
 * to whoever actually controls the copy.
 *
 * The capability list below was previously narrower than what we can really do.
 * Because `/api/movies/stream` relays Archive.org bytes through the app server,
 * disabling a title does stop the bytes, not merely the embed pointing — and
 * that is worth stating plainly, since it is the part a rights holder actually
 * wants to know.
 */
export default function Dmca() {
  return (
    <LegalLayout
      title="Copyright & DMCA"
      intro={`Last updated ${LEGAL_EFFECTIVE_DATE}. How to reach us about copyrighted material reachable through this service, and what happens when you do.`}
    >
      <LegalSection heading="What this service hosts">
        <p>
          We host no films and no episodes, and there is no media library of
          ours to take down. The service holds a catalogue of titles and series
          information. Every copy itself sits on a third-party host: played
          either through an embedded frame or by our servers relaying bytes from
          that host.
        </p>
        <p>
          The relay matters for this notice. Because some playback passes
          through our servers, we are in a position to stop a title being served
          — and can do so for a title whether it arrives via a frame or a direct
          file. What we cannot do is delete the copy from the host that holds
          it.
        </p>
        <p>
          We would rather be plain about that boundary than imply a removal we
          cannot perform.
        </p>
      </LegalSection>

      <LegalSection heading="What we can act on">
        <LegalList
          items={[
            "Disabling a title, series or episode across the service so it is no longer listed or reachable, and so no further bytes are relayed for it.",
            "Blocking a provider or host so we stop directing playback to it.",
            "Removing a title from the catalogue entirely, so it is not rediscovered or re-listed.",
            "Terminating the accounts of repeat infringers, where an account is being used to infringe.",
            "Forwarding your notice to the provider or host that actually serves the content, where we can identify them.",
          ]}
        />
        <p>
          We cannot delete a copy of a work held on a third-party host, and we
          have no control over hosts that serve material from locations outside
          our reach.
        </p>
      </LegalSection>

      <LegalSection heading="Submitting a notice">
        <p>Send notices by email to:</p>
        <a
          href={`mailto:${LEGAL_CONTACT_EMAIL}`}
          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/10"
        >
          <Mail className="h-4 w-4" />
          {LEGAL_CONTACT_EMAIL}
        </a>
        <p>Please include, so the notice can be acted on without a follow-up:</p>
        <LegalList
          items={[
            "Your full name and a way to reach you.",
            "Identification of the work you believe is being infringed. A title alone is often enough to identify it, but a URL or catalogue entry helps us find it quickly.",
            "The specific page or provider link where you encountered it, if you have one.",
            "A statement that you have a good-faith belief the use is not authorised by the copyright owner, its agent, or the law.",
            "A statement, under penalty of perjury, that the information in your notice is accurate and that you are authorised to act on the owner's behalf.",
            "Your physical or electronic signature.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="What happens next">
        <p>
          We review complete notices and act on ones we can verify. Where the
          material is reachable here, that normally means disabling the entry.
          We will confirm what we were able to do.
        </p>
        <p>
          Incomplete notices cannot be acted on. If we need more information we
          will write back to the address you supplied.
        </p>
      </LegalSection>

      <LegalSection heading="Counter-notices">
        <p>
          If you believe material was disabled by mistake or misidentification,
          write to the same address with the material identified, why you
          believe the disablement was an error, and a statement under penalty of
          perjury that the notice was a mistake and that you are authorised to
          act for the owner. We will forward the counter-notice and, unless the
          original complainant objects, may restore access.
        </p>
      </LegalSection>

      <LegalSection heading="Repeat infringement">
        <p>
          In clear cases of repeat infringement we may disable access or close
          accounts without further notice.
        </p>
      </LegalSection>

      <LegalSection heading="Misrepresentation">
        <p>
          Knowingly misrepresenting that material is infringing, or that it is
          removed by mistake, carries liability for damages under 17 U.S.C.
          § 512(f). Please be sure before you file.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
