"""Replay adsb.lol archive days into the 5-minute air traffic series.

  python3 -I scripts/air-traffic-archive-extract.py day 2026.11.13 OUT_DIR [--dump-bin HH:MM]
      Streams one day from adsblol/globe_history_2026 (3.5 to 4 GB, never
      written to disk) and writes OUT_DIR/2026.11.13.json: the point
      aggregateStates (scripts/shared/air-traffic-aggregate.cjs) would produce
      from a snapshot at each bin start. A snapshot at bin T holds each
      aircraft's latest trace point in (T-60s, T]. --dump-bin also writes that
      bin's rows as OpenSky state rows, to check against aggregateStates.
  python3 -I scripts/air-traffic-archive-extract.py fixture OUT_DIR FIXTURE.json.gz
      Packs the extracted days into the detector replay fixture
      (tests/fixtures/air-traffic-archive-series.json.gz).
"""
import gzip, io, json, math, os, re, subprocess, sys, tarfile, time
AIRLINE = re.compile(r'^[A-Z]{3}[0-9]')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def build_fixture(src, out):
    import glob
    days = {}
    for f in sorted(glob.glob(os.path.join(src, '20*.json'))):
        if 'rows' in f:
            continue
        d = json.load(open(f))
        # A bin with under 1,000 states is an archive hole (and the 00:00 bin
        # misses the minute before midnight); the relay would store a gap.
        days[d['day'].replace('.', '-')] = [[p['usSeen'], p['euAirborne'], p['usLowClimbingAirline']]
                                            if p['statesTotal'] >= 1000 else None for p in d['points']]
    doc = {'source': 'adsblol/globe_history_2026 prod releases via scripts/air-traffic-archive-extract.py',
           'fields': ['usSeen', 'euAirborne', 'usLowClimbingAirline'], 'days': days}
    with gzip.GzipFile(out, 'wb', mtime=0) as g:
        g.write(json.dumps(doc, separators=(',', ':')).encode())
    print(len(days), 'days ->', out)


if sys.argv[1:2] == ['fixture']:
    build_fixture(sys.argv[2], sys.argv[3])
    sys.exit(0)
if sys.argv[1:2] != ['day']:
    sys.exit(__doc__)
del sys.argv[1]

# The regions and thresholds come from the relay's own modules.
R = json.loads(subprocess.check_output(['node', '-e', """
const r = require('./scripts/shared/air-traffic-regions.cjs');
const a = require('./scripts/shared/air-traffic-aggregate.cjs');
console.log(JSON.stringify({ US_HUBS: r.US_HUBS, HUB_RADIUS_KM: r.HUB_RADIUS_KM, CONUS_BOX: r.CONUS_BOX,
  EUROPE_BOX: r.EUROPE_BOX, LOW_ALTITUDE_M: a.LOW_ALTITUDE_M }));
"""], cwd=REPO))
CONUS, EU = R['CONUS_BOX'], R['EUROPE_BOX']
LOW_M = R['LOW_ALTITUDE_M']
HUB_KM = R['HUB_RADIUS_KM']
HUBS = [(h['iata'], math.radians(h['lat']), math.radians(h['lon']), math.cos(math.radians(h['lat']))) for h in R['US_HUBS']]
HUB_SPAN_DEG = HUB_KM / 6371 * 180 / math.pi
FT = 0.3048
MAX_AGE = 60
BIN = 300

day, out_dir = sys.argv[1], sys.argv[2]
dump_bin = sys.argv[sys.argv.index('--dump-bin') + 1] if '--dump-bin' in sys.argv else None
y, m, d = (int(x) for x in day.split('.'))
import calendar
day0 = calendar.timegm((y, m, d, 0, 0, 0))
bins = [day0 + i * BIN for i in range(288)]


def in_box(lat, lon, b):
    return b['south'] <= lat <= b['north'] and b['west'] <= lon <= b['east']


def empty():
    return {'usSeen': 0, 'usAirborne': 0, 'usLowClimbing': 0, 'euAirborne': 0, 'statesTotal': 0,
            'usAirborneAirline': 0, 'usLowClimbingAirline': 0, 'euAirborneAirline': 0,
            'hubs': {h[0]: {'air': 0, 'ground': 0, 'climb': 0, 'climbAirline': 0, 'groundAirline': 0} for h in HUBS}}


acc = [empty() for _ in bins]
dumped = []
dump_idx = None
if dump_bin:
    hh, mm = (int(x) for x in dump_bin.split(':'))
    dump_idx = (hh * 3600 + mm * 60) // BIN


def add(i, row):
    # row = (lat, lon, on_ground, alt_m, vrate_ms)
    lat, lon, ground, alt, vr, cs = row
    airline = bool(cs and AIRLINE.match(cs))
    climbing = (not ground) and alt is not None and alt < LOW_M and vr is not None and vr > 0
    a = acc[i]
    a['statesTotal'] += 1
    if in_box(lat, lon, EU):
        if not ground:
            a['euAirborne'] += 1
            if airline:
                a['euAirborneAirline'] += 1
        return
    if not in_box(lat, lon, CONUS):
        return
    a['usSeen'] += 1
    if not ground:
        a['usAirborne'] += 1
        if airline:
            a['usAirborneAirline'] += 1
        if climbing:
            a['usLowClimbing'] += 1
            if airline:
                a['usLowClimbingAirline'] += 1
    la, lo = math.radians(lat), math.radians(lon)
    cl = math.cos(la)
    for iata, hl, hlo, hc in HUBS:
        if abs(la - hl) * 180 / math.pi > HUB_SPAN_DEG:
            continue
        h = math.sin((la - hl) / 2) ** 2 + hc * cl * math.sin((lo - hlo) / 2) ** 2
        if 2 * 6371 * math.asin(min(1, math.sqrt(h))) <= HUB_KM:
            hb = a['hubs'][iata]
            hb['ground' if ground else 'air'] += 1
            if climbing:
                hb['climb'] += 1
                if airline:
                    hb['climbAirline'] += 1
            if ground and airline:
                hb['groundAirline'] += 1


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


base = f'https://github.com/adsblol/globe_history_2026/releases/download/v{day}-planes-readsb-prod-0/v{day}-planes-readsb-prod-0.tar'
# Days split into two or three parts; stop at the first part that does not exist.
cmd = f'for s in aa ab ac ad ae; do curl -sfL --retry 5 --retry-delay 5 "{base}.$s" || break; done'
proc = subprocess.Popen(['/bin/sh', '-c', cmd], stdout=subprocess.PIPE, bufsize=1 << 20)
t0 = time.time()
n = 0
with tarfile.open(fileobj=proc.stdout, mode='r|') as tar:
    for member in tar:
        if not member.isfile() or 'trace_full_' not in member.name:
            continue
        raw = tar.extractfile(member).read()
        try:
            doc = json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
        except Exception:
            continue
        n += 1
        ts0 = doc.get('timestamp')
        trace = doc.get('trace') or []
        if not isinstance(ts0, (int, float)) or not trace:
            continue
        # Walk the trace once, keeping each bin's latest point inside its window.
        bi = 0
        latest = None
        # A trace names its flight only on some points; use the first name for
        # the points before it, so a departure counts from its first point.
        cs = next((q[8]['flight'].strip() for q in trace if len(q) > 8 and isinstance(q[8], dict)
                   and isinstance(q[8].get('flight'), str) and q[8]['flight'].strip()), None)
        for p in trace:
            t = ts0 + p[0]
            while bi < len(bins) and bins[bi] < t:
                if latest is not None and bins[bi] - latest[0] <= MAX_AGE:
                    add(bi, latest[1])
                    if bi == dump_idx:
                        dumped.append(latest[2])
                bi += 1
            if bi >= len(bins):
                break
            lat, lon = num(p[1]), num(p[2])
            if lat is None or lon is None:
                continue
            alt_raw = p[3]
            ground = alt_raw == 'ground'
            alt = None if ground else (num(alt_raw) * FT if num(alt_raw) is not None else None)
            if alt is None and not ground and len(p) > 10 and num(p[10]) is not None:
                alt = num(p[10]) * FT
            det = p[8] if len(p) > 8 and isinstance(p[8], dict) else None
            if det and isinstance(det.get('flight'), str) and det['flight'].strip():
                cs = det['flight'].strip()
            vr = num(p[7]) if len(p) > 7 else None
            vr_ms = vr * FT / 60 if vr is not None else None
            gs = num(p[4]) if len(p) > 4 else None
            latest = (t, (lat, lon, ground, alt, vr_ms, cs),
                      [doc.get('icao'), cs, None, None, None, lon, lat, alt if not ground else None, ground,
                       gs * 0.514444 if gs is not None else None, None, vr_ms, None, None])
        # Bins at or after the last point (trace ended inside the day).
        while bi < len(bins):
            if latest is not None and 0 <= bins[bi] - latest[0] <= MAX_AGE:
                add(bi, latest[1])
                if bi == dump_idx:
                    dumped.append(latest[2])
            elif latest is not None and bins[bi] - latest[0] > MAX_AGE:
                break
            bi += 1
proc.wait()
if proc.returncode not in (0, None):
    sys.exit(f'download failed rc={proc.returncode}')
points = [{'t': b * 1000, 'status': 'ok', **acc[i]} for i, b in enumerate(bins)]
os.makedirs(out_dir, exist_ok=True)
json.dump({'day': day, 'source': f'adsblol/globe_history_2026 v{day}-planes-readsb-prod-0', 'aircraft': n, 'points': points},
          open(os.path.join(out_dir, f'{day}.json'), 'w'))
if dump_bin:
    json.dump(dumped, open(os.path.join(out_dir, f'{day}-bin-{dump_bin.replace(":", "")}-rows.json'), 'w'))
print(day, 'aircraft', n, 'seconds', round(time.time() - t0), flush=True)
