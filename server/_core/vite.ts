import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import http from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

// Forward the Flask backend (movie pipeline) API through this server so the
// browser only ever talks to one origin. The Manus dev server replaces the
// Vite `server.proxy` block, so the proxy lives here at the express layer.
const MOVIE_BACKEND = process.env.MOVIE_BACKEND_URL ?? "http://localhost:5000";

function proxyMovieApi(
  req: express.Request,
  res: express.Response,
  target: string
) {
  const url = new URL(target);
  const headers: Record<string, string | string[] | number | undefined> = {
    ...req.headers,
    host: url.host,
  };

  // Express already consumed the body via express.json(), so the request
  // stream is exhausted. Forward the parsed body explicitly instead of piping
  // (piping sends 0 bytes against the original content-length -> Flask hangs).
  let body: Buffer | null = null;
  const hasBody =
    typeof req.body === "object" &&
    req.body !== null &&
    Object.keys(req.body).length > 0;
  if (hasBody) {
    body = Buffer.from(JSON.stringify(req.body));
    headers["content-length"] = String(body.length);
  } else {
    delete headers["content-length"];
  }

  const proxyReq = http.request(
    {
      host: url.hostname,
      port: url.port || 80,
      path: req.originalUrl,
      method: req.method,
      headers,
      agent: false,
    },
    proxyRes => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", err => {
    res
      .status(502)
      .json({ error: `Movie backend unreachable: ${err.message}` });
  });
  if (body) proxyReq.write(body);
  proxyReq.end();
}

export async function setupVite(app: Express, server: Server) {
  // Route the movie pipeline API (anything under /api that isn't tRPC) to Flask.
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/trpc")) {
      return next();
    }
    proxyMovieApi(req, res, MOVIE_BACKEND);
  });

  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
