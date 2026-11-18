/**
 * The Worker cannot simply call the account handler: it expects the `(req, res)`
 * pair Vercel supplies. These tests pin the translation, because getting it wrong
 * is invisible until a signed-in request hits production.
 */

import { describe, expect, it } from "vitest";

import type { HandlerRequest, HandlerResponse } from "../api/[...path]";
import { runNodeHandler, type NodeStyleHandler } from "./adapter";

function request(
  method: string,
  body?: string,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://streamvy.test/api/auth/me?x=1", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

describe("runNodeHandler", () => {
  it("passes the url, method, headers and raw body through", async () => {
    let seen: HandlerRequest | undefined;
    const handler: NodeStyleHandler = async (req, res) => {
      seen = req;
      res.status(200).json({ ok: true });
    };

    await runNodeHandler(
      request("POST", '{"email":"a@b.c"}', {
        "content-type": "application/json",
        authorization: "Bearer token",
      }),
      handler
    );

    expect(seen?.url).toBe("https://streamvy.test/api/auth/me?x=1");
    expect(seen?.method).toBe("POST");
    expect(seen?.headers?.authorization).toBe("Bearer token");
    expect(seen?.headers?.["content-type"]).toBe("application/json");
    // Raw text, not a parsed object: the handler's own bodyOf does the parsing.
    expect(seen?.body).toBe('{"email":"a@b.c"}');
  });

  it("does not read a body for GET", async () => {
    let seen: HandlerRequest | undefined;
    await runNodeHandler(request("GET"), async (req, res) => {
      seen = req;
      res.send("ok");
    });
    expect(seen?.body).toBeUndefined();
  });

  it("turns json() into a JSON response with the status", async () => {
    const response = await runNodeHandler(request("GET"), async (_req, res) => {
      res.status(401).json({ error: "Unauthorized" });
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8"
    );
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("serialises send() objects and keeps primitive strings raw", async () => {
    const asObject = await runNodeHandler(request("GET"), async (_req, res) => {
      res.send({ a: 1 });
    });
    expect(await asObject.text()).toBe('{"a":1}');

    const asText = await runNodeHandler(request("GET"), async (_req, res) => {
      res.send("hello");
    });
    expect(await asText.text()).toBe("hello");
  });

  it("repeats array headers instead of joining them", async () => {
    const response = await runNodeHandler(request("GET"), async (_req, res) => {
      res.setHeader("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.end();
    });

    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });

  it("returns an empty 200 for end() and strips the body for 204", async () => {
    const ended = await runNodeHandler(request("GET"), async (_req, res) => {
      res.end();
    });
    expect(ended.status).toBe(200);
    expect(await ended.text()).toBe("");

    const noContent = await runNodeHandler(
      request("OPTIONS"),
      async (_req, res) => {
        res.status(204).end();
      }
    );
    expect(noContent.status).toBe(204);
    expect(await noContent.text()).toBe("");
  });

  it("reports headersSent once the handler has replied", async () => {
    const states: boolean[] = [];
    const handler: NodeStyleHandler = async (_req, res) => {
      states.push(Boolean(res.headersSent));
      res.json({ ok: true });
      states.push(Boolean(res.headersSent));
    };

    await runNodeHandler(request("GET"), handler);
    expect(states).toEqual([false, true]);
  });
});
