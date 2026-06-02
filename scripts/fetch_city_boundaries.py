import time
import json
import re
from pathlib import Path
from urllib import request, parse

CITY_QUERIES = [
    ('san francisco', 'San Francisco, California, USA', 'USA'),
    ('new york', 'New York, New York, USA', 'USA'),
    ('london', 'London, UK', 'UK'),
    ('paris', 'Paris, France', 'France'),
    ('tokyo', 'Tokyo, Japan', 'Japan'),
    ('beijing', 'Beijing, China', 'China'),
    ('mumbai', 'Mumbai, India', 'India'),
    ('delhi', 'Delhi, India', 'India'),
    ('sydney', 'Sydney, Australia', 'Australia'),
    ('singapore', 'Singapore, Singapore', 'Singapore'),
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
    return re.sub(r'"([A-Za-z0-9_\- ]+)"(?=\s*:)', r'\1', text)


def normalize_feature(result, key, country):
    geojson = result.get('geojson')
    if geojson is None:
        raise RuntimeError(f'Missing geojson for {key}')
    if geojson['type'] not in ('Polygon', 'MultiPolygon'):
        raise RuntimeError(f'Unexpected geojson type {geojson[