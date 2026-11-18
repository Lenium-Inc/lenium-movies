# Cloud Run image for the catalogue/playback backend.
#
# `python:3.11-slim` plus Playwright's own Chromium: `browser_resolver.py`
# launches a headless browser to derive the stream id that plain HTTP cannot
# reproduce, so the image must carry both the browser and its shared libraries.
# Playwright is installed here rather than in requirements.txt because the module
# imports it lazily and the browser build has to match this image, not a dev box.
#
# Build/deploy with Cloud Build (`gcloud run deploy --source .`), which is why
# there is a Dockerfile at the repo root: the context also needs gunicorn.conf.py.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080 \
    # Both SQLite files are caches on an ephemeral filesystem, so keep them off
    # the image layer and out of the read path Cloud Run snapshots.
    CATALOG_DB_PATH=/tmp/catalog.db \
    SQLITE_PATH=/tmp/freestream.db

WORKDIR /app

COPY movie-backend/requirements.txt ./movie-backend/requirements.txt
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    pip install --no-cache-dir -r movie-backend/requirements.txt playwright; \
    # --with-deps installs the fonts and X libraries Chromium needs, which is
    # the difference between a working resolver and a browser that fails to
    # launch silently.
    playwright install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/*

COPY gunicorn.conf.py ./gunicorn.conf.py
COPY movie-backend/ ./movie-backend/

# `app.py` imports authdb/catalog_* as top-level modules, so the process has to
# start from movie-backend/. One gthread worker with 16 threads matches Cloud
# Run's concurrency: the catalogue is I/O-bound, and the Playwright resolver owns
# a single browser shared through a queue, so extra processes would duplicate it.
WORKDIR /app/movie-backend
EXPOSE 8080

CMD exec gunicorn -c /app/gunicorn.conf.py \
    -b 0.0.0.0:${PORT} \
    --worker-class gthread --workers 1 --threads 16 --timeout 3600 \
    app:app
