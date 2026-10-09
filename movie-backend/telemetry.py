"""Platform telemetry: connections, concurrent views, traffic, bandwidth.

Four numbers, all of them things an operator can act on:

- **active connections** -- requests currently inside a handler. A gauge, taken
  at `before_request`/`after_request`, so a stalled upstream shows up as a
  climbing gauge rather than a mystery.
- **concurrent stream views** -- playback sessions live right now, keyed by the
  handle that opened them. Idle sessions are pruned (a tab left open stops
  counting once it stops fetching), so the number answers "who is watching",
  not "who ever watched".
- **live traffic** -- requests and bytes in a rolling 60-second window. This is
  the only rate-shaped number here; totals alone cannot tell a busy minute
  from a quiet hour.
- **bandwidth consumed** -- bytes served since boot, total and per stream.

Scope, stated honestly: this is *per worker process*. gunicorn runs several
workers, the counters live in one interpreter's memory, and there is no shared
store between them -- so `snapshot()` reports its pid and uptime alongside the
numbers, and an operator reading a multi-worker deployment reads one worker's
truth. Aggregating across workers is a deployment-level concern (a metrics
scrape), not something to fake with a process-local guess.

Memory guard lives here too because it answers the same question -- "can this
process keep accepting work" -- and because every route that allocates bulk
memory (playback init, the proxies) already imports telemetry to record bytes.
"""

from __future__ import annotations

import os
import threading
import time

#: Seconds a stream view survives without fetching anything before it stops
#: counting as "being watched". Longer than any sane segment interval (HLS
#: targets 6s), short enough that a closed tab falls off the gauge quickly.
STREAM_IDLE_SECONDS = 180

#: Rolling window for rate-shaped numbers. One minute matches how operators
#: read traffic: "what is it doing *now*", not "what did it do since boot".
TRAFFIC_WINDOW_SECONDS = 60

#: Region table ceiling. The set of countries a service can be watched from is
#: bounded in practice; the cap exists so a forged `CF-IPCountry` cannot grow
#: the table without limit.
MAX_REGIONS = 256

#: Default memory ceiling. The deployment this runs on has 512 MB; the guard
#: trips before the kernel does, because an OOM kill loses the worker and every
#: request in flight, while a 503 is one honest, retryable answer.
DEFAULT_MEMORY_BUDGET_BYTES = 448 * 1024 * 1024


def memory_budget_bytes() -> int:
    raw = os.environ.get("MEMORY_GUARD_BYTES", "").strip()
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MEMORY_BUDGET_BYTES
    return value if value > 0 else DEFAULT_MEMORY_BUDGET_BYTES


def rss_bytes() -> int:
    """Current resident set size where the OS exposes it, else peak RSS.

    Linux reports live RSS through `/proc/self/statm`; elsewhere (the macOS dev
    box) the portable number is `ru_maxrss`, which is *peak* -- bytes on
    Darwin, kilobytes on Linux. The unit difference is handled by platform, and
    the caller is told which it got through `memory_snapshot()`'s `basis` field
    rather than being handed a number whose meaning silently changed.
    """
    try:
        with open("/proc/self/statm", "r", encoding="ascii") as handle:
            pages = int(handle.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, IndexError, ValueError):
        pass
    try:
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak if os.uname().sysname == "Darwin" else peak * 1024
    except Exception:  # noqa: BLE001 - a missing reading must not break a route
        return 0


class _Telemetry:
    """Mutable state. One instance, one lock: every number is cheap to take."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started_at = time.time()
        self._active_connections = 0
        self._requests_total = 0
        self._errors_4xx = 0
        self._errors_5xx = 0
        self._bytes_total = 0
        self._events_total = {
            "playback_init": 0,
            "manifest": 0,
            "segment": 0,
            "media": 0,
            "caption": 0,
            "frame": 0,
            "download": 0,
        }
        #: second -> [bytes, requests], pruned to the rolling window.
        self._window: dict[int, list[int]] = {}
        #: handle -> view record. Bounded by how many handles are live, which
        #: `playback_tokens` already caps; idle ones are pruned on touch/snapshot.
        self._streams: dict[str, dict] = {}
        self._opened_views = 0
        self._served_views = 0
        #: country -> [streams_opened, bytes]. Bounded by MAX_REGIONS.
        self._regions: dict[str, list[int]] = {}

    # -- connections ---------------------------------------------------------
    def begin_request(self) -> None:
        with self._lock:
            self._active_connections += 1
            self._requests_total += 1
            self._touch_window(time.time(), count=0, count_request=True)

    def end_request(self, status: int) -> None:
        with self._lock:
            self._active_connections = max(0, self._active_connections - 1)
            if 400 <= status < 500:
                self._errors_4xx += 1
            elif status >= 500:
                self._errors_5xx += 1

    # -- bytes & traffic -----------------------------------------------------
    def record_bytes(self, count: int, region: str | None = None) -> None:
        if count <= 0:
            return
        with self._lock:
            self._bytes_total += count
            self._touch_window(time.time(), count=count)
            if region:
                bucket = self._regions.get(region)
                if bucket is None:
                    if len(self._regions) >= MAX_REGIONS:
                        return
                    bucket = [0, 0]
                    self._regions[region] = bucket
                bucket[1] += count

    def record_event(self, name: str) -> None:
        with self._lock:
            if name in self._events_total:
                self._events_total[name] += 1

    def _touch_window(self, now: float, *, count: int, count_request: bool = False) -> None:
        """Prune the ring and fold this sample into the current second.

        Called with the lock held. The ring keeps one entry per second, so the
        window is bounded at TRAFFIC_WINDOW_SECONDS entries no matter the rate.
        A byte sample and a request sample are separate decisions: one
        redirected response can write several byte chunks, and folding each
        into the request counter would report traffic that never happened.
        """
        second = int(now)
        cutoff = second - TRAFFIC_WINDOW_SECONDS
        for key in [k for k in self._window if k <= cutoff]:
            self._window.pop(key, None)
        bucket = self._window.get(second)
        if bucket is None:
            self._window[second] = [count, 1 if count_request else 0]
            return
        bucket[0] += count
        if count_request:
            bucket[1] += 1

    # -- stream views --------------------------------------------------------
    def open_stream(
        self,
        handle: str,
        *,
        user_id=None,
        profile_id=None,
        region: str | None = None,
    ) -> None:
        now = time.time()
        with self._lock:
            self._prune_streams(now)
            self._streams[handle] = {
                "opened_at": now,
                "last_seen": now,
                "user_id": user_id,
                "profile_id": profile_id,
                "region": region or "",
                "bytes": 0,
            }
            self._opened_views += 1
            if region:
                bucket = self._regions.get(region)
                if bucket is None and len(self._regions) < MAX_REGIONS:
                    bucket = [0, 0]
                    self._regions[region] = bucket
                if bucket is not None:
                    bucket[0] += 1

    def touch_stream(self, handle: str, count: int = 0) -> None:
        now = time.time()
        with self._lock:
            record = self._streams.get(handle)
            if record is None:
                return
            record["last_seen"] = now
            if count > 0:
                record["bytes"] += count

    def close_stream(self, handle: str) -> None:
        with self._lock:
            if self._streams.pop(handle, None) is not None:
                self._served_views += 1

    def _prune_streams(self, now: float) -> None:
        cutoff = now - STREAM_IDLE_SECONDS
        for handle in [h for h, r in self._streams.items() if r["last_seen"] < cutoff]:
            self._streams.pop(handle, None)

    # -- reads ---------------------------------------------------------------
    def snapshot(self) -> dict:
        now = time.time()
        with self._lock:
            self._prune_streams(now)
            window_bytes = 0
            window_requests = 0
            for bucket in self._window.values():
                window_bytes += bucket[0]
                window_requests += bucket[1]
            per_user: dict = {}
            for record in self._streams.values():
                user = record["user_id"]
                if user is None:
                    continue
                key = str(user)
                entry = per_user.setdefault(key, {"streams": 0, "bytes": 0})
                entry["streams"] += 1
                entry["bytes"] += record["bytes"]
            return {
                "scope": {
                    "pid": os.getpid(),
                    "uptime_seconds": round(now - self._started_at, 1),
                },
                "connections": {
                    "active": self._active_connections,
                    "requests_total": self._requests_total,
                    "errors_4xx": self._errors_4xx,
                    "errors_5xx": self._errors_5xx,
                },
                "streams": {
                    "active": len(self._streams),
                    "opened_total": self._opened_views,
                    "completed_total": self._served_views,
                    "by_user": per_user,
                },
                "traffic": {
                    "bytes_total": self._bytes_total,
                    "bytes_last_minute": window_bytes,
                    "requests_last_minute": window_requests,
                    "bytes_per_second": round(window_bytes / TRAFFIC_WINDOW_SECONDS, 1),
                },
                "events": dict(self._events_total),
                "regional": sorted(
                    (
                        {
                            "country": country or "unknown",
                            "views_opened": bucket[0],
                            "bytes": bucket[1],
                        }
                        for country, bucket in self._regions.items()
                    ),
                    key=lambda item: (-item["bytes"], item["country"]),
                ),
            }


TELEMETRY = _Telemetry()

#: Thin module-level shims so call sites read as prose (`telemetry.record_bytes`)
#: instead of reaching into an instance.
begin_request = TELEMETRY.begin_request
end_request = TELEMETRY.end_request
record_bytes = TELEMETRY.record_bytes
record_event = TELEMETRY.record_event
open_stream = TELEMETRY.open_stream
touch_stream = TELEMETRY.touch_stream
close_stream = TELEMETRY.close_stream


def memory_snapshot() -> dict:
    used = rss_bytes()
    budget = memory_budget_bytes()
    return {
        "rss_bytes": used,
        "budget_bytes": budget,
        "over_budget": bool(used) and used >= budget,
        "basis": "current" if os.path.exists("/proc/self/statm") else "peak",
    }


def over_budget() -> bool:
    """True when this worker must stop accepting bulk work.

    A zero reading means the OS would not tell us -- in which case the guard
    stays open rather than refusing service on a guess.
    """
    return memory_snapshot()["over_budget"]


def snapshot() -> dict:
    payload = TELEMETRY.snapshot()
    payload["memory"] = memory_snapshot()
    return payload
