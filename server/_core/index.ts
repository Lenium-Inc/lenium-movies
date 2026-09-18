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

// Simple fetch-based proxy for Flask movie backend
async function proxyToFlask(req: express.Request, res: express.Response) {
  const flaskUrl = `http://127.0.0.1:5000${req.originalUrl}`;
  console.log(`[Proxy] ${req.method} ${req.originalUrl} -> ${flaskUrl}`);

  try {
    const response = await fetch(flaskUrl, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        ...(req.headers["content-length"] && {
          "Content-Length": req.headers["content-length"],
        }),
      },
      body:
        req.method !== "GET" && req.method !== "HEAD"
          ? JSON.stringify(req.body)
          : undefined,
    });

    const data = await response.text();

    // Copy headers properly
    response.headers.forEach((value, key) => {
      if (
        key.toLowerCase() !== "content-encoding" &&
        key.toLowerCase() !== "transfer-encoding"
      ) {
        res.setHeader(key, value);
      }
    });

    res.status(response.status).send(data);
  } catch (err) {
    console.error("[Proxy Error]", err);
    if (!res.headersSent) {
      res.status(502).json({ error: "Movie backend unreachable" });
    }
  }
}

async function startServer() {
  const app = express();
  const server = createServer(app);
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
