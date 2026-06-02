import time
import json
import re
from pathlib import Path
from urllib import request, parse

CITY_QUERIES = [
    ('san francisco', ['San Francisco, California, USA'], 'USA'),
    ('new york', ['New York, New York, USA'], 'USA'),
    ('london', ['London, UK'], 'UK'),
    ('paris', ['Paris, France'], 'France'),
    ('tokyo', ['Tokyo, Japan'], 'Japan'),
    ('beijing', ['Beijing, China'], 'China'),
    ('mumbai', ['Mumbai, India', 'Mumbai Suburban District, Maharashtra, India', 'Mumbai Metropolitan Region, Maharashtra, India'], 'India'),
    ('delhi', ['Delhi, India'], 'India'),
    ('sydney', ['Sydney, Australia'], 'Australia'),
    ('singapore', ['Singapore, Singapore'], 'Singapore'),
]

USER_AGENT = 'worldmonitor-city-boundary-fetcher/1.0 (https://github.com/worldmonitor/worldmonitor)'
OUT_FILE = Path('api/data/city-boundaries.ts')


def title_case(value):
    return re.sub(r"\b([a-z])", lambda m: m.group(1).upper(), value)


def fetch_json(url):
    req = request.Request(url, headers={'User-Agent': USER_AGENT})
    with request.urlopen(req, timeout=30) as resp:
        if resp.status != 200:
            raise RuntimeError(f'Fetch failed {resp.status}: {resp.reason}')
        return json.load(resp)


def to_ts_literal(value, indent=2):
    text = json.dumps(value, ensure_ascii=False, indent=indent)
    return re.sub(r'"([A-Za-z_$][A-Za-z0-9_$]*)"(?=\s*:)', r'\1', text)


def normalize_feature(result, key, country):
    geojson = result.get('geojson')
    if geojson is None:
        raise RuntimeError(f'Missing geojson for {key}')
    if geojson['type'] not in ('Polygon', 'MultiPolygon'):
        raise RuntimeError(f'Unexpected geojson type {geojson["type"]} for {key}')
    return {
        'type': 'Feature',
        'properties': {
            'city': title_case(key),
            'country': country,
        },
        'geometry': geojson,
    }


def find_polygon_feature(results, key):
    if not isinstance(results, list):
        raise RuntimeError(f'Unexpected search result format for {key}')
    for result in results:
        geojson = result.get('geojson')
        if geojson and geojson.get('type') in ('Polygon', 'MultiPolygon'):
            return result
    raise RuntimeError(f'No polygon boundary found for {key}')


def main():
    features = {}

    for key, queries, country in CITY_QUERIES:
        print(f'Fetching boundary for {key}...')
        result = None
        for query in queries:
            print(f'  trying query: {query}')
            params = {
                'q': query,
                'format': 'json',
                'polygon_geojson': '1',
                'limit': '10',
                'addressdetails': '0',
            }
            url = 'https://nominatim.openstreetmap.org/search?' + parse.urlencode(params)
            data = fetch_json(url)

            if not data or not isinstance(data, list):
                continue

            try:
                result = find_polygon_feature(data, key)
                break
            except RuntimeError:
                continue

        if result is None:
            raise RuntimeError(f'No polygon boundary found for {key}')

        feature = normalize_feature(result, key, country)
        features[key] = feature
        time.sleep(1.1)

    ts_source = 'export const CITY_BOUNDARIES: Record<string, GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>> = ' + to_ts_literal(features, 2) + ';\n'
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(ts_source, encoding='utf-8')
    print(f'Wrote {OUT_FILE}')


if __name__ == '__main__':
    main()
