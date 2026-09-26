import { describe, expect, it } from "vitest";
import {
  AbuseTracker,
  DEFAULT_TIERS,
  RateLimiter,
  classifyTier,
  honeypotValue,
  isHoneypotPath,
  type RateDecision,
} from "./rateLimit";

const SECOND = 1000;

describe("RateLimiter", () => {
  it("allows a burst up to the bucket depth", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < DEFAULT_TIERS.metadata.burst; i++) {
      const decision = limiter.check("metadata", "1.2.3.4");
      expect(decision.allowed).toBe(true);
    }
    expect(limiter.check("metadata", "1.2.3.4").limited).toBe(true);
  });

  it("refills over time", () => {
    const limiter = new RateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < DEFAULT_TIERS.resolver.burst; i++) {
      limiter.check("resolver", "a", t0);
    }
    expect(limiter.check("resolver", "a", t0).allowed).toBe(false);
    // One token costs 6s at the resolver rate.
    const after = limiter.check("resolver", "a", t0 + 6 * SECOND);
    expect(after.allowed).toBe(true);
  });

  it("fails open on metadata and closed on the resolver", () => {
    const open = new RateLimiter();
    for (let i = 0; i < 100; i++) open.check("metadata", "ip");
    expect(open.check("metadata", "ip").allowed).toBe(true);

    const closed = new RateLimiter();
    for (let i = 0; i < 100; i++) closed.check("resolver", "ip");
    expect(closed.check("resolver", "ip").allowed).toBe(false);
  });

  it("reports a usable Retry-After when refusing", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < DEFAULT_TIERS.resolver.burst; i++) {
      limiter.check("resolver", "a", 0);
    }
    const decision: RateDecision = limiter.check("resolver", "a", 0);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBeGreaterThan(0);
    expect(decision.reason).toBe("rate");
    expect(decision.remaining).toBe(0);
  });

  it("keeps clients independent", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < DEFAULT_TIERS.resolver.burst; i++) {
      limiter.check("resolver", "noisy");
    }
    expect(limiter.check("resolver", "noisy").allowed).toBe(false);
    expect(limiter.check("resolver", "quiet").allowed).toBe(true);
  });

  it("never refills past the burst ceiling", () => {
    // Measured on a fail-closed tier, where `allowed` actually means "served
    // from budget" rather than "served anyway".
    const strict = { metadata: { ratePerSec: 1, burst: 10, failOpen: false } };
    const limiter = new RateLimiter(strict);
    for (let i = 0; i < 50; i++) limiter.check("metadata", "a", 0);
    // A long idle period must not bank more than one burst.
    const t = 10_000_000;
    let served = 0;
    for (let i = 0; i < 40; i++) {
      if (limiter.check("metadata", "a", t).allowed) served += 1;
    }
    expect(served).toBe(strict.metadata.burst);
  });

  it("serves a fail-open client but keeps reporting it as over budget", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < DEFAULT_TIERS.metadata.burst + 20; i++) {
      limiter.check("metadata", "a", 0);
    }
    const decision = limiter.check("metadata", "a", 0);
    expect(decision.allowed).toBe(true);
    expect(decision.limited).toBe(true);
  });

  it("caps tracked clients so rotated addresses cannot exhaust memory", () => {
    const limiter = new RateLimiter(DEFAULT_TIERS, 50);
    for (let i = 0; i < 5_000; i++) limiter.check("metadata", `10.0.0.${i % 256}-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(50);
  });

  it("sweeps idle clients", () => {
    const limiter = new RateLimiter();
    limiter.check("metadata", "a", 0);
    expect(limiter.size).toBe(1);
    expect(limiter.sweep(10 * 60 * SECOND)).toBe(1);
    expect(limiter.size).toBe(0);
  });
});

describe("AbuseTracker", () => {
  it("does not block on a single honeypot hit", () => {
    const tracker = new AbuseTracker();
    expect(tracker.record("ip", "honeypot").blocked).toBe(false);
    expect(tracker.isBlocked("ip")).toEqual({ blocked: false });
  });

  it("never blocks on the honeypot alone, at any volume", () => {
    // The real hazard: an autofill extension or password manager fills hidden
    // fields on every page, so a viewer could accumulate this signal without
    // doing anything wrong. No number of honeypot hits may block on its own.
    const tracker = new AbuseTracker();
    let blocked = false;
    for (let i = 0; i < 500; i++) {
      blocked = tracker.record("ip", "honeypot").blocked || blocked;
    }
    expect(blocked).toBe(false);
    expect(tracker.isBlocked("ip")).toEqual({ blocked: false });
  });

  it("blocks when a honeypot hit is corroborated by real pressure", () => {
    const tracker = new AbuseTracker();
    for (let i = 0; i < 4; i++) tracker.record("ip", "honeypot");
    let blocked = false;
    for (let i = 0; i < 3; i++) {
      blocked = tracker.record("ip", "resolver-limit").blocked || blocked;
    }
    expect(blocked).toBe(true);
  });

  it("blocks only once combined evidence crosses the threshold", () => {
    const tracker = new AbuseTracker();
    const honeypots = [];
    for (let i = 0; i < 4; i++) honeypots.push(tracker.record("ip", "honeypot"));
    expect(honeypots.some(r => r.blocked)).toBe(false);

    // 4 from honeypots + 3 each from resolver pressure crosses 10 on the
    // second resolver signal. The score resets when a block is issued, so the
    // crossing is detected across the run rather than on the final call.
    const pressure = [];
    for (let i = 0; i < 3; i++) pressure.push(tracker.record("ip", "resolver-limit"));
    expect(pressure.some(r => r.blocked)).toBe(true);
  });

  it("counts resolver pressure far heavier than a honeypot", () => {
    const a = new AbuseTracker();
    const b = new AbuseTracker();
    a.record("ip", "honeypot");
    const honeypotScore = a.record("ip", "honeypot").score;
    b.record("ip", "resolver-limit");
    const resolverScore = b.record("ip", "resolver-limit").score;
    expect(resolverScore).toBeGreaterThan(honeypotScore);
  });

  it("escalates the penalty on repeat offences", () => {
    // Two signal types, so the corroboration rule is satisfied each round.
    const tracker = new AbuseTracker();
    const penalties: number[] = [];
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 4; i++) {
        tracker.record("ip", "honeypot");
        const r = tracker.record("ip", "resolver-limit");
        if (r.blocked) penalties.push(r.retryAfterSec);
      }
    }
    expect(penalties.length).toBeGreaterThan(1);
    // Non-decreasing, and never permanent: the ladder tops out at one hour.
    for (let i = 1; i < penalties.length; i++) {
      expect(penalties[i]).toBeGreaterThanOrEqual(penalties[i - 1]);
    }
    expect(penalties[0]).toBeLessThan(penalties[penalties.length - 1]);
    expect(Math.max(...penalties)).toBeLessThanOrEqual(3600);
  });

  it("resets the corroboration record after a block", () => {
    const tracker = new AbuseTracker();
    for (let i = 0; i < 4; i++) tracker.record("ip", "honeypot");
    for (let i = 0; i < 2; i++) tracker.record("ip", "resolver-limit");
    expect(tracker.isBlocked("ip").blocked).toBe(true);
    // The old evidence must not carry over into the next window.
    tracker.isBlocked("ip", Date.now() + 3_600_000);
    let blocked = false;
    for (let i = 0; i < 6; i++) {
      blocked = tracker.record("ip", "resolver-limit").blocked || blocked;
    }
    expect(blocked).toBe(false);
  });

  it("reports a shrinking Retry-After while blocked", () => {
    const tracker = new AbuseTracker();
    for (let i = 0; i < 10; i++) tracker.record("ip", "honeypot");
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) tracker.record("ip", "resolver-limit", t0);
    const early = tracker.isBlocked("ip", t0 + SECOND);
    const later = tracker.isBlocked("ip", t0 + 30 * SECOND);
    expect(early.blocked).toBe(true);
    expect(later.blocked).toBe(true);
    if (early.blocked && later.blocked) {
      expect(later.retryAfterSec).toBeLessThan(early.retryAfterSec);
    }
  });

  it("never blocks permanently", () => {
    const tracker = new AbuseTracker();
    const t0 = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 10; i++) tracker.record("ip", "resolver-limit", t0 + round * 1000);
    }
    // A long quiet period must fully clear the client.
    expect(tracker.isBlocked("ip", t0 + 7 * 24 * 60 * 60 * SECOND)).toEqual({
      blocked: false,
    });
  });

  it("decays a score that is never acted on", () => {
    const tracker = new AbuseTracker();
    const t0 = 0;
    for (let i = 0; i < 9; i++) tracker.record("ip", "honeypot", t0);
    // Well past several decay windows, the same evidence no longer blocks.
    let blocked = false;
    for (let i = 0; i < 3; i++) {
      blocked = tracker.record("ip", "resolver-limit", t0 + 60 * 60 * SECOND).blocked;
    }
    expect(blocked).toBe(false);
  });

  it("caps tracked clients", () => {
    const tracker = new AbuseTracker(10, 40);
    for (let i = 0; i < 2_000; i++) tracker.record(`10.0.${i >> 8}.${i & 255}`, "honeypot");
    expect(tracker.size).toBeLessThanOrEqual(40);
  });
});

describe("classifyTier", () => {
  it("treats scraping endpoints as the resolver tier", () => {
    expect(classifyTier("/api/movies/resolve")).toBe("resolver");
    expect(classifyTier("/api/get-stream")).toBe("resolver");
    expect(classifyTier("/api/episodes")).toBe("resolver");
    expect(classifyTier("/api/movies/22980/resolve")).toBe("resolver");
  });

  it("treats catalogue reads as metadata", () => {
    expect(classifyTier("/api/catalog/discover")).toBe("metadata");
    expect(classifyTier("/api/trending")).toBe("metadata");
    expect(classifyTier("/api/search")).toBe("metadata");
    expect(classifyTier("/api/catalog")).toBe("metadata");
  });

  it("cannot be dodged with a query string or trailing slash", () => {
    expect(classifyTier("/api/movies/resolve/")).toBe("resolver");
    expect(classifyTier("/api/get-stream/")).toBe("resolver");
  });

  it("is not fooled by a similar prefix", () => {
    expect(classifyTier("/api/resolve-cache")).toBe("metadata");
    expect(classifyTier("/api/episodes-extra")).toBe("metadata");
  });
});

describe("honeypotValue", () => {
  it("detects a filled hidden field", () => {
    expect(honeypotValue({ website: "http://spam.example" })).toBeTruthy();
    expect(honeypotValue({ homepage: "x" })).toBeTruthy();
  });

  it("ignores an empty or absent field", () => {
    expect(honeypotValue({ website: "" })).toBeNull();
    expect(honeypotValue({ website: "   " })).toBeNull();
    expect(honeypotValue({ title: "Inception" })).toBeNull();
    expect(honeypotValue(null)).toBeNull();
    expect(honeypotValue("nope")).toBeNull();
  });
});

describe("classifyTier: auth", () => {
  it("treats credential endpoints as the strict auth tier", () => {
    expect(classifyTier("/auth/login")).toBe("auth");
    expect(classifyTier("/auth/signup")).toBe("auth");
    expect(classifyTier("/auth/password-reset")).toBe("auth");
    // Query strings and trailing slashes must not create a way around it.
    expect(classifyTier("/auth/login/")).toBe("auth");
    expect(classifyTier("/auth/login?next=%2Fhome")).toBe("auth");
  });

  it("leaves authenticated reads on the lenient metadata tier", () => {
    // These are session-gated rather than guessable, so the strict credential
    // budget would only get in a real user's way.
    expect(classifyTier("/auth/me")).toBe("metadata");
    expect(classifyTier("/auth/my-list")).toBe("metadata");
    expect(classifyTier("/auth/history")).toBe("metadata");
    expect(classifyTier("/auth/shares")).toBe("metadata");
    expect(classifyTier("/auth/shares/abc123/accept")).toBe("metadata");
  });

  it("cannot be dodged with a query string or fragment", () => {
    // Regression: the query string used to ride along in the final segment,
    // so /auth/login?x=1 missed the credential set and fell through to the
    // lenient tier -- a trivial bypass of the strict budget.
    expect(classifyTier("/auth/login?x=1")).toBe("auth");
    expect(classifyTier("/auth/login#frag")).toBe("auth");
    expect(classifyTier("/get-stream?tmdb_id=1")).toBe("resolver");
    expect(classifyTier("/catalog/discover?page=2")).toBe("metadata");
  });

  it("still prefers resolver over auth when a path could match either", () => {
    expect(classifyTier("/auth/resolve")).toBe("resolver");
  });

  it("configures the auth tier to fail closed on a small burst", () => {
    expect(DEFAULT_TIERS.auth.failOpen).toBe(false);
    expect(DEFAULT_TIERS.auth.burst).toBeLessThanOrEqual(10);
  });
});

describe("isHoneypotPath", () => {
  it("recognises the hidden link target", () => {
    expect(isHoneypotPath("/hp/asset-manifest.json")).toBe(true);
    expect(isHoneypotPath("/HP/asset-manifest.json")).toBe(true);
  });

  it("never mistakes a real route for the bait", () => {
    expect(isHoneypotPath("/catalog/discover")).toBe(false);
    expect(isHoneypotPath("/movies/resolve")).toBe(false);
    expect(isHoneypotPath("/")).toBe(false);
  });
});
