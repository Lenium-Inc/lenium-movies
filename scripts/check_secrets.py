#!/usr/bin/env python3
"""Block commits of credential-shaped literals.

Scope is deliberately narrow, because a guard that cries wolf gets disabled.
Three rules, in descending confidence:

  1. vendor prefixes that are unambiguously credentials (sk_live_, ghp_, AKIA...)
  2. PEM private key blocks
  3. an env-style credential identifier assigned a literal that does not look
     like a readable slug

Rule 3 is the one that catches a leaked key like the TMDB one this replaced. It
requires BOTH a credential-shaped name (TMDB_API_KEY, apiKey, DB_PASSWORD --
but not a bare `KEY`, which in this repo is a localStorage key *name*) AND a
value with digits in it, which separates `100868d1fc...` from
`lenium_auth_token`.

A generic entropy scan was tried first and rejected: this repo is full of long
URLs, ISO timestamps, and archive.org identifiers, all of which score as
"high entropy" and made the check unusable.

Known limit: rule 3 requires a digit in the value, so an all-lowercase
dictionary word (`password: "correcthorsebatterystaple"`) is not flagged. That
is deliberate -- the digit requirement is what separates a real key from
`lenium_auth_token` -- and such a password is a weak-password problem rather
than a leaked-credential one.

Usage:  scripts/check-secrets.sh
Fix a hit by moving the value into the environment; see .env.example. If the
value was ever real, rotate it -- it is in git history either way, so deleting
it from the working tree does not un-leak it.

For a genuine false positive, append `# nosec-lenium` to the line.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

SKIP_DIRS = {"node_modules", ".venv", "venv", "vendor", "dist", "build", "coverage", ".git"}
SKIP_FILE = re.compile(
    r"(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|[^/]*\.lock|.*\.map)$"
)
SKIP_PATH = re.compile(r"^patches/")

# 1. Unambiguous credential prefixes.
PREFIX = re.compile(
    r"(?:sk|pk|rk)_live_[A-Za-z0-9]{16,}"
    r"|ghp_[A-Za-z0-9]{30,}"
    r"|github_pat_[A-Za-z0-9_]{40,}"
    r"|glpat-[A-Za-z0-9_-]{20,}"
    r"|A[KS]IA[0-9A-Z]{16}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"
    r"|AIza[0-9A-Za-z_-]{30,}"
    r"|ya29\.[0-9A-Za-z_-]{20,}"
    r"|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"  # JWT
)

# 2. Private key material.
PEM = re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----")

# 3a. Credential-shaped identifier: env-style (SOMETHING_API_KEY, DB_SECRET) or
#     camelCase (apiKey, secretKey). Word boundaries are load-bearing: without
#     them a bare "key" matches inside slugs like
#     `1942theglasskeylallavedecristalstuartheisler`. A bare `KEY` on its own is
#     also excluded, since in this repo it is a localStorage key *name*.
CRED_NAME = re.compile(
    r"\b(?:"
    r"[A-Z][A-Z0-9]*_(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|KEY)"
    r"|[A-Z][A-Z0-9]*KEY\b"
    r"|(?:api|secret|access|refresh|auth|session|private|signing)[Kk]ey\b"
    r"|(?:api|secret|access|refresh|auth|session|private|signing)[Tt]oken\b"
    r"|pass(?:word|wd)\b"
    r")"
)
# 3b. Any quoted literal of interest on the same line. Combined with CRED_NAME
#     at line scope, this catches every wrapper form:
#       KEY = "..."
#       KEY = os.environ.get("KEY") or "..."
#       KEY = process.env.KEY ?? "..."
#     A line-scoped join is what makes the `or "..."` fallback case work; the
#     value gate below is what keeps it from matching ordinary code.
LITERAL = re.compile(r"""["']([^"'\s]{16,200})["']""")

# Values that are readable slugs, not secrets.
SLUG = re.compile(r"^[a-z][a-z0-9]*(?:[-_./ ][a-z0-9]+)*$")
# Public identifiers that look random but are not secret.
ALLOW = ("data-cf-beacon",)

MIN_LEN = 16


def looks_secret(value: str) -> bool:
    if any(a in value for a in ALLOW):
        return False
    if SLUG.match(value):
        return False  # "lenium_auth_token" -- a name, not a credential
    # A real key mixes cases/digits or is hex/base64. Require a digit so that
    # prose and word-slugs never qualify.
    return any(c.isdigit() for c in value) and len(value) >= MIN_LEN


def main() -> int:
    try:
        files = subprocess.run(
            ["git", "ls-files"], capture_output=True, text=True, check=True
        ).stdout.splitlines()
    except subprocess.CalledProcessError:
        print("not a git repository", file=sys.stderr)
        return 2
    if not files:
        print("no tracked files")
        return 0

    flagged: dict[str, list[tuple[int, str, str]]] = {}

    for rel in files:
        if SKIP_PATH.match(rel) or SKIP_FILE.match(rel):
            continue
        if any(part in SKIP_DIRS for part in Path(rel).parts):
            continue
        path = Path(rel)
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        for lineno, line in enumerate(text.splitlines(), start=1):
            if "nosec-lenium" in line:
                continue
            hit: tuple[str, str] | None = None
            if PEM.search(line):
                hit = ("private key block", "")
            elif (m := PREFIX.search(line)) is not None:
                hit = (f"credential prefix {m.group(0)[:10]}…", "")
            else:
                if CRED_NAME.search(line):
                    for m in LITERAL.finditer(line):
                        value = m.group(1)
                        if looks_secret(value):
                            hit = (
                                "credential-named assignment",
                                f"{value[:4]}…{value[-2:]}",
                            )
                            break
            if hit:
                flagged.setdefault(rel, []).append((lineno, hit[0], line.strip()))

    if not flagged:
        print("no credential-shaped literals in tracked files ✓")
        return 0

    for rel, rows in sorted(flagged.items()):
        print(f"::error file={rel}::credential-shaped literal")
        for lineno, reason, line in rows:
            print(f"    {lineno}: {reason}")
            print(f"      | {line[:110]}")

    print(
        f"\nBLOCKED: {len(flagged)} file(s) contain credential-shaped literals.\n"
        "  - move the value into the environment; see .env.example\n"
        "  - if it was ever real, ROTATE it. it is in git history either way,\n"
        "    so removing it from the working tree does not un-leak it.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
