/**
 * Single source of truth for legal-surface contact details.
 *
 * The DMCA page promises a contact channel, so this has to be a monitored
 * address -- an unmonitored one makes that promise worthless. Both `/terms`
 * and `/dmca` read from here, so it stays a one-line change.
 */
export const LEGAL_CONTACT_EMAIL = "vy.legal@protonmail.com";

/** Date the current version of the legal pages took effect. */
export const LEGAL_EFFECTIVE_DATE = "26 September 2026";
