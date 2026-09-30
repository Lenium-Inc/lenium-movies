# Stream Vy Content and Playback

**This is the document that most needs to be read before any public claim.**

An earlier version of this file described a rights-management system: a
`RightsGrant` entity with rights owner, contract reference, territory, start and
end dates, permitted playback method, platform and monetization restrictions, an
evidence package, a reviewer decision, overlap and precedence rules, 90/30/7-day
expiry alerts, a one-business-hour takedown SLA, and a policy engine that evaluates
deny → takedown → expiry → territory → platform → source **and fails closed**.

**None of that is implemented.** There is no rights table, no rights evaluation,
no evidence store, no reviewer, no expiry job, and no policy engine. Any document
describing publication as gated on a valid rights grant is describing fiction.

## What actually happens when someone presses play

```text
client  -> POST /api/movies/resolve   (title or tmdb id + media type)
server  -> stream_providers.resolve()
            tier 1  direct   Archive.org-backed catalog entry -> real MP4/HLS
            tier 2  embed    third-party iframe, ordered by priority
          -> first playable source + remaining ordered candidates
client  -> plays direct source through /api/movies/stream  (server relay)
        -> or renders the first embed candidate in an iframe, labelled as an embed
```

The client never decides which provider to use. Before `stream_providers.py`
existed, two disjoint provider lists lived in `app.py` and
`client/src/lib/embedSources.ts`, and "the primary is down" was decided in the
browser, one click at a time. Each provider now has a health record with a
cooldown, so a provider that just failed is skipped rather than re-probed on the
next request. A request fails only after every enabled provider is tried.

## The two tiers, honestly

**Direct (Archive.org).** `movie-backend/movies.json` carries a catalog of titles
with public identifiers. Playback is a genuine MP4/HLS stream relayed by our own
server, which is what makes seeking, range requests, and downloads work. The
titles are presented as public-domain works from Archive.org's public collections.
**We do not verify that claim per title.** The catalog is a list of identifiers
with a provenance assumption, not an audited rights determination. Nothing in the
code would notice if an entry were wrong.

**Embed.** Anything not in the direct catalog resolves to a third-party iframe
(`vidsrc` and six sibling hosts, in priority order). The UI states that it is an
embed. That host decides what plays, where it plays, and whether it plays. We
probe providers server-side to skip dead ones, but we do not control, audit, or
have a contractual relationship with them. Some are the kind of site that hosts
unauthorized copies.

`STREAM_PROVIDER_ORDER` and `STREAM_PROVIDER_DISABLED` reshape the chain without a
code change, which means the direct tier can be disabled and the product becomes
entirely dependent on third-party embeds. That is an operator decision with legal
weight and no guard rail in the code.

## What is not hosted

No application media files are stored, transcoded, packaged, or delivered from
object storage. There is no HLS packaging pipeline, no FFmpeg worker, no CDN with
signed URLs, no DRM, no captions pipeline, and no media upload path. `/api/movies/
download` relays a byte range for a title the direct catalog already carries; it
does not originate a download of anything.

## What is disclosed to users

`client/src/pages/Terms.tsx` and `client/src/pages/Dmca.tsx` state, in plain
language:

- playback is relayed from Archive.org or served by third-party embed providers,
- we do not host the media,
- what is stored about a viewer's watching (history, progress, saved media,
  derived taste features, and daily play counts),
- the takedown contact and that verified takedown requests are honoured.

`client/src/pages/Home.tsx` states the same in-product, next to the fact that the
free allowance is 10 titles per profile per day and 20 per account per day.

## DMCA and takedown

`/dmca` publishes a contact address and states that a verified takedown request
removes the title. That is a **manual** process: a human reads the request, edits
`movies.json` or disables the provider, and redeploys. There is no automated
takedown pipeline, no webhook, no blocklist table, and no SLA. Do not describe
takedown as immediate or self-service.

## What would have to be true before claiming licensed content

1. A `RightsGrant`-shaped entity with owner, contract or public-domain basis,
   territory, validity dates, permitted playback method, platform limits, and an
   evidence reference.
2. Policy evaluation in the resolve path, so an unentitled title never reaches
   the client, with an explicit decision for the not-configured case rather than
   a default-allow.
3. A publication gate: a title appears only when its rights state allows it.
4. A takedown path that actually blocks new sessions without a redeploy.
5. Legal review of the evidence model, the Archive.org public-domain
   assumption, the embed tier, and the DMCA process.

Until then, the honest product description is the one in [prd](prd.md): a free
discovery and playback front end over publicly reachable sources, with no claim
to hold streaming rights.

## Prohibited

The product does not scrape stream indexes it was not given, bypass DRM,
paywalls, geo-restrictions, or access controls, download copyrighted media
without permission, or infer a right to stream from a public URL. That is a
constraint on how this code may be extended, and it is why the embed tier is
described plainly rather than dressed up as a provider integration.
