/**
 * Memory ceiling and socket lifecycle shared by every byte-moving route.
 *
 * The Render service this runs on is capped at 512 MB of RAM. Node's V8 heap is
 * only a slice of that -- the rest is the runtime, the undici socket pool,
 * Buffers held outside the JS heap, and the native side of `fetch`. The
 * remainder is the buffer between "GC has not run yet" and "the kernel has
 * already refused the allocation". Spending that buffer up front is how a
 * process gets OOM-killed at a load level it would otherwise have survived.
 *
 * So the budget is deliberately conservative: refuse new work at 420 MB of
 * *heapUsed*, which leaves 92 MB of headroom for the in-flight request, its
 * chunk buffers and the RSS that the heap number does not count. This is a
 * pressure valve, not a memory manager -- refusing a segment costs a 503 that
 * HLS.js retries, whereas being killed costs every concurrent viewer on the
 * instance.
 */

/**
 * 420 MB in bytes.
 *
 * 440401920 = 420 * 1024 * 1024. Written out rather than computed so the
 * number in the error contract cannot drift from the number in the comment
 * that documents why it is that number.
 */
export const HEAP_LIMIT_BYTES = 440_401_920;

/** Seconds the client is asked to wait before retrying a shed request. */
export const RETRY_AFTER_SECONDS = 10;

/** The exact body contract a shed request must return. */
export const MEMORY_GUARD_ERROR = {
  error: "Server under high load. Retrying shortly.",
  code: "RESOURCE_LIMIT_EXCEEDED",
} as const;

/**
 * Current V8 heap occupancy in bytes.
 *
 * `process.memoryUsage()` is a syscall-adjacent call on the V8 side, and it is
 * read once per request on a path where the alternative is holding the whole
 * payload. `heapUsed` rather than `rss` because the ceiling is enforced against
 * what JS is holding: `rss` on Node is sticky, so a single spike would keep a
 * healthy process shed for as long as the allocator kept the pages.
 */
export function heapUsedBytes(): number {
  return process.memoryUsage().heapUsed;
}

/** Whether the process is at or past its heap ceiling. */
export function isHeapOverBudget(): boolean {
  return heapUsedBytes() >= HEAP_LIMIT_BYTES;
}

function guardHeaders(): Record<string, string> {
  return {
    // The load shed is a scheduling decision, not a cacheable answer. `private`
    // keeps it off shared caches, which could otherwise pin a 503 in front of
    // every viewer for its default lifetime.
    "Cache-Control": "private, no-store",
    "Retry-After": String(RETRY_AFTER_SECONDS),
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * The 503 a shed request returns, or `null` when there is headroom.
 *
 * Returning the whole response rather than a boolean keeps the caller honest:
 * the only way to serve a request is to have already asked this, and there is
 * no branch in which the guard result is computed and then ignored.
 */
export function memoryGuardResponse(
  makeJson: (body: unknown, init: { status: number; headers: Record<string, string> }) => Response
): Response | null {
  if (!isHeapOverBudget()) return null;
  return makeJson(MEMORY_GUARD_ERROR, { status: 503, headers: guardHeaders() });
}

/**
 * An upstream request signal that dies with the caller.
 *
 * Two things have to end an upstream fetch, and neither is `AbortSignal.timeout`
 * on its own:
 *
 * * The deadline, or a stalled CDN pins a worker until the platform kills it.
 * * The *client* going away. Chrome aborts an in-flight `fetch` when a tab is
 *   closed, when a page is discarded under memory pressure, and when a fetch is
 *   cancelled by the player tearing down an `Hls` instance. That signal is not
 *   observable unless it is subscribed to explicitly, and without the
 *   subscription the upstream socket keeps pulling bytes for a viewer who is
 *   already gone -- the single largest source of avoidable memory pressure on
 *   this route, because the bytes still land in this process.
 *
 * The listeners are removed in `finally` rather than left to the abort event:
 * on the common path the request completes normally and the signal never fires,
 * so a subscription left attached is a retained closure on a long-lived object.
 */
export function upstreamSignal(
  clientSignal: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Upstream timeout")), timeoutMs);

  const onClientAbort = () => controller.abort(clientSignal.reason);
  // A client signal that is *already* aborted must fail the fetch, not be
  // subscribed to: adding a listener to it will never fire, so the upstream
  // request would run to completion for a caller that has already left.
  if (clientSignal.aborted) {
    controller.abort(clientSignal.reason);
  } else {
    clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }

  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      clientSignal.removeEventListener("abort", onClientAbort);
    },
  };
}

/**
 * A pass-through body that releases the upstream socket when the client leaves.
 *
 * The body is not buffered: one chunk is in flight at a time and the reader is
 * pulled only when the consumer pulls, so the downstream writer's backpressure
 * reaches the upstream reader instead of being absorbed into a growing array.
 *
 * Once the response headers are handed back there is no further chance to run
 * `abort` logic -- the fetch has resolved and its signal is out of scope -- so
 * without this the only way to learn that the tab closed is the write side
 * failing, which happens after undici has already buffered.
 */
export function cancelBodyOnAbort(
  body: ReadableStream<Uint8Array>,
  clientSignal: AbortSignal
): ReadableStream<Uint8Array> {
  if (clientSignal.aborted) {
    void body.cancel(new Error("Client disconnected")).catch(() => {});
    return body;
  }
  const reader = body.getReader();
  const onClientAbort = () => {
    // `cancel` closes the underlying socket; swallowing the rejection is correct
    // because the reader is already being torn down by the consumer too.
    void reader.cancel(new Error("Client disconnected")).catch(() => {});
  };
  clientSignal.addEventListener("abort", onClientAbort, { once: true });

  const detach = () => clientSignal.removeEventListener("abort", onClientAbort);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          detach();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        detach();
        controller.error(error);
      }
    },
    async cancel(reason) {
      detach();
      await reader.cancel(reason).catch(() => {});
    },
  });
}