import {
  LegalLayout,
  LegalList,
  LegalSection,
} from "@/components/layout/LegalLayout";
import { LEGAL_CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE } from "@/lib/legal";

/**
 * Terms of Service.
 *
 * Written to describe what the service actually is rather than to assert
 * defences. The service indexes third-party embeds and hosts no media of its
 * own; anything implying otherwise would be both inaccurate and, in the case
 * of an indexing service, not a defence that exists.
 */
export default function Terms() {
  return (
    <LegalLayout
      title="Terms of Service"
      intro={`Last updated ${LEGAL_EFFECTIVE_DATE}. This is a plain description of how the service works and what you take on when you use it.`}
    >
      <LegalSection heading="What this service is">
        <p>
          Stream Vy is an indexing interface for third-party streaming
          providers. It stores a catalogue of titles, series and episode
          listings, and embeds media that is served by external providers
          entirely on their own infrastructure.
        </p>
        <p>
          We do not host, upload, store, stream, transcode or proxy any film or
          episode. Playback happens inside a frame pointed at a third-party
          host, and those hosts operate independently of us.
        </p>
      </LegalSection>

      <LegalSection heading="What we store">
        <p>
          To keep the service running we store only the small amount of data
          needed for the product to function:
        </p>
        <LegalList
          items={[
            "Account details you provide, such as an email address and display name.",
            "Your watch history, ratings and My List, so they persist between sessions.",
            "Display and playback preferences, such as your selected server and subtitle language.",
          ]}
        />
        <p>
          We do not store media files, and we do not ask anyone to upload one.
        </p>
      </LegalSection>

      <LegalSection heading="Where playback comes from">
        <p>
          When you press play, your browser is pointed at an external provider.
          We rank and switch between those providers automatically, and you can
          also pick one yourself. Quality therefore varies by provider: a given
          title may be served as a high-quality encode on one host and as a
          badly transcribed or wrongly labelled file on another. That variance
          originates with the provider, not with us.
        </p>
        <p>
          Providers are outside our control. They can change, break, or remove
          content at any time without notice, and their availability is
          frequently region-dependent.
        </p>
      </LegalSection>

      <LegalSection heading="Your responsibilities">
        <p>By using this service you accept that:</p>
        <LegalList
          items={[
            "Accessing or downloading media through third-party providers may be unlawful in your jurisdiction. Checking your local law is your responsibility.",
            "You will use the service only for personal, non-commercial use.",
            "You will not attempt to disrupt the service, probe it without authorisation, or use it to build another product.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="No warranty">
        <p>
          The service is provided as-is, without warranty of any kind. Because
          playback is served by third parties we do not control, we cannot
          promise that any title will be available, that it will be the correct
          title or the correct episode, or that it will play without interruption.
        </p>
      </LegalSection>

      <LegalSection heading="Limitation of liability">
        <p>
          To the fullest extent permitted by law, the operators are not liable
          for any loss arising from your use of the service, including content
          provided by third parties, unavailable or mislabelled media, or any
          claim about the legality of material you access.
        </p>
        <p>
          These terms do not limit rights you have under mandatory consumer
          law in your jurisdiction, and nothing here is intended to waive them.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about these terms, or anything else relating to the service,
          can be sent to{" "}
          <a
            href={`mailto:${LEGAL_CONTACT_EMAIL}`}
            className="text-violet-300 underline underline-offset-4 hover:text-violet-200"
          >
            {LEGAL_CONTACT_EMAIL}
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          These terms may be updated as the service changes. The date at the
          top always reflects the current version.
        </p>
      </LegalSection>

      <LegalSection heading="Copyright complaints">
        <p>
          Rights holders with a concern about content reachable through this
          service should use the process on our{" "}
          <a href="/dmca" className="text-violet-300 underline underline-offset-4 hover:text-violet-200">
            copyright and DMCA page
          </a>
          , which sets out exactly what to send and where.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
