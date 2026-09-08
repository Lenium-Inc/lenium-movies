"""Async Playwright crawler - maximum-velocity, headless page ingestion.

The crawler keeps DOM extraction cheap by dropping network traffic the page
never needs: images, media, fonts, and known ad/analytics hosts are aborted the
instant a request matches, so the main document and iframe payloads arrive fast.

Every crawl produces a deterministic `ScrapeResult`:

  - the primary <h1> heading
  - a raw innerText dump (truncated to `BODY_TEXT_LIMIT`)
  - every iframe `src`, routed to the trailer bucket when the host is
    youtube/youtu.be and to the stream bucket (Auto quality) otherwise

CLI:
    python crawler.py <url> [<url> ...] [--workers N]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from dataclasses import asdict, dataclass

from playwright.async_api import Route, async_playwright

BODY_TEXT_LIMIT = 3_000
ROUTE_PATTERN = "**/*"

DEFAULT_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

LAUNCH_ARGS = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
]

_BLOCKED_EXTENSION = re.compile(
    r"\.(?:png|jpe?g|gif|mp4|webm|mp3|ogg|wav|avi|mov|m4v|mkv|flv|woff2?|ttf)(?:$|[?#])",
    re.IGNORECASE,
)
_AD_TOKENS = re.compile(
    r"popunder|adsystem|analytics|doubleclick|googlesyndication|adservice|adserver|adframe",
    re.IGNORECASE,
)
_YOUTUBE = re.compile(r"youtube\.com|youtu\.be", re.IGNORECASE)

_HARVEST_JS = (
    "() => {"
    "  const h1 = document.querySelector('h1');"
    "  const body = document.body ? document.body.innerText : '';"
    "  const frames = Array.from(document.querySelectorAll('iframe'))"
    "    .map(f => f.getAttribute('src') || f.getAttribute('data-src'))"
    "    .filter(Boolean);"
    f"  return {{ title: h1 ? h1.innerText.trim() : '', body: body.slice(0, {BODY_TEXT_LIMIT}), iframes: frames }};"
    "}"
)

_BLANK_SRC = {"about:blank", "about:blank#blocked", "javascript:void(0)"}


def _should_block(url: str, resource_type: str) -> bool:
    if resource_type in {"image", "media", "font"}:
        return True
    return bool(_BLOCKED_EXTENSION.search(url) or _AD_TOKENS.search(url))


def _categorize_iframe(src: str) -> tuple[str, str] | None:
    clean = src.strip()
    if not clean or clean in _BLANK_SRC:
        return None
    if _YOUTUBE.search(clean):
        return "trailer", clean
    return "stream", clean


@dataclass
class ScrapeResult:
    url: str
    title: str
    body_text: str
    trailer_urls: list[str]
    stream_urls: list[str]
    blocked_requests: int = 0

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


async def crawl_url(
    url: str,
    *,
    headless: bool = True,
    timeout_ms: int = 30_000,
    user_agent: str = DEFAULT_UA,
) -> ScrapeResult:
    blocked: list[int] = [0]

    async def route_handler(route: Route) -> None:
        if _should_block(route.request.url, route.request.resource_type):
            blocked[0] += 1
            await route.abort()
        else:
            await route.continue_()

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=headless, args=LAUNCH_ARGS
        )
        context = await browser.new_context(
            user_agent=user_agent,
            locale="en-US",
            viewport={"width": 1280, "height": 720},
        )
        page = await context.new_page()
        await page.route(ROUTE_PATTERN, route_handler)

        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            first = await page.evaluate(_HARVEST_JS)
            await page.wait_for_timeout(250)
            second = await page.evaluate(_HARVEST_JS)
            fallback_title = await page.title()
        except Exception as error:  # noqa: BLE001 - surface as a crawl failure
            raise CrawlError(url, str(error)) from error
        finally:
            await browser.close()

    iframes: list[str] = []
    for harvest in (first, second):
        harvest = harvest or {}
        for frame in harvest.get("iframes") or []:
            if isinstance(frame, str) and frame.strip() not in iframes:
                iframes.append(frame.strip())

    trailer_urls: list[str] = []
    stream_urls: list[str] = []
    for frame in iframes:
        bucket = _categorize_iframe(frame)
        if bucket is None:
            continue
        if bucket[0] == "trailer":
            trailer_urls.append(bucket[1])
        else:
            stream_urls.append(bucket[1])

    title = (first or {}).get("title") or (second or {}).get("title") or fallback_title or url
    body_text = ((second or {}).get("body") or (first or {}).get("body") or "")[:BODY_TEXT_LIMIT]

    return ScrapeResult(
        url=url,
        title=title,
        body_text=body_text,
        trailer_urls=trailer_urls,
        stream_urls=stream_urls,
        blocked_requests=blocked[0],
    )


async def crawl_many(
    urls: list[str], *, workers: int = 8, **kwargs
) -> list[ScrapeResult]:
    semaphore = asyncio.Semaphore(max(1, workers))

    async def guarded(target: str) -> ScrapeResult:
        async with semaphore:
            return await crawl_url(target, **kwargs)

    return list(await asyncio.gather(*(guarded(target) for target in urls)))


class CrawlError(RuntimeError):
    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"crawl failed for {url!r}: {reason}")
        self.url = url
        self.reason = reason


def _main() -> int:
    parser = argparse.ArgumentParser(
        description="Headless, media-blocking crawler (Playwright async)."
    )
    parser.add_argument("urls", nargs="+", help="Page URL(s) to crawl.")
    parser.add_argument("--workers", type=int, default=8, help="Concurrent pages.")
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    args = parser.parse_args()

    results = asyncio.run(
        crawl_many(args.urls, workers=args.workers, timeout_ms=args.timeout_ms)
    )
    for result in results:
        print(result.to_json())
    return 0


if __name__ == "__main__":
    sys.exit(_main())