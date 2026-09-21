#!/usr/bin/env python3
"""
Aggregate WildChat-1M conversations by country x calendar quarter.

Produces scripts/_wildchat-usage-by-country-quarter.csv for the OWID join:
  country_name,iso3,quarter_end,conversations,corpus_share_pct

Metric is share of WildChat conversations in that quarter (opt-in proxy
traffic), NOT OWID population generative-AI usage %. Missing country or
timestamp rows are skipped (missing != invent).

Cite: Deng et al., WildChat (https://arxiv.org/abs/2405.01470)
      https://huggingface.co/datasets/allenai/WildChat-1M
License: ODC-BY

Usage (from apps/worldmonitor):
  python scripts/aggregate_wildchat_ai_usage.py

Requires: pyarrow, huggingface_hub (pip). Reads only country + timestamp
columns from each parquet shard (~3 GB total download, cached by HF hub).
"""

from __future__ import annotations

import csv
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RAW_OUT = SCRIPT_DIR / "_wildchat-usage-by-country-quarter.csv"
ISO_CSV = SCRIPT_DIR / "_iso3166.csv"

# Aliases WildChat / GeoIP names that differ from ISO 3166 English short names.
NAME_ALIASES: dict[str, str] = {
    "united states": "United States of America",
    "usa": "United States of America",
    "us": "United States of America",
    "uk": "United Kingdom of Great Britain and Northern Ireland",
    "united kingdom": "United Kingdom of Great Britain and Northern Ireland",
    "russia": "Russian Federation",
    "south korea": "Korea, Republic of",
    "korea, south": "Korea, Republic of",
    "north korea": "Korea (Democratic People's Republic of)",
    "vietnam": "Viet Nam",
    "iran": "Iran, Islamic Republic of",
    "syria": "Syrian Arab Republic",
    "taiwan": "Taiwan, Province of China",
    "tanzania": "Tanzania, United Republic of",
    "venezuela": "Venezuela, Bolivarian Republic of",
    "bolivia": "Bolivia, Plurinational State of",
    "moldova": "Moldova, Republic of",
    "laos": "Lao People's Democratic Republic",
    "brunei": "Brunei Darussalam",
    "czech republic": "Czechia",
    "slovakia": "Slovakia",
    "ivory coast": "Cote d'Ivoire",
    "cote d'ivoire": "Cote d'Ivoire",
    "macedonia": "North Macedonia",
    "palestine": "Palestine, State of",
    "hong kong": "Hong Kong",
    "macao": "Macao",
    "macau": "Macao",
}


def quarter_end(dt: datetime) -> date:
    y, m = dt.year, dt.month
    if m <= 3:
        return date(y, 3, 31)
    if m <= 6:
        return date(y, 6, 30)
    if m <= 9:
        return date(y, 9, 30)
    return date(y, 12, 31)


def load_name_to_iso3() -> dict[str, str]:
    if not ISO_CSV.exists():
        raise SystemExit(f"Missing {ISO_CSV.name}")
    by_lower: dict[str, str] = {}
    with ISO_CSV.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = (row.get("name") or "").strip()
            iso3 = (row.get("alpha-3") or "").strip().upper()
            if name and iso3:
                by_lower[name.lower()] = iso3
    return by_lower


def resolve_iso3(country: str, by_lower: dict[str, str]) -> str | None:
    raw = (country or "").strip()
    if not raw or raw.lower() in {"none", "null", "unknown"}:
        return None
    key = raw.lower()
    if key in by_lower:
        return by_lower[key]
    alias = NAME_ALIASES.get(key)
    if alias and alias.lower() in by_lower:
        return by_lower[alias.lower()]
    return None


def main() -> int:
    try:
        from huggingface_hub import hf_hub_download
        import pyarrow.parquet as pq
    except ImportError:
        print(
            "Need: pip install pyarrow huggingface_hub",
            file=sys.stderr,
        )
        return 2

    by_lower = load_name_to_iso3()
    # (iso3, quarter_end_iso) -> count; also keep a display name
    counts: Counter[tuple[str, str]] = Counter()
    names: dict[str, str] = {}
    skipped_geo = 0
    skipped_ts = 0
    total = 0

    print("Downloading / reading WildChat-1M parquet shards (country, timestamp)...", flush=True)
    for i in range(14):
        fname = f"data/train-{i:05d}-of-00014.parquet"
        print(f"  shard {i + 1}/14 {fname}", flush=True)
        path = hf_hub_download(
            repo_id="allenai/WildChat-1M",
            repo_type="dataset",
            filename=fname,
        )
        table = pq.read_table(path, columns=["country", "timestamp"])
        # Avoid pyarrow→zoneinfo (often missing on Windows): cast to int64 us.
        ts_col = table.column("timestamp").cast("int64")
        countries = table.column("country").to_pylist()
        timestamps_us = ts_col.to_pylist()
        for country, us in zip(countries, timestamps_us):
            total += 1
            if us is None:
                skipped_ts += 1
                continue
            try:
                dt = datetime.fromtimestamp(int(us) / 1_000_000, tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                skipped_ts += 1
                continue
            # Boom-era fill only: stop before OWID H1 2025 (2025-06-30 wave).
            if dt.year >= 2025:
                continue
            iso3 = resolve_iso3(str(country) if country is not None else "", by_lower)
            if not iso3:
                skipped_geo += 1
                continue
            qe = quarter_end(dt).isoformat()
            counts[(iso3, qe)] += 1
            if iso3 not in names:
                names[iso3] = str(country).strip()

    # Period totals for corpus share
    period_totals: Counter[str] = Counter()
    for (_iso3, qe), n in counts.items():
        period_totals[qe] += n

    rows_out: list[dict[str, object]] = []
    for (iso3, qe), n in sorted(counts.items(), key=lambda x: (x[0][1], x[0][0])):
        tot = period_totals[qe]
        if tot <= 0:
            continue
        share = round(100.0 * n / tot, 4)
        rows_out.append(
            {
                "iso3": iso3,
                "country_name": names.get(iso3, iso3),
                "quarter_end": qe,
                "conversations": n,
                "corpus_share_pct": share,
            }
        )

    with RAW_OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "iso3",
                "country_name",
                "quarter_end",
                "conversations",
                "corpus_share_pct",
            ],
        )
        w.writeheader()
        w.writerows(rows_out)

    print(
        f"Wrote {RAW_OUT.name}: {len(rows_out)} country-quarter rows "
        f"from {total} conversations "
        f"(skipped geo={skipped_geo}, ts={skipped_ts}; "
        f"periods={sorted(period_totals)})",
        flush=True,
    )
    print("Next: node scripts/join-owid-ai-conversation-growth.mjs", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
