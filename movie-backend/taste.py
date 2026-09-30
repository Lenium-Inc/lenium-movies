"""Per-profile taste signals and a deterministic linear recommender.

This is the same model the client already ran in `sessionStorage`, moved
server-side and keyed to `profile_id`. The weights, the decay factor and the
trimming rules are unchanged, so the ordering a profile sees does not change
overtime -- only its scope, lifetime and device-independence do.

Why linear and not a neural net: a household has 2-4 profiles and each
accumulates a handful of interactions. There is nowhere near enough data to
train an embedding model, and at that scale a trained model loses to a decayed
counter. The tradeoff is deliberate and the evaluation in `evaluate` exists to
make the decision falsifiable rather than a matter of taste.

Privacy: only derived features are persisted. A search is reduced to its
normalised genre/keyword tokens and never stored as text, so a private query
cannot be reconstructed from this module's tables.
"""

from __future__ import annotations

import hashlib
import math
import re

# A person mention is a far stronger signal than a genre, which every title in
# a genre shares. These match the client's previous constants exactly.
GENRE_WEIGHT = 1.0
CAST_WEIGHT = 1.5
DIRECTOR_WEIGHT = 2.0

# Every new interaction discounts what came before, so recent taste dominates.
DECAY = 0.6

MAX_GENRES = 8
MAX_PEOPLE = 12

# Below this a signal is noise and is dropped rather than carried forever.
MIN_WEIGHT = 0.05

# Interaction strengths. Playing a title says far more about taste than
# opening its details page, and saving it is a deliberate statement.
KIND_WEIGHTS = {
    "play": 1.0,
    "complete": 1.4,
    "save": 1.2,
    "search": 0.5,
    "open": 0.25,
}

# Tokens that describe the query rather than the taste: kept out of the feature
# space so "action movies" is not treated as interest in the word "action" plus
# interest in "movies".
STOPWORDS = {
    "movie", "movies", "film", "films", "show", "shows", "series", "watch",
    "free", "full", "hd", "new", "best", "top", "the", "a", "an", "of", "and",
    "with",
    # Prepositions and conjunctions. Short enough that the >2 character filter
    # does not catch them, and they carry no taste, but they fragment one
    # interest into two never-quite-repeated searches.
    "about", "from", "into", "onto", "over", "under", "like", "some", "any",
    "for", "but", "not", "are", "was", "were", "you", "your", "they", "them",
    "his", "her", "its", "our", "out", "off", "all", "one", "two", "get",
    "got", "can", "did", "has", "had", "have", "him", "she", "who", "what",
}

# A four-digit token is a release year, not a taste. Treating "horror 2019" and
# "horror films" as different interests is exactly the kind of fragmentation
# that keeps a real signal below the repeat threshold forever.
_YEAR = re.compile(r"^(19|20)\d{2}$")

MAX_SEARCH_TOKENS = 6
# A query token is only a taste signal once it has recurred; a single search
# word is often a typo or a passing curiosity.
SEARCH_TOKEN_MIN_HITS = 2

# Evaluation: how many candidates the model's ranking is judged on, and the
# smallest candidate pool that can produce a verdict at all. Below this, the top
# K covers most or all of the pool and no ordering could have been wrong.
TOP_K = 5
MIN_CANDIDATES_FOR_VERDICT = 8

# TMDB genre id -> display name. Lives here rather than in `tmdb_service` so the
# model stays a pure module with no provider dependency, and `tmdb_service`
# imports it from here rather than keeping a second copy that can drift. Events
# are recorded with genre *names*, so ranking a list endpoint row (which only
# carries ids) means mapping ids back to these names.
GENRE_NAMES = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
    99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
    27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi",
    10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western", 10762: "Kids",
    10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap",
    10767: "Talk", 10768: "War & Politics",
}


def normalise_feature(value: str) -> str:
    return (value or "").strip().lower()


def tokenise_query(query: str) -> list[str]:
    """Reduce a search string to taste-bearing tokens.

    The raw text is discarded here and never stored, which is the whole point:
    we learn "prefers horror" without retaining what was typed.
    """
    cleaned = "".join(
        ch if ch.isalnum() or ch.isspace() else " " for ch in (query or "").lower()
    )
    tokens = [
        t
        for t in cleaned.split()
        if t and t not in STOPWORDS and len(t) > 2 and not _YEAR.match(t)
    ]
    seen: set[str] = set()
    unique: list[str] = []
    for token in tokens:
        if token not in seen:
            seen.add(token)
            unique.append(token)
    return unique[:MAX_SEARCH_TOKENS]


def query_feature_key(query: str) -> str:
    """A stable, non-reversible key for a query's token set.

    Used to count how often a token has been searched. Hashing means the table
    holds a fingerprint, not the words, so it is not a searchable log.

    Keyed on the *union* of tokens rather than the whole set, so "horror
    movies" and "horror films" -- the same interest phrased differently, and
    the same after stopwording -- collapse to one feature instead of looking
    like two unrelated searches that each happened once and so never clear the
    repeat threshold.
    """
    tokens = tokenise_query(query)
    if not tokens:
        return ""
    digest = hashlib.sha256("|".join(sorted(tokens)).encode("utf-8")).hexdigest()
    return digest[:16]


# ---------------------------------------------------------------------------
# weight state
# ---------------------------------------------------------------------------


def empty_weights() -> dict[str, dict[str, float]]:
    return {"genre": {}, "people": {}}


def _decay(weights: dict[str, float]) -> dict[str, float]:
    return {k: v * DECAY for k, v in weights.items()}


def _trim(weights: dict[str, float], limit: int) -> dict[str, float]:
    entries = [(k, v) for k, v in weights.items() if v >= MIN_WEIGHT]
    # Sort by weight then key so the retained set never depends on insertion
    # order; two equivalent states always trim to the same shape.
    entries.sort(key=lambda kv: (-kv[1], kv[0]))
    return dict(entries[:limit])


def fold_event_with_director(
    state: dict[str, dict[str, float]],
    kind: str,
    genres,
    cast,
    director=None,
    weight: float = 1.0,
) -> dict[str, dict[str, float]]:
    """Fold one interaction into the decayed weight state.

    A negative `weight` (what "removed this from my list" sends) subtracts from
    the features of that title rather than being ignored: the event used to hit
    the `base <= 0` guard below and return the state untouched, so a rejection
    was recorded in the log and changed nothing about what the feed recommends.
    Subtracting lets a profile back away from something it no longer wants,
    while the decay-and-trim loop still forgets it eventually.
    """
    base = weight * KIND_WEIGHTS.get(kind, 0.25)
    if base == 0:
        return state
    next_state = {
        "genre": _decay(state.get("genre", {})),
        "people": _decay(state.get("people", {})),
    }
    for genre in genres or []:
        key = normalise_feature(genre)
        if key:
            next_state["genre"][key] = next_state["genre"].get(key, 0) + GENRE_WEIGHT * base
    for person in cast or []:
        key = normalise_feature(person)
        if key:
            next_state["people"][key] = next_state["people"].get(key, 0) + CAST_WEIGHT * base
    dkey = normalise_feature(director or "")
    if dkey:
        next_state["people"][dkey] = next_state["people"].get(dkey, 0) + DIRECTOR_WEIGHT * base
    return {
        # A subtract-only feature can land below MIN_WEIGHT (or go negative);
        # trimming on insert drops it, so a rejection fully cancels a feature
        # rather than leaving a negative weight that would rank against
        # everything.
        "genre": _trim(next_state["genre"], MAX_GENRES),
        "people": _trim(next_state["people"], MAX_PEOPLE),
    }


def score(weights: dict[str, dict[str, float]], genres, cast, director=None) -> float:
    """How strongly a candidate matches the accumulated affinity."""
    genre_w = weights.get("genre", {})
    people_w = weights.get("people", {})
    total = 0.0
    for genre in genres or []:
        total += genre_w.get(normalise_feature(genre), 0.0)
    for person in cast or []:
        total += people_w.get(normalise_feature(person), 0.0)
    dkey = normalise_feature(director or "")
    if dkey:
        total += people_w.get(dkey, 0.0)
    return total


def rank(weights: dict[str, dict[str, float]], items) -> list:
    """Promote matching titles, leaving everything else in its original order.

    Sorting on the original index as the tiebreaker is what keeps paging stable:
    the same input always produces the same output, so scrolling never
    reshuffles titles the viewer has already seen.

    Candidates whose `genres` is empty but whose `genre_ids` is not are scored on
    the ids as well. TMDB's list endpoints only carry ids, so without this the
    whole feed scored 0.0 against a profile that had learned real affinities and
    the endpoint reported `personalised: True` over an untouched list.
    """
    genre_w = weights.get("genre", {})
    people_w = weights.get("people", {})
    if not genre_w and not people_w:
        return list(items)
    scored = []
    for index, item in enumerate(items):
        genres = _field(item, "genres") or _field(item, "genre") or []
        cast = _field(item, "cast") or []
        director = _field(item, "director")
        item_score = score(weights, genres, cast, director)
        if item_score == 0.0:
            item_score = score(weights, _genre_keys(item), [], None)
        scored.append((item_score, index, item))
    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    return [entry[2] for entry in scored]


def ranked_scores(weights: dict[str, dict[str, float]], items) -> list:
    """The per-item scores `rank` would sort on, in input order.

    Exposed so a caller can tell whether ranking actually moved anything before
    it claims to have personalised a list.
    """
    genre_w = weights.get("genre", {})
    people_w = weights.get("people", {})
    if not genre_w and not people_w:
        return [0.0] * len(list(items))
    out = []
    for item in items:
        genres = _field(item, "genres") or _field(item, "genre") or []
        cast = _field(item, "cast") or []
        director = _field(item, "director")
        value = score(weights, genres, cast, director)
        if value == 0.0:
            value = score(weights, _genre_keys(item), [], None)
        out.append(value)
    return out


def _genre_keys(item) -> list:
    """Genre features for a TMDB list row, which carries ids but not names."""
    raw = _field(item, "genre_ids") or []
    keys = []
    for gid in raw:
        name = GENRE_NAMES.get(gid)
        keys.append(name if name else f"genre:{gid}")
    return keys


def _field(item, name):
    if isinstance(item, dict):
        return item.get(name)
    return getattr(item, name, None)


def has_signal(weights: dict[str, dict[str, float]]) -> bool:
    return bool(weights.get("genre") or weights.get("people"))


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------


def evaluate(events, split: float = 0.8) -> dict:
    """Hold out the most recent `1 - split` of interactions and score the model
    trained on the rest.

    The metric is a hit rate over held-out events at `TOP_K`: what share of the
    viewer's later interactions involved a feature the model ranked into its
    top K, against a random-selection baseline drawn from the same pool.

    Two honest limits are worth stating. The candidate pool is built from the
    viewer's own features, because no catalogue is available inside this
    function, so this measures whether the ordering predicts the viewer's own
    behaviour -- not whether the feed improved. And it reports
    `insufficient_data` rather than a score when the profile has too few
    distinct features for any ranking to be meaningful.
    """
    ordered = sorted(events or [], key=lambda e: (e.get("created_at") or 0))
    if len(ordered) < 4:
        return {
            "samples": len(ordered),
            "hit_rate_at_%d" % TOP_K: None,
            "random_hit_rate": None,
            "best_possible": None,
            "verdict": "insufficient_data",
            "scope": "self_contained",
        }
    cut = max(1, int(len(ordered) * split))
    train, held = ordered[:cut], ordered[cut:]
    if not held:
        return {
            "samples": len(ordered),
            "hit_rate_at_%d" % TOP_K: None,
            "random_hit_rate": None,
            "best_possible": None,
            "verdict": "insufficient_data",
            "scope": "self_contained",
        }

    weights = empty_weights()
    for event in train:
        weights = fold_event_with_director(
            weights,
            event.get("kind", "play"),
            _split_list(event.get("genres")),
            _split_list(event.get("people")),
            weight=event.get("weight", 1.0),
        )

    seen_features = set()
    for event in held:
        for genre in _split_list(event.get("genres")):
            seen_features.add(normalise_feature(genre))
        for person in _split_list(event.get("people")):
            seen_features.add(normalise_feature(person))

    if not seen_features:
        return {
            "samples": len(ordered),
            "hit_rate_at_%d" % TOP_K: None,
            "random_hit_rate": None,
            "best_possible": None,
            "verdict": "insufficient_data",
            "scope": "self_contained",
        }

    # Candidates are built ONLY from the training slice. An earlier version
    # built them from the held-out features, which made the metric circular: any
    # candidate made of a held-out feature scored as a hit by construction, so
    # precision was near 1.0 no matter how bad the model was, and the eval
    # "passed" on every profile.
    train_features = set()
    for event in train:
        for genre in _split_list(event.get("genres")):
            train_features.add(normalise_feature(genre))
        for person in _split_list(event.get("people")):
            train_features.add(normalise_feature(person))
    if not train_features:
        return {
            "samples": len(ordered),
            "hit_rate_at_%d" % TOP_K: None,
            "random_hit_rate": None,
            "best_possible": None,
            "verdict": "insufficient_data",
            "scope": "self_contained",
        }

    # Each feature keeps the kind it was recorded as. A person scored as a genre
    # would be weighted 1.0 instead of 1.5, changing the ranking it is supposed
    # to be measured on.
    genre_pool = set()
    for event in train:
        for genre in _split_list(event.get("genres")):
            genre_pool.add(normalise_feature(genre))
    candidates = [
        {
            "genres": [feature] if feature in genre_pool else [],
            "cast": [] if feature in genre_pool else [feature],
            "director": None,
        }
        for feature in sorted(train_features)
    ]

    ranked = rank(weights, candidates)[:TOP_K]
    top = set()
    for candidate in ranked:
        for feature in _split_list(candidate.get("genres")) + _split_list(
            candidate.get("cast")
        ):
            top.add(normalise_feature(feature))

    # Score per held-out event: did this event involve a feature the model
    # ranked into its top K? Normalising by events rather than by
    # recommendations is what makes the number respond to the ranking at all.
    held_features = []
    for event in held:
        held_features.append(
            {
                normalise_feature(f)
                for f in _split_list(event.get("genres")) + _split_list(event.get("people"))
            }
        )
    hits = sum(1 for features in held_features if features & top)
    precision = hits / max(1, len(held_features))

    pool = len(candidates)
    # Two reference points, and both are needed for the verdict to mean
    # anything:
    #
    #   ceiling -- the best any ranking could score. A held-out event whose
    #     features never appear in the training slice is unreachable, so 1.0 is
    #     not available and comparing against it would make a perfect model
    #     look like a failure.
    #   random  -- what drawing TOP_K at random from the same pool would score.
    #
    # Measuring against `random` alone is what produced a saturated 1.0 baseline
    # before: it ignored that most held-out features were reachable at all.
    ceiling = 0.0
    random_expected = 0.0
    for features in held_features:
        reachable_in_event = len(features & train_features)
        if reachable_in_event == 0:
            continue
        ceiling += 1.0
        # P(a random K-subset of the pool misses every one of this event's
        # reachable features).
        misses = math.comb(pool - reachable_in_event, min(TOP_K, pool))
        total = math.comb(pool, min(TOP_K, pool))
        random_expected += 1.0 - (misses / total if total else 1.0)
    ceiling /= max(1, len(held_features))
    random_expected /= max(1, len(held_features))

    headroom = ceiling - random_expected
    if headroom <= 0.05 or pool < MIN_CANDIDATES_FOR_VERDICT:
        # Not enough distinct, predictable features for a ranking to be
        # measurable. This says "not enough data yet", not "the model is bad".
        verdict = "insufficient_data"
    elif precision > random_expected + 0.05:
        verdict = "better"
    else:
        verdict = "not_better"

    return {
        "samples": len(ordered),
        "train": len(train),
        "held_out": len(held),
        "candidates": pool,
        "hit_rate_at_%d" % TOP_K: round(precision, 4),
        "random_hit_rate": round(random_expected, 4),
        "best_possible": round(ceiling, 4),
        "verdict": verdict,
        # This is a self-contained check on a profile's own history, not a
        # live A/B result: the candidate pool is the viewer's own feature set
        # because no catalogue is available here. It can show that the ordering
        # predicts the viewer's own next interactions; it cannot show that it
        # beats the real feed.
        "scope": "self_contained",
    }


def _split_list(value) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(v) for v in value if v]
    return [part for part in str(value).split(",") if part]
