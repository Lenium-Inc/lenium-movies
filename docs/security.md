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
