import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/services/api";
import { isBackendHealthResponse } from "@/lib/backendHealth";

const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;

async function probe(): Promise<boolean> {
  try {
    const response = await fetch(apiUrl("/"), {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Vercel's SPA catch-all returns index.html with HTTP 200 for unknown paths.
    // Treating that as a healthy API hid a bad same-origin base URL until the
    // catalog JSON parser failed and the shelves appeared empty.
    return await isBackendHealthResponse(response);
  } catch {
    return false;
  }
}

export function useBackendOnline(): { online: boolean | null; recheck: () => void } {
  const [online, setOnline] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);

  const recheck = useCallback(() => setNonce(value => value + 1), []);

  useEffect(() => {
    if (import.meta.env.DEV) {
      setOnline(true);
      return;
    }

    let cancelled = false;

    const run = async () => {
      const ok = await probe();
      if (!cancelled) setOnline(ok);
    };

    void run();
    const id = window.setInterval(() => void run(), PROBE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [nonce]);

  return { online, recheck };
}
