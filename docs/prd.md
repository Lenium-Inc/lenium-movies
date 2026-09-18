# FreeStream Product Requirements

## Product promise

FreeStream helps viewers **discover, decide, play, and remember** authorized films with minimal friction. The product must never imply that a title is playable when the platform lacks valid rights or a healthy playback source.

## Personas

| Persona       | Primary need                  | MVP surface                                  |
| ------------- | ----------------------------- | -------------------------------------------- |
| Casual viewer | Find a good film quickly      | Home, search, movie page, authorized play    |
| Enthusiast    | Track and explore taste       | Watchlist, history, ratings, recommendations |
| Filmmaker     | Submit and manage a film      | Creator portal, rights declaration, status   |
| Administrator | Operate catalogue and trust   | Admin, rights, moderation, ingestion         |
| Partner       | Control licensed distribution | Rights, availability, reporting              |

## MVP requirements

The MVP must provide public home, search with facets, crawlable movie pages, authenticated watchlist and progress, metadata recommendations, admin catalogue records, provider-backed ingestion, rights records, authorized playback sessions, analytics, and accessible loading, empty, error, and unavailable states.

A title becomes playable only when it has a valid rights grant, an active playback source, processed media status, and a policy decision that permits the current request. The UI must show an honest availability state otherwise.

## Explicit non-goals

FreeStream will not scrape unauthorized streaming sites, download copyrighted media without permission, bypass DRM or geo-restrictions, fabricate ratings or reviews, or expose fake play buttons. Social features, subscriptions, creator revenue reporting, and advanced recommendation models are post-MVP unless a business decision promotes them.

## Success metrics

The first release should measure median landing-to-play time, search-to-detail conversion, detail-to-play conversion, playback success, rights-denied rate, zero-result rate, watchlist adoption, completion rate, retention, ingestion success, and time from rights approval to searchable publication.

## Acceptance principles

Every user-facing feature must have a real state model, an owner, error handling, an authorization policy, and an observable event. A provider-dependent capability must declare its provider and required configuration before it is enabled.

## References

[1]: https://www.w3.org/WAI/standards-guidelines/wcag/ "Web Content Accessibility Guidelines"

## Audit remediation: user trust and inclusive UX

### Privacy acceptance criteria

The product must provide a plain-language privacy notice, consent controls for non-essential analytics, account export and deletion flows, data retention explanations, cookie controls, and a visible way to report rights or privacy concerns. Personalized recommendations and playback telemetry must be explainable at a high level and must not be required for anonymous catalogue browsing.

### Accessibility and mobile acceptance criteria

The public experience targets WCAG 2.2 AA where practical. Keyboard users can reach navigation, search, cards, dialogs, and player controls. Focus is visible. Dialogs trap focus and restore it. Posters have meaningful alternative text or are marked decorative. Captions are available whenever supplied by the authorized source. Touch targets are at least 44 CSS pixels, horizontal rows support touch without trapping the page, and low-bandwidth mode avoids autoplay and heavy artwork. Reduced-motion preferences disable non-essential transitions.
