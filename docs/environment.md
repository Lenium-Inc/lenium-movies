# Lenflix Environment Configuration

## Application configuration

`APP_BASE_URL`, `APP_ENV`, `SESSION_SECRET`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `SEARCH_URL`, `SEARCH_ADMIN_KEY`, `SEARCH_INDEX`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY`, and `OBJECT_STORAGE_SECRET_KEY` are required according to the selected infrastructure.

## Provider configuration

`METADATA_PROVIDER_KEY`, `VIDEO_PROVIDER_ID`, `VIDEO_PROVIDER_SIGNING_SECRET`, `VIDEO_PROVIDER_WEBHOOK_SECRET`, `EMAIL_PROVIDER_KEY`, `ERROR_TRACKING_DSN`, `ANALYTICS_SITE_ID`, and malware-scanning configuration are stored in a managed secret manager. They are never committed to source control or returned to browsers.

## Configuration rules

Startup validates required production variables and fails fast for unsafe combinations. Staging uses sandbox providers. Feature flags can disable playback, uploads, reviews, or creator submissions independently while preserving honest UI states.

## Rotation and access

Secrets are rotated on a documented schedule and after incidents. Workers receive only the credentials they need. Access is logged. Local development uses a separate environment file outside the repository and sanitized example configuration in documentation.
