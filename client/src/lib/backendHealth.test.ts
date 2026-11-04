import { describe, expect, it } from "vitest";
import { isBackendHealthResponse } from "./backendHealth";

function response(
  body: string,
  options: { status?: number; contentType?: string } = {}
) {
  return new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "application/json" },
  });
}

describe("isBackendHealthResponse", () => {
  it("accepts the Flask backend health contract", async () => {
    await expect(
      isBackendHealthResponse(
        response(JSON.stringify({ service: "vy-backend", status: "online" }))
      )
    ).resolves.toBe(true);
  });

  it("rejects a 200 HTML SPA fallback", async () => {
    await expect(
      isBackendHealthResponse(
        response("<!doctype html><html><body>App</body></html>", {
          contentType: "text/html",
        })
      )
    ).resolves.toBe(false);
  });

  it("rejects non-healthy JSON and non-success statuses", async () => {
    await expect(
      isBackendHealthResponse(
        response(JSON.stringify({ service: "other", status: "online" }))
      )
    ).resolves.toBe(false);
    await expect(
      isBackendHealthResponse(
        response(JSON.stringify({ service: "vy-backend", status: "online" }), {
          status: 503,
        })
      )
    ).resolves.toBe(false);
  });
});
