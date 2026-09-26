import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import {
  AbuseTracker,
  RateLimiter,
  DEFAULT_TIERS,
  classifyTier,
  honeypotValue,
  isHoneypotPath,
  type Tier,
} from "./rateLimit";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * Remove the upstream address from a body. Returns the input unchanged when
 * there is nothing to redact, so the caller can tell whether a generic
 * response is needed.
 */
function sanitizeUpstream(body: string, upstreamHost: string): string {
  let out = body;
  for (const secret of [upstreamHost, process.env.FLASK_URL ?? ""]) {
    if (secret) out = out.split(secret).join("[upstream]");
  }
  // Bare host:port, which survives even when the scheme was already stripped.
  out = out.replace(/(127\.0\.0\.1|localhost|0\.0\.0\.0):\d{2,5}/g, "[upstream]");
  return out;
}

// ---------------------------------------------------------------------------
// Abuse controls
// ---------------------------------------------------------------------------

const limiter = new RateLimiter();
const abuse = new AbuseTracker();

/**
 * How many proxy hops sit in front of this app. Express only reads
 * `X-Forwarded-For` as far as it is told to, and the difference matters: set
 * this too high and a client can spoof its address and get a fresh budget per
 * request, which defeats the limiter entirely. Set it to the real hop count
 * (1 for a single load balancer, 0 when running directly). Overridable because
 * deployments differ, and a wrong default here silently weakens the control.
 */
const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10);

/**
 * Identify the client for budgeting purposes.
 *
 * `req.ip` is used rather than a hand-rolled `X-Forwarded-For` read so that
 * Express's `trust proxy` setting is the single place that decides how much of
 * the header chain to believe.
 */
function clientKey(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function tierSignal(tier: Tier): "metadata-limit" | "resolver-limit" {
  return tier === "resolver" ? "resolver-limit" : "metadata-limit";
}

/** Counters make the limiter observable; a limiter you cannot see is
 * indistinguishable from a broken backend. */
const stats = { limited: 0, blocked: 0, honeypot: 0 };

/**
 * Gate every /api request before it reaches either the tRPC router or the
 * Flask proxy, since both can be expensive and both are publicly reachable.
 */
function apiGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = clientKey(req);
  const tier = classifyTier(req.path);

  // Two flavours of one weak signal: a hidden form field that got filled, or a
  // crawler that followed the hidden link. Both are weak evidence on their own,
  // because password managers and download extensions fill hidden fields by
  // accident. Each only nudges a decaying score, and neither can block alone.
  const baitField = honeypotValue(req.body) ?? honeypotValue(req.query);
  const baitLink = isHoneypotPath(req.path);
  if (baitField !== null || baitLink) {
    stats.honeypot += 1;
    const outcome = abuse.record(key, "honeypot");
    console.warn(
      `[abuse] honeypot ${baitLink ? "followed" : "filled"} ` +
        `ip=${key} path=${req.path} score=${outcome.score.toFixed(1)}`
    );
  }

  // A scored block withholds the expensive endpoints only. Extending it to
  // metadata would punish everyone sharing the egress address -- one abuser
  // behind a corporate NAT would take an entire office off the catalogue --
  // and it would break the promise that browsing never goes dark. The scraper
  // still loses the thing worth protecting: the scrape budget.
  const block = abuse.isBlocked(key);
  if (block.blocked) {
    stats.blocked += 1;
    if (tier === "resolver") {
      res.setHeader("Retry-After", String(block.retryAfterSec));
      res.status(429).json({ error: "Too many requests. Please try again shortly." });
      return;
    }
    console.warn(
      `[abuse] blocked client still browsing catalogue ip=${key} path=${req.path} (allowed)`
    );
  }

  const decision = limiter.check(tier, key);
  if (decision.limited) {
    stats.limited += 1;
    const outcome = abuse.record(key, tierSignal(tier));
    console.warn(
      `[abuse] ${tier} over budget ip=${key} path=${req.path} ` +
        `retry_after=${decision.retryAfterSec}s served=${decision.allowed} ` +
        `score=${outcome.score.toFixed(1)}${outcome.blocked ? " BLOCKED" : ""}`
    );
  }

  if (!decision.allowed) {
    res.setHeader("Retry-After", String(decision.retryAfterSec));
    res.status(429).json({
      error: "Too many requests. Please try again shortly.",
    });
    return;
  }

  // Read the burst from the live config so the advertised header can never
  // drift away from the budget actually being enforced.
  res.setHeader("X-RateLimit-Limit", String(DEFAULT_TIERS[tier].burst));
  res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  next();
}

// Housekeeping. Cheap, and it keeps the in-process maps from growing without
// bound between sweeps. Counters are reported here rather than on a private
// endpoint: a rate limiter you cannot see is indistinguishable from a broken
// backend, and an open /metrics route is one more thing to attack.
let lastReported = { ...stats };
const sweepTimer = setInterval(() => {
  const removed = limiter.sweep() + abuse.sweep();
  const delta = {
    limited: stats.limited - lastReported.limited,
    blocked: stats.blocked - lastReported.blocked,
    honeypot: stats.honeypot - lastReported.honeypot,
  };
  lastReported = { ...stats };
  if (removed > 0 || delta.limited > 0 || delta.blocked > 0 || delta.honeypot > 0) {
    console.log(
      `[abuse] last 60s limited=${delta.limited} blocked=${delta.blocked} ` +
        `honeypot=${delta.honeypot} swept=${removed} ` +
        `tracked=${limiter.size + abuse.size}`
    );
  }
}, 60_000);
sweepTimer.unref?.();

// Reverse proxy for the Flask movie backend.
//
// Request headers are forwarded verbatim and the response body is streamed
// rather than buffered. Both matter: forwarding `Authorization` is what makes
// /api/auth/* work same-origin at all, and `Range` is what makes video seeking
// work. Buffering the body with response.text() would pull entire movies into
// memory before the first byte reached the player.
async function proxyToFlask(req: express.Request, res: express.Response) {
  const upstream = process.env.FLASK_URL || "http://127.0.0.1:5000";
  const upstreamHost = (() => {
    try {
      return new URL(upstream).host;
    } catch {
      return upstream;
    }
  })();
  const flaskUrl = `${upstream}${req.originalUrl}`;

  // Hop-by-hop headers must not be forwarded; everything else (auth, range,
  // accept, if-none-match) is passed through as-is.
  const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
  ]);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }

  // The body was already parsed by express.json(); re-serialize it. A request
  // with no parsed body (e.g. a ranged GET) is forwarded without one.
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const serialized = hasBody ? JSON.stringify(req.body ?? {}) : undefined;
  if (serialized !== undefined) {
    if (!headers["content-type"]) headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(serialized));
  }

  try {
    const response = await fetch(flaskUrl, {
      method: req.method,
      headers,
      body: serialized,
    });

    // Copy status + headers, minus anything that fingerprints the stack,
    // names an internal hop, or conflicts with the body we stream through.
    const BLOCKED = new Set([
      "content-encoding",
      "transfer-encoding",
      "content-length",
      "server",
      "x-powered-by",
      "via",
      "x-upstream",
      "x-upstream-url",
      "x-backend",
      "x-served-by",
      "x-request-id",
    ]);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (BLOCKED.has(lower)) return;
      // Defence in depth: a header that quotes the upstream address is an
      // internal detail regardless of its name.
      if (value.toLowerCase().includes(upstreamHost)) return;
      res.setHeader(key, value);
    });

    res.status(response.status);

    if (!response.body) {
      res.end();
      return;
    }

    // An error body is a Flask traceback, and a traceback names the upstream
    // host, the port and internal route names. Buffer just these; successful
    // media responses must keep streaming so Range and seeking still work.
    if (response.status >= 400) {
      const raw = await response.text();
      const sanitized = sanitizeUpstream(raw, upstreamHost);
      const body =
        sanitized === raw
          ? raw
          : JSON.stringify({ error: "The movie backend could not fulfil this request." });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Length", String(Buffer.byteLength(body)));
      res.end(body);
      return;
    }

    // Pipe without buffering. Backpressure propagates through the transform.
    const reader = response.body.getReader();
    req.on("close", () => {
      void reader.cancel().catch(() => {});
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>(resolve => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    console.error("[Proxy Error]", err);
    if (!res.headersSent) {
      res.status(502).json({ error: "Movie backend unreachable" });
    } else {
      res.end();
    }
  }
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Stop advertising the stack. `Server` is set by the WSGI layer, not
  // Express, so it has to be deleted in middleware before anything writes it.
  app.disable("x-powered-by");

  // Must be set before any middleware reads req.ip. See TRUST_PROXY_HOPS.
  app.set("trust proxy", Number.isFinite(TRUST_PROXY_HOPS) ? TRUST_PROXY_HOPS : 1);

  app.use((_req, res, next) => {
    res.removeHeader("X-Powered-By");
    res.removeHeader("Server");
    res.removeHeader("X-AspNet-Version");
    next();
  });

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // Rate limit and score every /api request. Placed after the body parsers so
  // the honeypot field can be read, and before both the tRPC router and the
  // Flask proxy so nothing expensive is reachable without a budget.
  app.use("/api", apiGuard);

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Proxy /api/* (except /api/trpc) to Flask movie backend on port 5000
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/trpc")) {
      return next();
    }
    proxyToFlask(req, res);
  });

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  server.listen(port, () => {});
}

startServer().catch(console.error);
