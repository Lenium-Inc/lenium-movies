# Lenflix Security Model

## Trust boundaries

The browser is untrusted. Public API inputs, uploads, playback callbacks, provider webhooks, and admin actions require validation. Secrets, provider credentials, signing keys, and storage access remain server-side.

## Identity and authorization

Sessions use secure, HttpOnly, SameSite cookies or an equivalent managed session mechanism. Password credentials, if enabled, use a modern password hashing algorithm and verified email flow. RBAC separates viewer, creator, moderator, administrator, and partner capabilities. Resource-level checks ensure a creator can access only owned submissions and a partner can access only contracted catalogue scope.

## Rights enforcement

The rights policy service evaluates movie, source, rights grant, territory, platform, date, account, and restrictions. It fails closed. Temporary playback access is short-lived, signed, and bound to the approved source and session. DRM is delegated to the authorized provider when contractually required; no bypass mechanism is permitted.

## Input and file safety

Validate all inputs with a shared schema. Escape rendered user content. Use a restrictive Content Security Policy where compatible. Uploads require MIME and extension validation, size limits, malware scanning, quarantine, and asynchronous processing. Original uploads are private and are not served directly.

## Abuse prevention

Use rate limits for authentication, search, reviews, playback-session creation, uploads, and reports. Add bot detection and account creation controls. Verify webhooks with signatures and replay protection. Record security events without collecting unnecessary personal data.

## Admin security

Require MFA architecture for administrative roles, least-privilege permissions, session revocation, audit logs, and break-glass procedures. Sensitive operations such as changing rights, providers, or public availability require an explicit reason and before/after record.

## Security headers

Deploy HTTPS, HSTS, CSP, frame restrictions, MIME sniffing protection, referrer policy, permissions policy, secure cookies, and strict CORS. Review exceptions for media manifests, captions, OAuth, analytics, and provider embeds.

## Incident response

Monitor authentication failures, suspicious playback creation, upload failures, rights anomalies, provider errors, and admin changes. Maintain a documented process for credential rotation, rights takedown, data export, account deletion, and provider compromise.

## Audit remediation: identity, uploads, and privacy

### Authentication lifecycle

Sessions rotate after login, privilege change, password reset, and suspicious activity. Refresh or session tokens are hashed at rest, revoked server-side, and bounded by idle and absolute expiry. Password reset tokens are single-use and short-lived. Email changes require re-verification. Account deletion and data export are authenticated, rate limited, and audited.

### RBAC and policy versioning

Permissions are deny-by-default, evaluated server-side, and scoped to resource ownership, partner contract, territory, and action. Roles are not sufficient for rights decisions. Permission changes invalidate relevant sessions and are logged with actor, reason, previous role, new role, and policy version. Admin MFA is required before production admin access.

### Upload state machine

Uploads move through `created -> uploading -> quarantined -> scanned -> validated -> processing -> ready -> published` or a terminal rejected state. Enforce resumable upload limits, archive/decompression-bomb protection, media duration and codec limits, image pixel limits, filename normalization, virus scanning, content-type sniffing, signed upload parts, object-lock or retention where required, and automatic cleanup of abandoned uploads.

### Privacy and analytics

Collect only events necessary for product, security, and playback operations. Consent gates non-essential analytics and marketing events. Store pseudonymous identifiers, separate account identity from telemetry, define retention by event class, honor deletion/export requests, and document regional processing, subprocessors, cookies, and lawful basis with counsel. Playback telemetry must not become a covert behavioral profile.
