"""Relational schema for the platform engine (SQLite, SQLAlchemy 2.x).

Two independent ingestion tracks share one link-resolution matrix:

    Track A - standalone films:            movies -> stream_sources / trailer_sources
    Track B - episodic series hierarchy:   series -> seasons -> episodes
                                           series  -> trailer_sources
                                           seasons -> episodes -> stream_sources

Every `stream_sources` row resolves to exactly one target (a movie *or* an
episode) and `trailer_sources` resolves to exactly one of a movie or series.
Both matrices are guarded by SQLite check constraints so a misrouted row can
never be inserted.
"""

from __future__ import annotations

import datetime
from typing import Optional

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


class Base(DeclarativeBase):
    """Declarative root shared by every model."""


class CreatedMixin:
    """UTC ingestion timestamp for every row."""

    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class Movie(CreatedMixin, Base):
    """Track A - a standalone feature film with its raw text payload."""

    __tablename__ = "movies"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    raw_text: Mapped[str] = mapped_column(Text, nullable=False, default="")

    streams: Mapped[list[StreamSource]] = relationship(
        back_populates="movie", cascade="all, delete-orphan"
    )
    trailers: Mapped[list[TrailerSource]] = relationship(
        back_populates="movie", cascade="all, delete-orphan"
    )


class Series(CreatedMixin, Base):
    """Track B parent - a named episodic series."""

    __tablename__ = "series"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(
        String(255), nullable=False, unique=True, index=True
    )
    raw_text: Mapped[str] = mapped_column(Text, nullable=False, default="")

    seasons: Mapped[list[Season]] = relationship(
        back_populates="series", cascade="all, delete-orphan"
    )
    trailers: Mapped[list[TrailerSource]] = relationship(
        back_populates="series", cascade="all, delete-orphan"
    )


class Season(CreatedMixin, Base):
    """Track B child - one numbered season beneath a series."""

    __tablename__ = "seasons"

    id: Mapped[int] = mapped_column(primary_key=True)
    series_id: Mapped[int] = mapped_column(
        ForeignKey("series.id", ondelete="CASCADE"), nullable=False, index=True
    )
    season_number: Mapped[int] = mapped_column(nullable=False)

    series: Mapped[Series] = relationship(back_populates="seasons")
    episodes: Mapped[list[Episode]] = relationship(
        back_populates="season", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("series_id", "season_number", name="uq_series_season"),
    )


class Episode(CreatedMixin, Base):
    """Track B leaf - one numbered episode inside a season."""

    __tablename__ = "episodes"

    id: Mapped[int] = mapped_column(primary_key=True)
    season_id: Mapped[int] = mapped_column(
        ForeignKey("seasons.id", ondelete="CASCADE"), nullable=False, index=True
    )
    episode_number: Mapped[int] = mapped_column(nullable=False)
    raw_text: Mapped[str] = mapped_column(Text, nullable=False, default="")

    season: Mapped[Season] = relationship(back_populates="episodes")
    streams: Mapped[list[StreamSource]] = relationship(
        back_populates="episode", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("season_id", "episode_number", name="uq_season_episode"),
    )


STREAM_QUALITY_TIERS = ("360p", "720p", "1080p", "4K", "Auto")


class StreamSource(CreatedMixin, Base):
    """Link-resolution matrix shared by movies (Track A) and episodes (Track B).

    A row binds to exactly one target: a movie or an episode, never both. The
    `ck_stream_single_target` check constraint enforces exactly-one-non-null,
    and `ck_stream_quality_tier` pins the allowed quality vocabulary.
    """

    __tablename__ = "stream_sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    quality_tier: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default="Auto"
    )
    provider_type: Mapped[str] = mapped_column(
        String(255), nullable=False, default="iframe"
    )
    movie_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("movies.id", ondelete="CASCADE"), index=True
    )
    episode_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("episodes.id", ondelete="CASCADE"), index=True
    )

    movie: Mapped[Optional[Movie]] = relationship(back_populates="streams")
    episode: Mapped[Optional[Episode]] = relationship(back_populates="streams")

    __table_args__ = (
        CheckConstraint(
            "quality_tier IN ('360p', '720p', '1080p', '4K', 'Auto')",
            name="ck_stream_quality_tier",
        ),
        CheckConstraint(
            "(movie_id IS NULL) != (episode_id IS NULL)",
            name="ck_stream_single_target",
        ),
        CheckConstraint("provider_type <> ''", name="ck_stream_provider_not_empty"),
    )


class TrailerSource(CreatedMixin, Base):
    """External review/trailer embeds bound to a movie *or* a series.

    Stores platform embed strings (YouTube/Vimeo) as `url` with a keyed
    `provider_type` so the consumer can build playable embeds without re-parsing
    the URL.
    """

    __tablename__ = "trailer_sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    provider_type: Mapped[str] = mapped_column(
        String(255), nullable=False, default="youtube"
    )
    movie_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("movies.id", ondelete="CASCADE"), index=True
    )
    series_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("series.id", ondelete="CASCADE"), index=True
    )

    movie: Mapped[Optional[Movie]] = relationship(back_populates="trailers")
    series: Mapped[Optional[Series]] = relationship(back_populates="trailers")

    __table_args__ = (
        CheckConstraint(
            "(movie_id IS NULL) != (series_id IS NULL)",
            name="ck_trailer_single_target",
        ),
    )