# FreeStream User Journeys

## Viewer: discover to play

The viewer lands on a fast server-rendered home page, scans a featured title or enters search, uses suggestions or filters, opens a canonical movie page, reviews synopsis and availability, and selects play. The playback request is evaluated by rights policy. If allowed, the viewer receives a short-lived session. If denied, the page explains the reason without exposing provider internals.

## Viewer: remember

During playback, progress events are throttled and persisted. Returning viewers see a continue-watching item with remaining time. They can resume, remove the item, or clear their history. Progress is associated with an account and device-independent where policy allows.

## Viewer: save and rate

A signed-in viewer adds a movie to a watchlist, filters or sorts saved titles, marks watched, rates a title, and writes an optional review. Spoiler reviews are labeled. Reports enter moderation and never become public until policy checks complete.

## Creator: submit

A creator creates a profile, enters metadata, uploads poster, trailer, video, and captions, submits rights declarations, and sees validation errors. The submission enters review. Administrators request changes, approve rights, attach playback sources, and publish only after the pipeline is complete.

## Administrator: ingest and publish

An operator runs or schedules an ingestion job. The job records provider provenance, validates and normalizes metadata, deduplicates records, processes artwork, updates search, and reports failures. The operator reviews rights, moderation, and media readiness before publication.

## Rights expiry

A rights job identifies grants approaching expiry. Administrators receive an alert. At expiry, the policy engine denies new playback sessions and the title displays an availability state. Existing sessions follow the contract policy; no new temporary access is issued.
