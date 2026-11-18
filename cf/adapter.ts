/**
 * Runs a Vercel-style Node handler on Cloudflare Workers.
 *
 * `api/[...path].ts` is written against the `(req, res)` pair Vercel's Node
 * runtime provides: `req.url`, `req.method`, a plain header map and a `req.body`
 * that the platform has already read, plus `res.status/json/send/end/setHeader`.
 * A Worker receives a web `Request` and must return a web `Response`, so this
 * adapter presents the same Node-shaped surface and collects the handler's
 * output into a Response.
 *
 * The body is handed over as text rather than parsed JSON. The handler's own
 * `bodyOf` already accepts strings (and double-encoded strings), so keeping the
 * raw text avoids a second parse and preserves that legacy behaviour.
 */

import type { HandlerRequest, HandlerResponse } from "../api/[...path]";

export type NodeStyleHandler = (
  req: HandlerRequest,
  res: HandlerResponse
) => Promise<void>;

export async function runNodeHandler(
  request: Request,
  handler: NodeStyleHandler
): Promise<Response> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await request.text() : undefined;

  let status = 200;
  let sent = false;
  // Held as `unknown` and narrowed to BodyInit at the edge: the app's DOM lib
  // types reject Uint8Array<ArrayBufferLike> as BodyInit even though Workers
  // accept it.
  let payload: unknown = null;
  const responseHeaders = new Headers();

  const res: HandlerResponse = {
    status(code: number) {
      status = code;
      return res;
    },
    setHeader(name: string, value: string | string[]) {
      if (Array.isArray(value)) {
        // `Set-Cookie` is the one header that legitimately repeats.
        responseHeaders.delete(name);
        for (const item of value) responseHeaders.append(name, item);
        return;
      }
      responseHeaders.set(name, value);
    },
    json(value: unknown) {
      if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", "application/json; charset=utf-8");
      }
      payload = JSON.stringify(value);
      sent = true;
    },
    send(value?: unknown) {
      if (value === undefined || value === null) {
        payload = null;
      } else if (typeof value === "string") {
        payload = value;
      } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        payload = value;
      } else if (typeof value === "object") {
        payload = JSON.stringify(value);
      } else {
        payload = String(value);
      }
      sent = true;
    },
    end() {
      sent = true;
    },
    get headersSent() {
      return sent;
    },
  };

  await handler({ url: request.url, method, headers, body }, res);

  // 204 and 304 must not carry a body; the Response constructor rejects one.
  const bodyless = status === 204 || status === 304;
  return new Response(bodyless ? null : (payload as BodyInit | null), {
    status,
    headers: responseHeaders,
  });
}
