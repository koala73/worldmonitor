---
title: Unrest evidence contract
noindex: true
---

# Unrest evidence contract

GDELT GKG records describe articles and the places those articles mention. An
unrest theme applies to the article, not to each place. Neither article volume,
negative tone, nor a valid source URL proves that an event occurred at a location.

Both the bulk materializer and the GKG fallback retain location buckets as
**unverified media signals**. The existing `UNREST_SOURCE_TYPE_GDELT` is the
wire discriminator. These records use `UNREST_EVENT_TYPE_UNSPECIFIED`,
`SEVERITY_LEVEL_UNSPECIFIED`, and `CONFIDENCE_LEVEL_LOW`. Their summary explains
that a local event is not verified. Coordinates and city describe a media
mention. The bulk timestamp is the source article time; the fallback timestamp
is the collection time. Neither is a verified incident time. Links are related
articles, not verified evidence of a local event.

Readers normalize old GDELT snapshots to this contract. The browser also handles
old cached responses without a verified badge or a riot classification. Its
legacy `civil_unrest` and `low` values are display fallbacks, not assessments.
Single and cluster popups explicitly label the signal. More reports do not raise
confidence or severity. This contract does not attempt to infer an event location
from an article title or from the first location in an article.

ACLED retains its existing classification and confidence. Deduplication keeps
source types separate so an unverified GDELT link cannot become ACLED evidence.
Existing already-merged ACLED cache records cannot recover link provenance; the
next successful unrest seed replaces those records under the new contract.

The regression fixtures cover an article about a riot in Cairo that also mentions
Paris, high report volume, both producer paths, cached records, source separation,
and the single and mixed-cluster popups. The positive-news pipeline is unchanged.

Issue #8610's two historical URLs were absent from both the child issue and the
parent report when checked on 2026-09-29. The fixtures prove the pipeline weakness
and the new contract. They do not establish what those two articles contained.
