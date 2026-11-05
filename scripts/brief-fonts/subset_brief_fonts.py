# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.68.0", "brotli==1.2.1", "uharfbuzz==0.57.0"]
# ///
"""Self-hosted, slimmed copies of the brief magazine's Google Fonts.

Run by hand through `npm run brief-fonts:subset` (scripts/brief-fonts/run.mjs), which renders
sample briefs, records what they use, and calls this script. See scripts/brief-fonts/README.md.

Google serves each face as several files split by `unicode-range` (latin, latin-ext, cyrillic,
...), and serves different files per platform: Windows and Linux get hinted IBM Plex Mono and a
small `prep` table, Chrome on macOS gets italics with overlap flags, Safari and Firefox on macOS
get those italics as WOFF, Android and iOS get neither. This script keeps that structure exactly:
one output per Google file per platform, with the same glyphs, outlines, flags and hinting. It
only removes what the brief never uses:

- variable axes pinned when the brief renders a single instance and pinning is exact;
- OpenType features the brief never turns on (figure styles, locl);
- characters a file covers but never draws, because a higher-priority file draws them.
  Characters no file of the face has keep Google's ranges: Chrome renders some of them
  (U+2011) differently once they leave every range.

It refuses to write output if any glyph outline, flag, instruction or advance differs from the
Google file at the rendered weight, or if HarfBuzz shapes any sample text differently.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

from fontTools import subset as ftsubset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import OverlapMode, instantiateVariableFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT_DIR = ROOT / 'public' / 'assets' / 'brief-fonts'
URL_PREFIX = '/assets/brief-fonts/'
MODULE = ROOT / 'server' / '_shared' / 'brief-fonts.generated.js'
MANIFEST = HERE / 'manifest.json'
SNAPSHOT = HERE / 'google-fonts-snapshot.json'
CACHE = ROOT / 'node_modules' / '.cache' / 'brief-fonts'

# The stylesheet the brief loaded from Google before self-hosting. Only --refresh-google-snapshot reads it.
GOOGLE_CSS = ('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400'
              '&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap')

# One User-Agent per group of browsers Google serves different font data or formats to. The
# server picks the group with briefFontPlatform() in server/_shared/brief-font-platform.js.
PLATFORMS = {
    'apple-woff2': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'apple-woff': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'hinted': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'plain': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
}

GF_RAW = 'https://raw.githubusercontent.com/google/fonts/{commit}/{path}'
FAMILIES = {
    # `rename`: the internal name of the modified files. Playfair Display and IBM Plex carry an OFL
    # Reserved Font Name; Source Serif 4's embedded copyright claims "Source" as one too.
    'Playfair Display': {'slug': 'playfair-display', 'rename': 'WM Brief Display', 'rfn': ['Playfair'],
                         'license': ('ofl/playfairdisplay/OFL.txt', '1e1aa08e994ff7db50116e86ccc7b52a4e4ae5b8',
                                     '566be814f8e96e93dfa16101331557eb6b5467e9e03f627c0910fe93ca12300e')},
    'Source Serif 4': {'slug': 'source-serif-4', 'rename': 'WM Brief Text', 'rfn': ['Source'],
                       'license': ('ofl/sourceserif4/OFL.txt', '01aa15d05749e35be9167f3f44e6a243f00cd2fc',
                                   '5f94c3fd3a23131a417ab5a0c8452de57e70c3cfb9f604d88241f7065ebf9fd9')},
    'IBM Plex Mono': {'slug': 'ibm-plex-mono', 'rename': 'WM Brief Mono', 'rfn': ['Plex'],
                      'license': ('ofl/ibmplexmono/OFL.txt', '465b90c97b4de569e0b546bb2536900194cf7187',
                                  '7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da')},
}

# Features Chromium applies to horizontal text without being asked. HarfBuzz turns on `frac`,
# `numr` and `dnom` by itself around U+2044 FRACTION SLASH, so "1⁄2" needs them. `locl` is left out:
# the brief is always lang="en", so language-specific forms never apply (the shaping check confirms it).
DEFAULT_FEATURES = {'ccmp', 'rlig', 'rvrn', 'mark', 'mkmk', 'kern', 'calt', 'clig', 'liga', 'rclt',
                    'curs', 'dist', 'abvm', 'blwm', 'abvs', 'blws', 'psts', 'pres', 'frac', 'numr', 'dnom'}
STYLE_ITALIC = {'normal': False, 'italic': True}


def log(*a):
    print('[brief-fonts]', *a, file=sys.stderr)


def fetch(url: str, sha256: str | None = None, headers: dict | None = None, fresh: bool = False) -> bytes:
    """Download url through the local cache. fresh=True ignores the cache (snapshot refreshes)."""
    key = hashlib.sha256((url + json.dumps(headers or {}, sort_keys=True)).encode()).hexdigest()[:24]
    cached = CACHE / key
    ok = lambda d: not sha256 or hashlib.sha256(d).hexdigest() == sha256
    if cached.exists() and not fresh:
        data = cached.read_bytes()
        if ok(data):
            return data
        cached.unlink()
    req = urllib.request.Request(url, headers={'User-Agent': 'worldmonitor-brief-fonts', **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if not ok(data):
        raise SystemExit(f'sha256 mismatch for {url}')
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(data)
    return data


def parse_unicode_range(s: str) -> set[int]:
    out: set[int] = set()
    for part in s.split(','):
        part = part.strip().upper().removeprefix('U+')
        if not part:
            continue
        a, _, b = part.partition('-')
        out.update(range(int(a, 16), int(b or a, 16) + 1))
    return out


def format_unicode_range(cps) -> str:
    cps = sorted(cps)
    out, i = [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        out.append(f'U+{cps[i]:X}' if i == j else f'U+{cps[i]:X}-{cps[j]:X}')
        i = j + 1
    return ', '.join(out)


# ---------------------------------------------------------------- Google snapshot

def refresh_google_snapshot():
    snap = {'css_url': GOOGLE_CSS, 'platforms': {}}
    for platform, ua in PLATFORMS.items():
        css = fetch(GOOGLE_CSS, headers={'User-Agent': ua}, fresh=True).decode()
        faces = {}
        for m in re.finditer(r'/\* ([\w-]+) \*/\s*@font-face \{(.*?)\}', css, re.S):
            subset_name, body = m.groups()
            fam = re.search(r"font-family: '([^']+)'", body).group(1)
            style = re.search(r'font-style: (\w+)', body).group(1)
            weight = int(re.search(r'font-weight: (\d+)', body).group(1))
            url = re.search(r'url\(([^)]+)\)', body).group(1)
            fmt = re.search(r"format\('(\w+)'\)", body).group(1)
            data = fetch(url, headers={'User-Agent': ua}, fresh=True)
            face = faces.setdefault(f'{fam}|{style}|{weight}', {'family': fam, 'style': style, 'weight': weight,
                                                                 'display': re.search(r'font-display: (\w+)', body).group(1),
                                                                 'subsets': []})
            face['subsets'].append({'name': subset_name, 'url': url, 'format': fmt,
                                    'sha256': hashlib.sha256(data).hexdigest(),
                                    'unicode_range': re.search(r'unicode-range: ([^;]+);', body).group(1)})
        snap['platforms'][platform] = {'user_agent': ua, 'faces': list(faces.values())}
    SNAPSHOT.write_text(json.dumps(snap, indent=2) + '\n')
    log('wrote', SNAPSHOT)


# ---------------------------------------------------------------- font helpers

def load(data: bytes) -> TTFont:
    return TTFont(io.BytesIO(data))


def font_bytes(font: TTFont, flavor: str | None) -> bytes:
    font.flavor = flavor
    font.recalcTimestamp = False  # deterministic output
    font.recalcBBoxes = False     # keep Google's head bbox; CoreText rasterization depends on it
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def chrome_partition(subset_fonts: list[tuple[str, set[int], TTFont]]) -> dict[int, str]:
    """Which file draws each character. Chrome tries a family's faces in reverse declaration
    order, so a later @font-face wins wherever unicode-ranges overlap."""
    part: dict[int, str] = {}
    for name, rng, font in reversed(subset_fonts):
        for cp in rng & set(font.getBestCmap()):
            part.setdefault(cp, name)
    return part


def glyph_record(font: TTFont, name: str, by_gid: bool = False):
    """Everything about a glyph that reaches a rasterizer. Components are named, or numbered with
    by_gid=True when the two fonts being compared derive different glyph names."""
    g = font['glyf'][name]
    g.expand(font['glyf'])
    rec = {'advance': font['hmtx'][name]}
    if g.isComposite():
        rec['components'] = [(font.getGlyphID(c.glyphName) if by_gid else c.glyphName, c.x, c.y, c.flags,
                              str(getattr(c, 'transform', None))) for c in g.components]
    else:
        coords, ends, flags = g.getCoordinates(font['glyf']) if g.numberOfContours else ([], [], [])
        rec['coords'] = list(coords)
        rec['ends'] = list(ends)
        rec['flags'] = list(flags)
    rec['program'] = g.program.getBytecode() if hasattr(g, 'program') and g.program else b''
    return rec


def outline(glyphset, name):
    pen = DecomposingRecordingPen(glyphset)
    glyphset[name].draw(pen)
    return pen.value


# Name IDs that state copyright, trademark, vendor, designer and licence. They keep the original
# wording; every other record is a font name and must not carry a Reserved Font Name.
LEGAL_NAME_IDS = {0, 7, 8, 9, 10, 11, 12, 13, 14}


def rename(font: TTFont, old: str, new: str, rfn: list[str]):
    for rec in font['name'].names:
        if rec.nameID in LEGAL_NAME_IDS:
            continue
        text = rec.toUnicode().replace(old, new).replace(old.replace(' ', ''), new.replace(' ', ''))
        rec.string = text
    left = [(r.nameID, r.toUnicode()) for r in font['name'].names
            if r.nameID not in LEGAL_NAME_IDS and any(t in r.toUnicode() for t in rfn)]
    if left:
        raise SystemExit(f'{old!r}: Reserved Font Name still present in {left}')


# ---------------------------------------------------------------- shaping check

class Shaper:
    def __init__(self, data: bytes, wght: int | None):
        import uharfbuzz as hb
        self.hb = hb
        tt = load(data)
        # HarfBuzz reads only uncompressed sfnt data: handed WOFF/WOFF2 it maps every character to
        # .notdef, and both sides of a comparison then agree. Decompress, then prove it reads glyphs.
        raw = io.BytesIO()
        flavor, tt.flavor = tt.flavor, None
        tt.save(raw, reorderTables=False)
        tt.flavor = flavor
        self.font = hb.Font(hb.Face(raw.getvalue()))
        probe = next(iter(tt.getBestCmap()))
        if self.font.get_nominal_glyph(probe) in (None, 0):
            raise SystemExit(f'HarfBuzz cannot read glyphs from this font (U+{probe:04X} maps to .notdef)')
        if 'fvar' in tt and wght is not None:
            self.font.set_variations({'wght': wght})
        self.glyphset = tt.getGlyphSet(location={'wght': wght} if 'fvar' in tt and wght is not None else None)
        self.order = tt.getGlyphOrder()
        self.sig = {}

    def shape(self, text: str):
        buf = self.hb.Buffer()
        buf.add_str(text)
        buf.language = 'en'
        buf.guess_segment_properties()
        self.hb.shape(self.font, buf, {})
        out = []
        for i, p in zip(buf.glyph_infos, buf.glyph_positions):
            if i.codepoint not in self.sig:
                self.sig[i.codepoint] = repr(outline(self.glyphset, self.order[i.codepoint]))
            out.append((self.sig[i.codepoint], p.x_advance, p.y_advance, p.x_offset, p.y_offset))
        return out


def shaping_differences(runs: list[str], partition: dict[int, str], old: dict, new: dict) -> list[str]:
    """Split each run the way Chrome would (by which file draws each character) and shape every
    piece with Google's file and with ours."""
    bad = []
    for text in runs:
        pieces, cur, part = [], '', None
        for ch in text:
            p = partition.get(ord(ch))
            if p != part and cur:
                pieces.append((part, cur))
                cur = ''
            part, cur = p, cur + ch
        if cur:
            pieces.append((part, cur))
        for p, seg in pieces:
            if p is not None and old[p].shape(seg) != new[p].shape(seg):
                bad.append(seg[:80])
    return bad


# ---------------------------------------------------------------- build

def build(usage_path: Path, verify: bool):
    snap = json.loads(SNAPSHOT.read_text())
    usage = json.loads(usage_path.read_text())
    used_faces = {(f['family'], f['style'], f['weight']) for f in usage['faces']}
    runs_by_face = collections.defaultdict(set)
    for f in usage['faces']:
        runs_by_face[(f['family'], f['style'], f['weight'])].update(f['runs'])
    preload_faces = {(f['family'], f['style'], f['weight']) for f in usage['faces'] if f['on_first_page']}

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    staged: dict[str, bytes] = {}
    failures: list[str] = []
    manifest = {'note': 'Generated by scripts/brief-fonts/subset_brief_fonts.py. Do not edit.',
                'google_css': snap['css_url'], 'google_parity_checked': verify,
                'inputs': usage.get('inputs', {}), 'faces': {}, 'platforms': {}}
    module_platforms = {}
    built_cache: dict[tuple, tuple] = {}

    for platform, pdata in snap['platforms'].items():
        css, preloads, files_out = [], [], []
        covered = set()
        for face in pdata['faces']:
            key = (face['family'], face['style'], face['weight'])
            if key not in used_faces:
                continue
            covered.add(key)
            fam_cfg = FAMILIES[face['family']]
            ua = {'User-Agent': pdata['user_agent']}
            sources = [(s, load(fetch(s['url'], s['sha256'], ua))) for s in face['subsets']]
            partition = chrome_partition([(s['name'], parse_unicode_range(s['unicode_range']), f) for s, f in sources])
            draws = collections.defaultdict(set)
            for cp, name in partition.items():
                draws[name].add(cp)
            # A character inside a file's unicode-range that no file of the face has still renders
            # differently from one outside every range: Chrome draws U+2011 with the face's hyphen
            # only while it is in range. So those characters keep exactly Google's ranges.
            in_no_file = set().union(*(parse_unicode_range(s['unicode_range']) for s, _ in sources)) - set().union(
                *(set(f.getBestCmap()) for _, f in sources))
            ranges = {s['name']: draws.get(s['name'], set()) | (parse_unicode_range(s['unicode_range']) & in_no_file)
                      for s, _ in sources}
            wght = face['weight']
            features = None
            old_shapers, new_shapers = {}, {}
            face_files = []
            for s, src in sources:
                cps = draws.get(s['name'])
                if not cps:
                    if ranges[s['name']]:
                        failures.append(f'{platform} {key} {s["name"]}: draws nothing but its range has characters no file draws;'
                                        ' dropping it would change how Chrome falls back for them')
                    continue  # every character this file covers is drawn by a higher-priority file
                ext = 'woff' if s['format'] == 'woff' else 'woff2'
                cache_key = (s['sha256'], wght, tuple(sorted(cps)), ext)
                if cache_key not in built_cache:
                    built_cache[cache_key] = make(fetch(s['url'], s['sha256'], ua), cps, wght, fam_cfg, face['family'], ext,
                                                  verify, failures, f'{platform} {key} {s["name"]}')
                data, plan, features = built_cache[cache_key]
                digest = hashlib.sha256(data).hexdigest()[:10]
                fname = f"{fam_cfg['slug']}-{face['style']}{wght}-{s['name']}.{digest}.{ext}"
                staged[fname] = data
                face_files.append({'subset': s['name'], 'file': fname, 'bytes': len(data), 'format': ext,
                                   'unicode_range': format_unicode_range(ranges[s['name']]), 'google_bytes': len(fetch(s['url'], s['sha256'], ua)),
                                   'axes': plan})
                old_shapers[s['name']] = (lambda d=fetch(s['url'], s['sha256'], ua), w=wght: Shaper(d, w))
                new_shapers[s['name']] = (lambda d=data, w=wght: Shaper(d, w))
                css.append('@font-face{'
                           f"font-family:'{face['family']}';font-style:{face['style']};font-weight:{wght};"
                           f"font-display:{face['display']};src:url({URL_PREFIX}{fname}) format('{'woff2' if ext == 'woff2' else 'woff'}');"
                           f"unicode-range:{format_unicode_range(ranges[s['name']])}}}")
                if key in preload_faces and s['name'] == 'latin':
                    preloads.append({'href': URL_PREFIX + fname, 'type': f'font/{ext}'})
            if verify:
                runs = sorted(runs_by_face[key])
                # Every character each file draws, in order, so every glyph and adjacent pair is shaped.
                runs += [''.join(chr(c) for c in sorted(cps)) for cps in draws.values()]
                old = {k: v() for k, v in old_shapers.items()}
                new = {k: v() for k, v in new_shapers.items()}
                bad = shaping_differences(runs, partition, old, new)
                if bad:
                    failures.append(f'{platform} {key}: {len(bad)} text pieces shape differently from Google, e.g. {bad[:3]}')
            files_out.append({'family': face['family'], 'style': face['style'], 'weight': wght,
                              'features_kept': features, 'files': face_files,
                              'in_no_file_range': format_unicode_range(in_no_file)})
            manifest['faces'].setdefault(f"{face['family']} {face['style']} {wght}", {'preloaded': key in preload_faces})
        for fam, style, wght in sorted(used_faces - covered):
            failures.append(f'{platform}: the brief uses {fam} {style} {wght}, which the Google snapshot does not have;'
                            ' add it to GOOGLE_CSS and rerun with --refresh-google-snapshot')
        module_platforms[platform] = {'css': ''.join(css), 'preload': preloads}
        manifest['platforms'][platform] = {'user_agent': pdata['user_agent'], 'faces': files_out}

    # Fetched (and checked against their pinned hashes) before any committed file changes.
    licenses = {f"{cfg['slug']}-OFL.txt": fetch(GF_RAW.format(commit=cfg['license'][1], path=cfg['license'][0]), cfg['license'][2])
                for cfg in FAMILIES.values()}
    if failures:
        for f in failures:
            log('FAIL', f)
        raise SystemExit(1)

    # Only touch committed files once everything passed.
    for old in OUT_DIR.glob('*.woff*'):
        if old.name not in staged:
            old.unlink()
    for fname, data in staged.items():
        (OUT_DIR / fname).write_bytes(data)
    for fname, data in licenses.items():
        (OUT_DIR / fname).write_bytes(data)
    MODULE.write_text(
        '// Generated by scripts/brief-fonts/subset_brief_fonts.py (npm run brief-fonts:subset). Do not edit.\n'
        '// Per-platform @font-face rules and preloads for the brief magazine; see scripts/brief-fonts/README.md.\n'
        f'export const BRIEF_FONTS = {json.dumps(module_platforms, indent=2, ensure_ascii=True)};\n')
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    for platform, p in manifest['platforms'].items():
        total = sum(f['bytes'] for face in p['faces'] for f in face['files'])
        google = sum(f['google_bytes'] for face in p['faces'] for f in face['files'])
        log(f'{platform}: {total} B across all subsets (Google {google} B)')
    log('wrote', MODULE, MANIFEST, f'{len(staged)} font files')


def make(src_bytes: bytes, cps: set[int], wght: int, cfg: dict, family: str, ext: str, verify: bool, failures: list, label: str):
    """Slim one Google file: pin its axis when exact, drop unused features, keep everything a
    rasterizer reads exactly as Google served it. Returns the encoded file."""
    plan = 'static'
    font = load(src_bytes)
    if 'fvar' in font:
        axis = next(a for a in font['fvar'].axes if a.axisTag == 'wght')
        if axis.defaultValue == wght:
            # Pinning at the default location applies no deltas, so outlines are unchanged.
            font = instantiateVariableFont(font, {'wght': wght}, overlap=OverlapMode.KEEP_AND_DONT_SET_FLAGS)
            font = load(font_bytes(font, None))
            plan = f'wght pinned at its default, {wght}'
        else:
            plan = f'wght {axis.minValue:g}-{axis.maxValue:g} kept (rendered at {wght}, not the default; pinning would round outlines)'
    kept = sorted(DEFAULT_FEATURES & {fr.FeatureTag for t in ('GSUB', 'GPOS') if t in font for fr in font[t].table.FeatureList.FeatureRecord})
    opts = ftsubset.Options()
    opts.layout_features = kept
    opts.hinting = True
    opts.glyph_names = font['post'].formatType == 2.0
    opts.notdef_outline = True
    opts.name_IDs = ['*']
    opts.name_languages = ['*']
    opts.name_legacy = True
    opts.legacy_kern = True
    opts.drop_tables = ['DSIG']
    opts.recalc_bounds = False
    opts.recalc_timestamp = False
    opts.prune_unicode_ranges = False
    opts.prune_codepage_ranges = False
    sub = ftsubset.Subsetter(opts)
    sub.populate(unicodes=sorted(cps))
    sub.subset(font)
    rename(font, family, cfg['rename'], cfg['rfn'])
    data = font_bytes(font, ext)
    out = load(data)
    if set(out.getBestCmap()) != cps:
        failures.append(f'{label}: cmap changed: {format_unicode_range(set(out.getBestCmap()) ^ cps)}')
    if verify:
        # 1. Subsetting: compare each kept glyph with Google's by name. `font` is the in-memory
        #    subset, whose glyph names match the source even when the file stores none.
        ref = load(src_bytes)
        loc = {'wght': wght} if 'fvar' in ref else None
        ref_gs = ref.getGlyphSet(location=loc)
        new_gs = font.getGlyphSet(location=loc if 'fvar' in font else None)
        for name in font.getGlyphOrder():
            if outline(ref_gs, name) != outline(new_gs, name):
                failures.append(f'{label}: outline of {name} differs at wght {wght}')
                break
            a, b = glyph_record(ref, name), glyph_record(font, name)
            if 'fvar' in ref:
                a.pop('coords', None), b.pop('coords', None)  # compared through the outline at wght
                if 'fvar' not in font:
                    a.pop('advance'), b.pop('advance')
                    if ref_gs[name].width != new_gs[name].width:
                        failures.append(f'{label}: advance of {name} differs at wght {wght}')
                        break
            if a != b:
                failures.append(f'{label}: glyph data of {name} differs ({sorted(k for k in a if a.get(k) != b.get(k))})')
                break
        # 2. Encoding: the decoded file must hold exactly the in-memory glyphs, flags included
        #    (WOFF2 drops overlap flags unless it writes the overlap bitmap).
        for gid, name in enumerate(font.getGlyphOrder()):
            if glyph_record(font, name, True) != glyph_record(out, out.getGlyphOrder()[gid], True):
                failures.append(f'{label}: {ext} encoding changed glyph {name}')
                break
        # 3. Tables a rasterizer or line layout reads.
        for t in ('prep', 'fpgm', 'cvt ', 'gasp', 'VDMX'):
            if (t in ref) != (t in out) or (t in ref and ref.reader[t] != out.reader[t]):
                failures.append(f'{label}: table {t!r} changed')
        for tag, fields in (('head', ('xMin', 'yMin', 'xMax', 'yMax', 'unitsPerEm', 'flags')),
                            ('hhea', ('ascent', 'descent', 'lineGap')),
                            ('OS/2', ('sTypoAscender', 'sTypoDescender', 'sTypoLineGap', 'usWinAscent', 'usWinDescent', 'fsSelection'))):
            for field in fields:
                if getattr(ref[tag], field) != getattr(out[tag], field):
                    failures.append(f'{label}: {tag}.{field} changed')
    return data, plan, kept


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--usage', type=Path, help='usage written by run.mjs')
    ap.add_argument('--refresh-google-snapshot', action='store_true')
    ap.add_argument('--skip-google-parity', action='store_true', help='skip the outline and shaping comparison (offline)')
    a = ap.parse_args()
    if a.refresh_google_snapshot:
        refresh_google_snapshot()
    if a.usage:
        build(a.usage, not a.skip_google_parity)
