"""Master controller for the platform engine.

Instantiates the local SQLite database (`platform_engine.db`), creates every
table (Track A movies; Track B series -> seasons -> episodes; plus the shared
`stream_sources` and `trailer_sources` matrices), enables SQLite foreign-key
enforcement on every connection, and exposes explicit insertion methods used by
both the manual CLI and the crawler.

CLI workflows (from this directory):

    python database.py init [--reset]
    python database.py add-movie --title "Two Thumbs" [--stream "URL|1080p|vimeo"] [--trailer "URL:youtube"]
    python database.py add-episode --series "Blockbusters" --season 2 --episode 7 --stream "URL|4K"
    python database.py scrape https://example.com/page --store
    python database.py query [--movies] [--series]
"""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
from pathlib import Path

from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, selectinload, sessionmaker

from models import (
    STREAM_QUALITY_TIERS,
    Base,
    Episode,
    Movie,
    Season,
    Series,
    StreamSource,
    TrailerSource,
)

DEFAULT_DB = "platform_engine.db"

_QUALITY_CANONICAL = {
    "360p": "360p",
    "720p": "720p",
    "1080p": "1080p",
    "4k": "4K",
    "4K": "4K",
    "2160p": "4K",
    "auto": "Auto",
    "Auto": "Auto",
}


class MediaDatabase:
    """Owning handle to the SQLite engine, schema lifecycle, and ingest API."""

    def __init__(self, path: str = DEFAULT_DB) -> None:
        self.path = path
        self.engine = create_engine(
            f"sqlite:///{Path(path).resolve()}", future=True
        )
        event.listen(self.engine, "connect", _enable_sqlite_foreign_keys)
        self.session_factory = sessionmaker(
            bind=self.engine, autoflush=False, expire_on_commit=False
        )

    def create_schema(self, *, reset: bool = False) -> None:
        if reset:
            Base.metadata.drop_all(self.engine)
        Base.metadata.create_all(self.engine)

    def _session(self) -> Session:
        return self.session_factory()

    @contextlib.contextmanager
    def session_scope(self):
        session = self._session()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def insert_standalone_movie(
        self,
        title: str,
        raw_text: str = "",
        streams_list: list | None = None,
        trailers_list: list | None = None,
    ) -> Movie:
        """Track A ingest: a standalone movie plus its streams and trailers."""
        normalized_title = title.strip()
        if not normalized_title:
            raise ValueError("movie title must not be empty")
        with self.session_scope() as session:
            movie = Movie(title=normalized_title, raw_text=raw_text or "")
            for spec in streams_list or []:
                movie.streams.append(StreamSource(**_stream_spec(spec)))
            for spec in trailers_list or []:
                movie.trailers.append(TrailerSource(**_trailer_spec(spec)))
            session.add(movie)
            session.flush()
            return session.scalars(
                select(Movie)
                .options(selectinload(Movie.streams), selectinload(Movie.trailers))
                .where(Movie.id == movie.id)
            ).one()

    def insert_episodic_content(
        self,
        series_title: str,
        season_number: int,
        episode_number: int,
        streams_list: list | None = None,
        raw_text: str = "",
    ) -> Episode:
        """Track B ingest: an episode beneath a season beneath a series.

        Series and seasons are created on demand (find-or-create), so feeding a
        new episode for an existing show is idempotent: only the new stream rows
        are appended for an already-indexed episode.
        """
        normalized_title = series_title.strip()
        if not normalized_title:
            raise ValueError("series title must not be empty")
        if int(season_number) < 1 or int(episode_number) < 1:
            raise ValueError("season_number and episode_number must be >= 1")

        with self.session_scope() as session:
            series = session.scalar(
                select(Series).where(Series.title == normalized_title)
            )
            if series is None:
                series = Series(title=normalized_title)
                session.add(series)
                session.flush()

            season = session.scalar(
                select(Season).where(
                    Season.series_id == series.id,
                    Season.season_number == int(season_number),
                )
            )
            if season is None:
                season = Season(
                    series_id=series.id, season_number=int(season_number)
                )
                session.add(season)
                session.flush()

            episode = session.scalar(
                select(Episode).where(
                    Episode.season_id == season.id,
                    Episode.episode_number == int(episode_number),
                )
            )
            if episode is None:
                episode = Episode(
                    season_id=season.id,
                    episode_number=int(episode_number),
                    raw_text=raw_text or "",
                )
                session.add(episode)
                session.flush()

            for spec in streams_list or []:
                session.add(StreamSource(episode_id=episode.id, **_stream_spec(spec)))
            session.flush()
            return episode

    def attach_series_trailers(self, series_title: str, trailers_list: list) -> None:
        """Attach trailer embeds to an existing series row (find-or-create)."""
        normalized_title = series_title.strip()
        with self.session_scope() as session:
            series = session.scalar(
                select(Series).where(Series.title == normalized_title)
            )
            if series is None:
                series = Series(title=normalized_title)
                session.add(series)
                session.flush()
            for spec in trailers_list or []:
                session.add(
                    TrailerSource(series_id=series.id, **_trailer_spec(spec))
                )


def _enable_sqlite_foreign_keys(dbapi_connection, connection_record) -> None:  # noqa: ARG001
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def _stream_spec(spec) -> dict:
    if isinstance(spec, str):
        parts = spec.split("|")
        url = parts[0].strip()
        if not url:
            raise ValueError("stream url must not be empty")
        quality = _coerce_quality(parts[1].strip() if len(parts) > 1 else None)
        provider = parts[2].strip() if len(parts) > 2 and parts[2].strip() else "iframe"
        return {"url": url, "quality_tier": quality, "provider_type": provider}
    if isinstance(spec, dict):
        url = str(spec["url"]).strip()
        if not url:
            raise ValueError("stream url must not be empty")
        return {
            "url": url,
            "quality_tier": _coerce_quality(
                spec.get("quality_tier") or spec.get("quality")
            ),
            "provider_type": str(spec.get("provider_type") or "iframe").strip() or "iframe",
        }
    raise TypeError(f"unsupported stream spec: {spec!r}")


def _trailer_spec(spec) -> dict:
    if isinstance(spec, str):
        parts = spec.split(":", 1)
        url = parts[0].strip()
        if not url:
            raise ValueError("trailer url must not be empty")
        provider = parts[1].strip() if len(parts) > 1 and parts[1].strip() else "youtube"
        return {"url": url, "provider_type": provider}
    if isinstance(spec, dict):
        url = str(spec["url"]).strip()
        if not url:
            raise ValueError("trailer url must not be empty")
        return {
            "url": url,
            "provider_type": str(spec.get("provider_type") or "youtube").strip() or "youtube",
        }
    raise TypeError(f"unsupported trailer spec: {spec!r}")


def _coerce_quality(tier: str | None) -> str:
    if tier is None:
        return "Auto"
    canonical = _QUALITY_CANONICAL.get(tier.strip())
    if canonical is None:
        raise ValueError(
            f"invalid quality tier {tier!r}; allowed: {', '.join(STREAM_QUALITY_TIERS)}"
        )
    return canonical


def _read_maybe_file(raw: str) -> str:
    if raw.startswith("@") and os.path.isfile(raw[1:]):
        return Path(raw[1:]).read_text(encoding="utf-8")
    return raw


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _add_argparse(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--db", default=DEFAULT_DB, help="SQLite database path.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="Create all tables.").add_argument(
        "--reset", action="store_true", help="Drop existing tables first."
    )

    movie = sub.add_parser("add-movie", help="Insert a standalone movie (Track A).")
    movie.add_argument("--title", required=True)
    movie.add_argument("--raw-text", default="", help="Inline text, or @file for a path.")
    movie.add_argument("--stream", action="append", default=[], help="URL|QUALITY|PROVIDER")
    movie.add_argument("--trailer", action="append", default=[], help="URL:PROVIDER")

    episode = sub.add_parser("add-episode", help="Insert an episode (Track B).")
    episode.add_argument("--series", required=True)
    episode.add_argument("--season", type=int, required=True)
    episode.add_argument("--episode", type=int, required=True)
    episode.add_argument("--raw-text", default="", help="Inline text, or @file for a path.")
    episode.add_argument("--stream", action="append", default=[], help="URL|QUALITY|PROVIDER")

    scrape = sub.add_parser("scrape", help="Crawl pages, optionally storing results.")
    scrape.add_argument("urls", nargs="+")
    scrape.add_argument("--store", action="store_true", help="Insert movies into the DB.")
    scrape.add_argument("--workers", type=int, default=8)
    scrape.add_argument("--timeout-ms", type=int, default=30_000)

    query = sub.add_parser("query", help="List ingested movies and series.")
    query.add_argument("--movies", action="store_true")
    query.add_argument("--series", action="store_true")


def _cmd_init(db: MediaDatabase, args) -> int:
    db.create_schema(reset=args.reset)
    print(f"schema ready at {Path(db.path).resolve()}")
    return 0


def _cmd_add_movie(db: MediaDatabase, args) -> int:
    movie = db.insert_standalone_movie(
        title=args.title,
        raw_text=_read_maybe_file(args.raw_text),
        streams_list=args.stream,
        trailers_list=args.trailer,
    )
    print(f"movie #{movie.id}: {movie.title} "
          f"({len(movie.streams)} streams, {len(movie.trailers)} trailers)")
    return 0


def _cmd_add_episode(db: MediaDatabase, args) -> int:
    episode = db.insert_episodic_content(
        series_title=args.series,
        season_number=args.season,
        episode_number=args.episode,
        streams_list=args.stream,
        raw_text=_read_maybe_file(args.raw_text),
    )
    streams = session_count_streams(db, episode)
    print(f"episode #{episode.id}: {args.series} S{args.season}E{args.episode} "
          f"({streams} streams)")
    return 0


def session_count_streams(db: MediaDatabase, episode: Episode) -> int:
    with db.session_scope() as session:
        return len(
            session.scalars(
                select(StreamSource).where(StreamSource.episode_id == episode.id)
            ).all()
        )


def _cmd_scrape(db: MediaDatabase, args) -> int:
    import asyncio

    from crawler import crawl_many

    results = asyncio.run(
        crawl_many(
            args.urls,
            workers=args.workers,
            timeout_ms=args.timeout_ms,
        )
    )
    for result in results:
        if args.store:
            db.insert_standalone_movie(
                title=result.title,
                raw_text=result.body_text,
                streams_list=result.stream_urls,
                trailers_list=result.trailer_urls,
            )
            print(f"stored movie {result.title!r}")
        else:
            print(result.to_json())
    return 0


def _cmd_query(db: MediaDatabase, args) -> int:
    show_movies = args.movies or not args.series
    show_series = args.series or not args.movies
    with db.session_scope() as session:
        if show_movies:
            movies = session.scalars(select(Movie).order_by(Movie.title)).all()
            print(f"[movies] {len(movies)}")
            for movie in movies:
                follows = len(session.scalars(
                    select(StreamSource).where(StreamSource.movie_id == movie.id)
                ).all())
                trailers = len(session.scalars(
                    select(TrailerSource).where(TrailerSource.movie_id == movie.id)
                ).all())
                print(f"  #{movie.id} {movie.title!r} – {follows} streams, {trailers} trailers")
        if show_series:
            series = session.scalars(select(Series).order_by(Series.title)).all()
            print(f"[series] {len(series)}")
            for item in series:
                seasons = session.scalars(
                    select(Season).where(Season.series_id == item.id)
                ).all()
                episodes = session.scalars(
                    select(Episode).join(Season).where(Season.series_id == item.id)
                ).all()
                streams = session.scalars(
                    select(StreamSource)
                    .join(Episode, StreamSource.episode_id == Episode.id)
                    .join(Season, Episode.season_id == Season.id)
                    .where(Season.series_id == item.id)
                ).all()
                print(f"  #{item.id} {item.title!r} – {len(seasons)} seasons, "
                      f"{len(episodes)} episodes, {len(streams)} streams")
    return 0


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    _add_argparse(parser)
    args = parser.parse_args(argv)

    db = MediaDatabase(args.db)
    handlers = {
        "init": _cmd_init,
        "add-movie": _cmd_add_movie,
        "add-episode": _cmd_add_episode,
        "scrape": _cmd_scrape,
        "query": _cmd_query,
    }
    try:
        return handlers[args.command](db, args)  # type: ignore[index]
    except ValueError as error:
        print(f"[error] {error}", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 - report and exit for CLI parity
        print(f"[error] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(_main())