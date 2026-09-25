#!/usr/bin/env bash
# Thin wrapper so pre-commit and CI can call a stable path.
set -euo pipefail
exec python3 "$(dirname "$0")/check_secrets.py" "$@"
