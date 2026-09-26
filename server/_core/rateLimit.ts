/**
 * Tiered rate limiting and abuse scoring for the public API.
 *
 * Why tiers: the endpoints behind this app differ by orders of magnitude in
 * what they cost upstream. Reading TMDB metadata is a cheap, cacheable call.
 * Resolving a stream makes the backend scrape a provider, which spends real
 * budget and risks an IP-level ban from TMDB for the whole deployment. One
 * uniform limit either lets a scraper drain the budget through cheap endpoints
 * or locks real users out of browsing, so the two are budgeted separately.
 *
 * Deliberate non-goals, because each of these backfires:
 *
 * - No permanent IP bans. They are trivially weaponised to lock out a
 *   competitor's address range, and they outlive the behaviour that caused them.
 * - No bot fingerprinting from request headers. Spoofed in one line, and it
 *   blocks real people behind privacy browsers and extensions.
 * - No instant punishment for the honeypot. Crawlers, password managers and
 *   image-download extensions fill hidden fields by accident, so a honeypot hit
 *   is weak evidence and only ever contributes to a decaying score.
 *
 * State is in-process. Behind more than one replica the effective limit is the
 * per-replica limit times the replica count; a shared store is required to make
 * the budget global.
 */

/** A request cost class. */
export type Tier = "metadata" | "resolver" | "auth";

export interface TierConfig {
  /** Sustained refill rate in tokens per second. */
  ratePerSec: number;
  /** Bucket depth, i.e. how large a burst is tolerated. */
  burst: number;
  /**
   * When over budget, serve the request anyway. Used for metadata so a bug or
   * a clock skew can never take the catalogue offline; the resolver tier is
   * fail-closed because every request there costs upstream budget.
   */
  failOpen: boolean;
}

export const DEFAULT_TIERS: Record<Tier, TierConfig> = {
  // 60 burst, sustained ~1/s. Generous: browsing a catalogue legitimately
  // pages through dozens of these.
  metadata: { ratePerSec: 1, burst: 60, failOpen: true },
  // 10 burst, sustained ~1 per 6s. These trigger a scrape each.
  resolver: { ratePerSec: 1 / 6, burst: 10, failOpen: false },
  // Credential endpoints. 5 burst, sustained ~1 per 5s, and fail-closed.
  // These are the one place where being generous is a security hole rather
  // than a nicety: an unlimited login endpoint is a free credential-stuffing
  // oracle, and it is the cheapest possible way to enumerate valid accounts.
  auth: { ratePerSec: 0.2, burst: 5, failOpen: false },
};

/**
 * Flat rather than a union: a fail-open tier reports `allowed: true` *and*
 * `limited: true`, which a discriminated union cannot express without making
 * `remaining` unreadable.
 */
export interface RateDecision {
  /** Whether the request is served. False only when the tier fails closed. */
  allowed: boolean;
  /** True when the client was over budget, even if it was served anyway. */
  limited: boolean;
  /** Tokens remaining, counted only when the request consumed one. */
  remaining: number;
  retryAfterSec: number;
  tier: Tier;
  reason: "ok" | "rate";
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private tiers: Record<Tier, TierConfig>;

  constructor(
    /** Partial so a single tier can be retuned, or a test exercised, alone. */
    tiers: Partial<Record<Tier, TierConfig>> = {},
    /**
     * Hard cap on tracked clients. Without it, an attacker rotating forwarded
     * addresses grows this map without bound and turns the limiter itself into
     * a memory-exhaustion vector.
     */
    private maxKeys = 50_000,
  ) {
    this.tiers = { ...DEFAULT_TIERS, ...tiers };
  }

  check(tier: Tier, key: string, now: number = Date.now()): RateDecision {
    const config = this.tiers[tier];
    const bucket = this.refill(key, config, now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return {
        allowed: true,
        limited: false,
        remaining: Math.floor(bucket.tokens),
        retryAfterSec: 0,
        tier,
        reason: "ok",
      };
    }

    const deficit = 1 - bucket.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(deficit / config.ratePerSec));
    this.buckets.set(key, bucket);

    return {
      // A fail-open tier still records that the client is over budget; the
      // caller logs it either way.
      allowed: config.failOpen,
      limited: true,
      remaining: 0,
      retryAfterSec,
      tier,
      reason: "rate",
    };
  }

  private refill(key: string, config: TierConfig, now: number): Bucket {
    const existing = this.buckets.get(key);
    if (!existing) {
      const fresh: Bucket = { tokens: config.burst, updatedAt: now };
      this.evictIfFull(now);
      this.buckets.set(key, fresh);
      return fresh;
    }
    const elapsedSec = Math.max(0, (now - existing.updatedAt) / 1000);
    existing.tokens = Math.min(
      config.burst,
      existing.tokens + elapsedSec * config.ratePerSec,
    );
    existing.updatedAt = now;
    return existing;
  }

  /** Drop expired clients, then the least recently seen ones if still full. */
  private evictIfFull(now: number) {
    if (this.buckets.size < this.maxKeys) return;
    this.sweep(now);
    if (this.buckets.size < this.maxKeys) return;
    const excess = this.buckets.size - this.maxKeys + 1;
    const oldest = Array.from(this.buckets.entries())
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, excess);
    for (const [key] of oldest) this.buckets.delete(key);
  }

  /** Drop clients idle long enough to have refilled completely. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    const idleMs =
      Math.max(...Object.values(this.tiers).map(t => (t.burst / t.ratePerSec) * 1000)) || 0;
    for (const [key, bucket] of Array.from(this.buckets)) {
      if (now - bucket.updatedAt > idleMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/** Behavioural evidence that a client is scraping rather than browsing. */
export type AbuseSignal =
  | "honeypot"
  | "metadata-limit"
  | "resolver-limit"
  | "auth-limit";

/**
 * Weighted low. A hidden field is filled in by crawlers, password managers and
 * download extensions, so this must never on its own exceed the block threshold
 * -- it is a nudge toward suspicion, not a verdict.
 */
const SIGNAL_WEIGHT: Record<AbuseSignal, number> = {
  honeypot: 1,
  "metadata-limit": 1,
  "resolver-limit": 3,
  "auth-limit": 3,
};

/**
 * Where the hidden honeypot link points. A bot that treats a page as a link
 * graph to walk will follow it; a person cannot reach it, because the link is
 * aria-hidden, off-screen and `pointer-events: none`.
 */
const HONEYPOT_PATH_MARKER = "/hp/";

export function isHoneypotPath(pathname: string): boolean {
  return pathname.toLowerCase().includes(HONEYPOT_PATH_MARKER);
}

const BLOCK_THRESHOLD = 10;

/** Score halves this often, so a burst of scraping is forgotten over time. */
const SCORE_DECAY_MS = 10 * 60_000;

/** Escalating penalties, in seconds. Never permanent. */
const PENALTIES_SEC = [60, 300, 900, 3600];

interface Client {
  score: number;
  updatedAt: number;
  strikes: number;
  blockedUntil: number;
  /** Which signal types this client has actually tripped. */
  seen: Set<AbuseSignal>;
}

export type BlockState = { blocked: true; retryAfterSec: number } | { blocked: false };

export class AbuseTracker {
  private clients = new Map<string, Client>();

  constructor(
    private threshold = BLOCK_THRESHOLD,
    private maxKeys = 50_000,
  ) {}

  private decay(client: Client, now: number): Client {
    const steps = Math.floor((now - client.updatedAt) / SCORE_DECAY_MS);
    if (steps > 0) {
      client.score = client.score / Math.pow(2, steps);
      client.updatedAt += steps * SCORE_DECAY_MS;
    }
    return client;
  }

  private client(key: string, now: number): Client {
    let client = this.clients.get(key);
    if (!client) {
      if (this.clients.size >= this.maxKeys) this.sweep(now);
      if (this.clients.size >= this.maxKeys) {
        const oldest = Array.from(this.clients.entries()).sort(
          (a, b) => a[1].updatedAt - b[1].updatedAt,
        )[0];
        if (oldest) this.clients.delete(oldest[0]);
      }
      client = {
        score: 0,
        updatedAt: now,
        strikes: 0,
        blockedUntil: 0,
        seen: new Set<AbuseSignal>(),
      };
      this.clients.set(key, client);
    }
    return this.decay(client, now);
  }

  isBlocked(key: string, now: number = Date.now()): BlockState {
    const client = this.clients.get(key);
    if (!client) return { blocked: false };
    this.decay(client, now);
    if (client.blockedUntil > now) {
      return { blocked: true, retryAfterSec: Math.ceil((client.blockedUntil - now) / 1000) };
    }
    return { blocked: false };
  }

  /** Add evidence and report whether the client is now over the threshold. */
  record(
    key: string,
    signal: AbuseSignal,
    now: number = Date.now(),
  ): { score: number; blocked: boolean; retryAfterSec: number } {
    const client = this.client(key, now);
    client.score += SIGNAL_WEIGHT[signal];
    client.seen.add(signal);

    // The honeypot is corroboration, never a verdict. Without this, a low
    // weight is no protection at all: any single signal type eventually
    // crosses any threshold, so a password manager that fills hidden fields
    // would get a real viewer throttled on playback.
    const corroborated = client.seen.size > 1;
    if (client.score < this.threshold || !corroborated) {
      return { score: client.score, blocked: false, retryAfterSec: 0 };
    }

    const penalty = PENALTIES_SEC[Math.min(client.strikes, PENALTIES_SEC.length - 1)];
    client.strikes += 1;
    client.blockedUntil = now + penalty * 1000;
    // Reset the score and the corroboration record so the next crossing has
    // to be earned again rather than inherited.
    client.score = 0;
    client.seen.clear();
    return { score: this.threshold, blocked: true, retryAfterSec: penalty };
  }

  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, client] of Array.from(this.clients)) {
      this.decay(client, now);
      if (client.blockedUntil <= now && client.score < 0.5) {
        this.clients.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.clients.size;
  }

  reset(): void {
    this.clients.clear();
  }
}

/**
 * Requests that make the backend scrape a provider. Keyed on the final path
 * segment so query strings and trailing slashes do not create a way around it.
 */
const RESOLVER_PATHS = new Set([
  "resolve",
  "get-stream",
  "episodes",
  "stream",
  "source",
]);

/**
 * Credential endpoints. Matched on the final segment so that authenticated
 * reads living under the same /api/auth prefix -- /me, /my-list, /history, and
 * the share endpoints -- stay on the lenient metadata tier. Only the endpoints
 * that accept or check a password are treated as expensive, because only those
 * are worth attacking in bulk.
 */
const AUTH_PATHS = new Set([
  "login",
  "signup",
  "register",
  "signin",
  "sign-up",
  "password",
  "password-reset",
  "reset-password",
  "forgot-password",
]);

export function classifyTier(pathname: string): Tier {
  // Strip the query and fragment first. Without this, /auth/login?x=1 keeps
  // "login?x=1" as its final segment, misses the credential set entirely and
  // lands on the lenient tier -- so appending a query string to a protected
  // endpoint would be a complete bypass of its budget.
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1]?.toLowerCase() ?? "";
  if (RESOLVER_PATHS.has(last)) return "resolver";
  if (AUTH_PATHS.has(last)) return "auth";
  // A resolve nested under a title, e.g. /api/movies/22980/resolve.
  if (segments.some(s => RESOLVER_PATHS.has(s.toLowerCase()))) return "resolver";
  return "metadata";
}

/**
 * Field names a naive form-filling bot populates but a person cannot see.
 * Deliberately generic, because that is what makes them work as a signal.
 */
const HONEYPOT_FIELDS = [
  "website",
  "homepage",
  "company_website",
  "leave_blank",
  "fax_number",
];

export function honeypotValue(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  for (const field of HONEYPOT_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
