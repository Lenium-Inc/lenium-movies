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

// Reverse proxy for the Flask movie backend.
//
// Request headers are forwarded verbatim and the response body is streamed
// rather than buffered. Both matter: forwarding `Authorization` is what makes
// /api/auth/* work same-origin at all, and `Range` is what makes video seeking
// work. Buffering the body with response.text() would pull entire movies into
// memory before the first byte reached the player.
async function proxyToFlask(req: express.Request, res: express.Response) {
  const upstream = process.env.FLASK_URL || "http://127.0.0.1:5000";
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

    // Copy status + headers, minus anything that fingerprints the stack or
    // conflicts with the body we stream straight through.
    const BLOCKED = new Set([
      "content-encoding",
      "transfer-encoding",
      "content-length",
      "server",
      "x-powered-by",
    ]);
    response.headers.forEach((value, key) => {
      if (!BLOCKED.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    res.status(response.status);

    if (!response.body) {
      res.end();
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
