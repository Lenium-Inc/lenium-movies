# Stream Vy Documentation

These documents describe **the code in this repository as it actually is**. Where
a system is not built, the document says so instead of describing it as if it
were. Nothing here is a launch approval, a legal opinion, or a production-readiness
claim.

## Read these first

| Document                              | What it answers                                     |
| ------------------------------------- | --------------------------------------------------- |
| [Product requirements](prd.md)        | What the product is, what it does, what it refuses  |
| [Architecture](architecture.md)      | How the SPA, Express wrapper, and Flask backend fit |
| [API](api.md)                         | Every route the backend actually serves             |
| [Data model](data-model.md)           | Every table that actually exists                    |
| [Security](security.md)               | Real controls, and the real gaps                    |
| [Content and playback](content-rights.md) | What is streamed, how, and what is not known     |
| [Environment](environment.md)         | The variables the code reads                        |
| [Testing](testing.md)                 | How to run the suites and what they cover           |
| [Deployment](deployment.md)           | How it is deployed and what needs config            |

## Supporting documents

| Document                                     | What it answers                                  |
| -------------------------------------------- | ------------------------------------------------ |
| [Feature map](features.md)                   | Feature-by-feature honest status                 |
| [Metadata provider](metadata-provider.md)    | How TMDB is used, and the licensing caveat       |
| [Trailers](trailer-architecture.md)          | How trailers resolve, and what is not cached     |
| [Integrations](integrations.md)              | Every external dependency and its fallback       |
| [User journeys](userjourney.md)              | The flows that work end to end                   |
| [Use cases](usecases.md)                     | Actor-level capabilities and their authorization |
| [Agent instructions](agent.md)               | Non-negotiable rules for contributors            |
| [Roadmap](roadmap.md)                        | Known gaps, in dependency order                  |

## Historical records

These were accurate audits of an earlier state of this repository. They are kept
because deleting an audit erases the reasoning, **not** because they describe the
current product. Where they conflict with the documents above, the documents
above win.

- [Documentation audit (historical)](audit.md)
- [Production-readiness audit (historical)](production-readiness-audit.md)
- [Performance report (historical)](performance-report.md)

## Removed as fiction

`sitemap.md`, `seo.md`, and `ad-blocking.md` described a server-rendered
catalogue, a sitemap generator, and a rule-based ad-blocking engine. None of those
exist. The gaps they describe are recorded in [roadmap](roadmap.md) and
[feature map](features.md) instead of being documented as features.

## Honest status summary

Stream Vy is a working movie discovery and playback product, not a rights-managed
streaming platform. The catalogue, accounts, profiles, taste recommendations,
daily allowance, history, shared lists, and playback are real and server-backed.
Explicit rights approval, creator submission, moderation, review, and analytics
pipelines are not built. See [content and playback](content-rights.md) for the
distinction that matters most.
