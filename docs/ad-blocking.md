# Lenflix Ad and Unwanted-Resource Blocking

## Purpose and limits

The engine protects the Lenflix experience from unwanted advertising and tracking in first-party surfaces and authorized playback environments. It must not bypass DRM, access controls, subscriptions, provider security, or contractual restrictions.

## Rule model

Rules are versioned records with type, pattern, resource type, action, scope, priority, allowlist relationship, enabled state, reason, and reviewer. Supported types include domain, URL pattern, script, iframe, tracker, telemetry, and cosmetic rules. Allowlist rules take precedence for essential application, authentication, analytics, captions, and playback resources.

## Evaluation flow

```text
resource request -> policy engine -> allow / block / sandbox -> load
```

The engine is intentionally modular. Rules are updated independently, validated before activation, and rolled back by version. It records aggregate blocked categories rather than full browsing histories or unnecessary personal data.

## Safety

Default rules must be conservative. A blocked resource must not break login, media manifests, subtitles, accessibility controls, or required analytics. Admins can inspect test traces and temporarily disable a rule with an audit reason.

## Audit remediation: enforcement boundary

The policy engine runs only on Lenflix-controlled HTML/resource requests and on explicitly authorized provider integrations that permit this behavior. It is not a general browser extension, network circumvention layer, DRM interceptor, or subscription bypass. Provider SDKs and protected media paths are governed by contract and are allowlisted by default unless the provider expressly permits resource filtering.

Every rule release runs a regression suite covering OAuth, CSS, JavaScript, analytics consent, manifests, segments, captions, audio tracks, accessibility controls, error reporting, and payment or partner flows where applicable. A blocked-resource metric includes rule ID, resource category, route class, and outcome, but not full URLs or user browsing history by default.
