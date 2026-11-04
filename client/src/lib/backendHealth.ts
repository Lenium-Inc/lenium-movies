/**
 * The backend health route returns JSON. A generic HTTP 200 is insufficient on
 * Vercel because unknown paths fall back to the SPA's HTML shell.
 */
export async function isBackendHealthResponse(response: Response): Promise<boolean> {
  if (!response.ok) return false;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return false;

  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) return false;
    const health = payload as Record<string, unknown>;
    return health.service === "vy-backend" && health.status === "online";
  } catch {
    return false;
  }
}
