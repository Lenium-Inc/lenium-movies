"""Runtime configuration: environment loading, secrets, and TLS.

Centralises three things that were previously duplicated across `app.py`,
`tmdb_service.py`, and `catalog_service.py`:

* dotenv loading, so a secret is read the same way regardless of import order
* the TMDB API key, which must come from the environment and nowhere else
* the TLS context, which must never silently disable certificate verification

The previous behaviour was: fall back to a key literal committed to the repo,
and fall back to `ssl._create_unverified_context()` when certifi could not be
loaded. Either one is a silent downgrade -- the first leaks a live credential,
the second leaks the credential it was protecting.
"""

from __future__ import annotations

import os
import ssl

import certifi

HERE = os.path.dirname(os.path.abspath(__file__))

_WARNED: set[str] = set()


def load_env_file() -> None:
    """Best-effort dotenv loader (root `./.env` + `movie-backend/.env`).

    Only fills keys that are NOT already in the environment, so injected values
    (Render, Neon CLI) always win. Neon's `neon link` writes values wrapped in
    double quotes; those are stripped here."""
    if os.environ.get("LENIUM_SKIP_ENV_FILE"):
        return
    for candidate in (
        os.path.join(HERE, ".env"),
        os.path.join(os.path.dirname(HERE), ".env"),
    ):
        try:
            with open(candidate, "r", encoding="utf-8") as handle:
                for raw in handle:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    if not key or key in os.environ:
                        continue
                    os.environ[key] = value.strip().strip('"').strip("'")
        except OSError:
            continue


load_env_file()


def require_secret(name: str) -> str | None:
    """Return an env secret, or None after warning exactly once.

    Deliberately does not raise: this process also serves auth and the local
    catalog, which keep working without a TMDB key. Callers degrade instead.
    """
    value = (os.environ.get(name) or "").strip()
    if value:
        return value
    if name not in _WARNED:
        _WARNED.add(name)
        print(
            f"[config] {name} is not set. TMDB lookups will be skipped. "
            f"Set it in the environment or in {os.path.join(os.path.dirname(HERE), '.env')}."
        )
    return None


def tmdb_api_key() -> str | None:
    return require_secret("TMDB_API_KEY")


_ssl_context_cache: ssl.SSLContext | None = None


def ssl_context() -> ssl.SSLContext:
    """A *verifying* TLS context, always.

    Prefers certifi's CA bundle. If that is unavailable -- the macOS LibreSSL
    case this originally worked around -- it falls back to the system trust
    store, which is still fully verified. It never falls back to
    `_create_unverified_context()`, which silently accepts any certificate and
    would expose the API key in transit.
    """
    global _ssl_context_cache
    if _ssl_context_cache is not None:
        return _ssl_context_cache
    try:
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001 - certifi missing/unreadable on this host
        ctx = ssl.create_default_context()
    _ssl_context_cache = ctx
    return ctx
