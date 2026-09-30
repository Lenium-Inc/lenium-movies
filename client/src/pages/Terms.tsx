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
 * defences.
 *
 * One correction worth recording, because the previous wording was false in a
 * way that mattered: it said the service does not "host, upload, store,
 * stream, transcode or proxy" any film, and that "playback happens inside a
 * frame pointed at a third-party host." Neither is true of the whole product.
 * `/api/movies/stream` is a same-origin relay that pulls Archive.org bytes
 * through the Flask app so range requests and seeking work, and
 * `/api/movies/download` relays the same bytes as an attachment. The embeds
 * are real too, but they are the fallback path, not the only one. Denying the
 * relay in the terms while running it is the kind of mismatch that turns a
 * reasonable description into a misrepresentation, so the sections below state
 * the relay, the embed fallback and the download button as they are.
 */
export default function Terms() {
  return (
    <LegalLayout
      title="Terms of Service"
      intro={`Last updated ${LEGAL_EFFECTIVE_DATE}. This is a plain description of how the service works and what you take on when you use it.`}
    >
      <LegalSection heading="What this service is">
        <p>
          Stream Vy is a streaming front end for public-domain and openly
          licensed film. We hold a catalogue of titles, series and episode
          listings, and when you press play we take you to a copy hosted by a
          third party. We do not ask anyone to upload a film, and we do not
          accept submissions.
        </p>
        <p>
          We do not host, upload or store any film or episode ourselves. Every
          copy you watch is served by someone else: either an external host we
          fetch from on your behalf, or a third-party player we embed in a
          frame on your browser. Those hosts operate independently of us and we
          do not control what they make available.
        </p>
        <p>
          Some titles are playable directly in our own player, and those are
          streamed through our servers as a pass-through to the host that holds
          the file. That relay exists so playback is same-origin, range requests
          and seeking work, and so we can offer a download button. It is not a
          copy kept on our infrastructure, but it does mean the bytes travel
          through our servers on their way to you.
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
            "Your taste signals — which titles you liked, saved or skipped — which is what the recommendations are built from.",
            "How many titles you have watched today, used to apply the daily viewing limit.",
          ]}
        />
        <p>
          We do not store media files, and we do not ask anyone to upload one.
        </p>
        <p>
          These lists and history are attached to the viewer profile that is
          active when you use the service, so several people can share one
          account without overwriting each other's recommendations.
        </p>
      </LegalSection>

      <LegalSection heading="Where playback comes from">
        <p>
          When you press play we look for a playable source, starting with
          titles in our own catalogue and falling back to third-party player
          frames when we have none. We rank and switch between sources
          automatically, and you can also pick one yourself. Quality therefore
          varies: a given title may be a clean high-quality encode on one host
          and a badly transcribed or wrongly labelled file on another. That
          variance originates with the host, not with us.
        </p>
        <p>
          Hosts are outside our control. They can change, break, or remove
          content at any time without notice, and their availability is
          frequently region-dependent.
        </p>
      </LegalSection>

      <LegalSection heading="Downloads">
        <p>
          Where a title is served as a single file from an Archive.org host, we
          offer a download button that saves that file to your device. The file
          is produced by the host, not by us. We do not keep a copy once the
          transfer finishes.
        </p>
        <p>
          Titles served only as a stream or only as an embedded player cannot be
          saved, and the button will say so rather than producing a broken
          file.
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
