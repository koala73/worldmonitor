#!/usr/bin/env python3
"""
Pre-convert GEM GeoJSON (GGIT gas + GOIT oil pipelines) → canonical JSON shape
that scripts/import-gem-pipelines.mjs::REQUIRED_COLUMNS expects.

Why GeoJSON, not XLSX:
    GEM publishes both XLSX and GIS .zip downloads (with GeoJSON, GeoPackage,
    shapefile inside). The XLSX has properties but NO lat/lon columns — endpoint
    geometry only lives in the GIS feed. The GeoJSON `properties` block carries
    the same column set as the XLSX, AND `geometry.coordinates` gives us the
    LineString endpoints we need for haversine dedup. So we use GeoJSON only.

Usage:
    GEM_GAS_GEOJSON=/path/to/GEM-GGIT-Gas-Pipelines-YYYY-MM.geojson \\
    GEM_OIL_GEOJSON=/path/to/GEM-GOIT-Oil-NGL-Pipelines-YYYY-MM.geojson \\
    python3 scripts/_gem-geojson-to-canonical.py \\
        > /tmp/gem-pipelines.json

    # Then feed to the merge step:
    GEM_PIPELINES_FILE=/tmp/gem-pipelines.json node \\
        scripts/import-gem-pipelines.mjs --print-candidates  # dry run
    GEM_PIPELINES_FILE=/tmp/gem-pipelines.json node \\
        scripts/import-gem-pipelines.mjs --merge

Dependencies:
    pip3 install pycountry  # ISO 3166-1 alpha-2 mapping for country names

Drop-summary log goes to stderr; canonical JSON goes to stdout.
"""

import json
import os
import sys
import pycountry

GAS_PATH = os.environ.get("GEM_GAS_GEOJSON")
OIL_PATH = os.environ.get("GEM_OIL_GEOJSON")
if not GAS_PATH or not OIL_PATH:
    sys.exit(
        "GEM_GAS_GEOJSON and GEM_OIL_GEOJSON env vars are required. "
        "Point each at the GEM-{GGIT,GOIT}-{Gas,Oil-NGL}-Pipelines-YYYY-MM.geojson "
        "file unzipped from the GIS download. See script header for details."
    )

# Filter knobs (per plan: trunk-class only, target 250-300 entries per registry).
# Asymmetric thresholds: gas has more long-distance trunks worldwide (LNG-feeder
# corridors, Russia→Europe, Russia→China), oil pipelines tend to be shorter
# regional collectors. Tuned empirically against the 2025-11 GEM release to
# yield ~265 gas + ~300 oil after dedup against the 75 hand-curated rows.
MIN_LENGTH_KM_GAS = 750.0
MIN_LENGTH_KM_OIL = 400.0
ACCEPTED_STATUS = {"operating", "construction"}

# GEM (lowercase) → parser STATUS_MAP key (PascalCase)
STATUS_PASCAL = {
    "operating": "Operating",
    "construction": "Construction",
    "proposed": "Proposed",
    "cancelled": "Cancelled",
    "shelved": "Cancelled",  # treat shelved as cancelled per plan U2
    "mothballed": "Mothballed",
    "idle": "Idle",
    "shut-in": "Shut-in",
    "retired": "Mothballed",
    "mixed status": "Operating",  # rare; treat as operating
}

# Country aliases for cases pycountry's fuzzy match fails on
COUNTRY_ALIASES = {
    "United States": "US",
    "United Kingdom": "GB",
    "Russia": "RU",
    "South Korea": "KR",
    "North Korea": "KP",
    "Iran": "IR",
    "Syria": "SY",
    "Venezuela": "VE",
    "Bolivia": "BO",
    "Tanzania": "TZ",
    "Vietnam": "VN",
    "Laos": "LA",
    "Czech Republic": "CZ",
    "Czechia": "CZ",
    "Slovakia": "SK",
    "Macedonia": "MK",
    "North Macedonia": "MK",
    "Moldova": "MD",
    "Brunei": "BN",
    "Cape Verde": "CV",
    "Ivory Coast": "CI",
    "Cote d'Ivoire": "CI",
    "Republic of the Congo": "CG",
    "Democratic Republic of the Congo": "CD",
    "DR Congo": "CD",
    "DRC": "CD",
    "Congo": "CG",
    "Burma": "MM",
    "Myanmar": "MM",
    "Taiwan": "TW",
    "Palestine": "PS",
    "Kosovo": "XK",  # not ISO-2 official; use XK (commonly accepted)
}


def country_to_iso2(name):
    if not name:
        return None
    name = name.strip()
    if name in COUNTRY_ALIASES:
        return COUNTRY_ALIASES[name]
    try:
        c = pycountry.countries.get(name=name)
        if c:
            return c.alpha_2
        # Try common_name (e.g. "Russia" → "Russian Federation")
        c = pycountry.countries.get(common_name=name)
        if c:
            return c.alpha_2
        # Fuzzy
        results = pycountry.countries.search_fuzzy(name)
        if results:
            return results[0].alpha_2
    except (LookupError, KeyError):
        pass
    return None


def split_countries(s):
    """Parse 'Russia, Belarus, Ukraine' → ['Russia','Belarus','Ukraine']"""
    if not s:
        return []
    return [x.strip() for x in s.split(",") if x.strip()]


def get_endpoints(geom):
    """Return ((startLon, startLat), (endLon, endLat)) or None."""
    if not geom:
        return None
    t = geom.get("type")
    coords = geom.get("coordinates")
    if t == "LineString" and coords and len(coords) >= 2:
        return coords[0], coords[-1]
    if t == "MultiLineString" and coords:
        flat = [pt for line in coords if line for pt in line]
        if len(flat) >= 2:
            return flat[0], flat[-1]
    if t == "GeometryCollection":
        geoms = geom.get("geometries") or []
        all_coords = []
        for g in geoms:
            if g and g.get("type") == "LineString" and g.get("coordinates"):
                all_coords.extend(g["coordinates"])
            elif g and g.get("type") == "MultiLineString" and g.get("coordinates"):
                for line in g["coordinates"]:
                    all_coords.extend(line)
        if len(all_coords) >= 2:
            return all_coords[0], all_coords[-1]
    return None


def first_year(props):
    for k in ("StartYear1", "StartYear2", "StartYear3"):
        v = props.get(k)
        if v:
            try:
                return int(float(v))
            except (TypeError, ValueError):
                pass
    return 0


def best_length_km(props):
    for k in ("LengthMergedKm", "LengthKnownKm", "LengthEstimateKm"):
        v = props.get(k)
        if v in (None, "", "NA"):
            continue
        try:
            f = float(v)
            if f > 0:
                return f
        except (TypeError, ValueError):
            pass
    return 0.0


def _f(v):
    if v in (None, "", "NA"):
        return None
    try:
        f = float(v)
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def gas_capacity(props):
    """Return (capacity, 'bcm/y'). GGIT has CapacityBcm/y derived for many rows."""
    f = _f(props.get("CapacityBcm/y"))
    if f is not None:
        return f, "bcm/y"
    # Fall back to raw Capacity + CapacityUnits with conversions to bcm/y.
    cap = _f(props.get("Capacity"))
    if cap is None:
        return None, None
    u = (props.get("CapacityUnits") or "").strip().lower()
    if u == "bcm/y":
        return cap, "bcm/y"
    if u == "mmcf/d":  # million standard cubic feet/day → bcm/y
        return cap * 0.01034, "bcm/y"
    if u == "mmscmd":  # million standard cubic metres/day
        return cap * 365.25 / 1000.0, "bcm/y"
    if u == "mill.sm3/day":  # million Sm3/day = MMSCMD
        return cap * 365.25 / 1000.0, "bcm/y"
    if u == "scm/y":  # standard cubic metres/year
        return cap / 1e9, "bcm/y"
    if u == "mtpa":  # million tonnes/annum LNG → bcm/y (1 mtpa ≈ 1.36 bcm/y)
        return cap * 1.36, "bcm/y"
    return None, None


def oil_capacity(props):
    """Return (capacity, capacityUnit) for oil. Convert to bbl/d for parser
    consumption (parser then converts bbl/d / 1e6 → Mbd internally)."""
    cap = _f(props.get("Capacity"))
    unit_raw = (props.get("CapacityUnits") or "").strip().lower()
    if cap is None or not unit_raw:
        # Fallback: derive from CapacityBOEd if present (already bpd-equivalent).
        boed = _f(props.get("CapacityBOEd"))
        if boed is not None:
            return boed, "bbl/d"
        return None, None
    if unit_raw == "bpd":
        return cap, "bbl/d"
    if unit_raw in ("mb/d", "mbd"):
        # GEM "Mb/d" = thousand bbl/day (industry shorthand). Convert to bbl/d.
        return cap * 1000.0, "bbl/d"
    if unit_raw in ("kbd", "kb/d"):
        return cap * 1000.0, "bbl/d"
    if unit_raw == "mtpa":
        # Million tonnes/annum crude → bbl/d (avg crude: 7.33 bbl/tonne).
        return cap * 1e6 * 7.33 / 365.25, "bbl/d"
    if unit_raw == "m3/day":
        # 1 m3 = 6.2898 bbl
        return cap * 6.2898, "bbl/d"
    if unit_raw == "m3/month":
        return cap * 6.2898 / 30.4, "bbl/d"
    if unit_raw == "m3/year":
        return cap * 6.2898 / 365.25, "bbl/d"
    if unit_raw == "thousand m3/year":
        return cap * 1000 * 6.2898 / 365.25, "bbl/d"
    if unit_raw == "tn/d":  # tonnes/day
        return cap * 7.33, "bbl/d"
    # Unknown unit → fall back to BOEd if available.
    boed = _f(props.get("CapacityBOEd"))
    if boed is not None:
        return boed, "bbl/d"
    return None, None


def convert_one(props, geom, fuel_token):
    name = (props.get("PipelineName") or "").strip()
    seg = (props.get("SegmentName") or "").strip()
    if seg and seg.lower() not in ("main line", "mainline", "main"):
        name = f"{name} - {seg}" if name else seg
    if not name:
        return None, "no_name"

    status = (props.get("Status") or "").strip().lower()
    if status not in ACCEPTED_STATUS:
        return None, f"status:{status or 'empty'}"

    pts = get_endpoints(geom)
    if not pts:
        return None, "no_geom"
    s_lon, s_lat = pts[0][0], pts[0][1]
    e_lon, e_lat = pts[1][0], pts[1][1]
    # Drop degenerate geometry (start == end). GEM occasionally publishes
    # rows with a Point geometry or a single-coord LineString, which we'd
    # otherwise emit as zero-length routes. PR #3406 review found 9 such
    # rows (Trans-Alaska, Enbridge Line 3 Replacement, Ichthys, etc.).
    if s_lat == e_lat and s_lon == e_lon:
        return None, "zero_length"

    length = best_length_km(props)
    threshold = MIN_LENGTH_KM_GAS if fuel_token == "Gas" else MIN_LENGTH_KM_OIL
    if length < threshold:
        return None, "too_short"

    if fuel_token == "Gas":
        cap, unit = gas_capacity(props)
        from_country_name = props.get("StartCountryOrArea")
        to_country_name = props.get("EndCountryOrArea")
        all_countries = split_countries(props.get("CountriesOrAreas"))
    else:
        cap, unit = oil_capacity(props)
        from_country_name = props.get("StartCountry")
        to_country_name = props.get("EndCountry")
        all_countries = split_countries(props.get("Countries"))
    if cap is None or unit is None:
        return None, "no_capacity"

    from_iso = country_to_iso2(from_country_name)
    to_iso = country_to_iso2(to_country_name)
    if not from_iso or not to_iso:
        return None, f"country:{from_country_name}|{to_country_name}"

    transit = []
    for c in all_countries:
        iso = country_to_iso2(c)
        if iso and iso != from_iso and iso != to_iso:
            transit.append(iso)

    operator = (props.get("Owner") or props.get("Parent") or "").strip()
    if not operator:
        operator = "Unknown"

    row = {
        "name": name,
        "operator": operator,
        "fuel": fuel_token,
        "fromCountry": from_iso,
        "toCountry": to_iso,
        "transitCountries": transit,
        "capacity": cap,
        "capacityUnit": unit,
        "lengthKm": length,
        "status": STATUS_PASCAL.get(status, "Operating"),
        "startLat": s_lat,
        "startLon": s_lon,
        "endLat": e_lat,
        "endLon": e_lon,
        "startYear": first_year(props),
    }
    return row, None


def process(path, fuel_token, drops):
    with open(path) as f:
        gj = json.load(f)
    out = []
    for ft in gj["features"]:
        props = ft.get("properties") or {}
        geom = ft.get("geometry")
        row, reason = convert_one(props, geom, fuel_token)
        if row:
            out.append(row)
        else:
            drops[reason] = drops.get(reason, 0) + 1
    return out


def main():
    drops_gas, drops_oil = {}, {}
    gas_rows = process(GAS_PATH, "Gas", drops_gas)
    oil_rows = process(OIL_PATH, "Oil", drops_oil)

    # The operator stamps `downloadedAt` and `sourceVersion` per release so
    # the parser's deterministic-timestamp logic (resolveEvidenceTimestamp in
    # scripts/import-gem-pipelines.mjs) produces a stable lastEvidenceUpdate
    # tied to the actual download date — not "now". Override via env so the
    # script doesn't drift across re-runs.
    downloaded_at = os.environ.get("GEM_DOWNLOADED_AT", "1970-01-01")
    source_version = os.environ.get("GEM_SOURCE_VERSION", "GEM-unspecified-release")
    envelope = {
        "downloadedAt": downloaded_at,
        "sourceVersion": source_version,
        "pipelines": gas_rows + oil_rows,
    }
    json.dump(envelope, sys.stdout, indent=2, ensure_ascii=False)

    print("\n--- DROP SUMMARY (gas) ---", file=sys.stderr)
    for k, v in sorted(drops_gas.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}", file=sys.stderr)
    print(f"  KEPT: {len(gas_rows)}", file=sys.stderr)
    print("--- DROP SUMMARY (oil) ---", file=sys.stderr)
    for k, v in sorted(drops_oil.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}", file=sys.stderr)
    print(f"  KEPT: {len(oil_rows)}", file=sys.stderr)


if __name__ == "__main__":
    main()
