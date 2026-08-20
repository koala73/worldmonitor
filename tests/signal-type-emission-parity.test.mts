import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Why this test exists (#6422)
// ---------------------------------------------------------------------------
//
// `docs/algorithms.mdx` published "14 signal types are continuously evaluated"
// while three of the fourteen had no emitter at all: `news_leads_markets`,
// `sector_cascade` and `hotspot_escalation` existed only as union members,
// display copy, emoji, labels and locale strings. Nothing constructed them, so
// they could not be evaluated, deduplicated or surfaced.
//
// The repository already solved this exact problem one section earlier in the
// same document. `tests/breaking-alert-doc-contract.test.mjs` derives the wired
// `BreakingAlert` origins from their emit sites and deepEquals them against the
// documented table, and the "Breaking News Alert Pipeline" section says outright
// that "reserved names in the `BreakingAlert` origin type do not make them
// active producers". The cross-stream correlation table never got that
// treatment, which is why its count drifted unnoticed.
//
// `tests/docs-signal-alignment.test.mts` does not close this: it compares the
// union's SIZE to what the docs claim to list, never to whether anything emits.
// A declared-but-unemitted type keeps that test green forever.
//
// This guard fails when a member of the correlation `SignalType` union has no
// emit site under `src/` or `shared/` and is not on an explicit allowlist that
// records a reason and a disposition — and, symmetrically, when an allowlisted
// type acquires an emitter without the allowlist and the public docs being
// updated to match.
//
// Documented limitation: the emit scan requires a quoted literal, so a
// correlation signal built with a computed `type` would read as unemitted. No
// such emitter exists today (all eleven use literals), and the failure mode is
// the conservative one — it demands an allowlist entry with a rationale rather
// than passing silently.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const readRepo = (relPath: string): string =>
  readFileSync(join(repoRoot, relPath), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// The union — declared twice, and required to stay identical
// ---------------------------------------------------------------------------
//
// `src/services/correlation.ts` re-derives the type structurally from
// `CorrelationSignalCore['type']`, so it is not a third source of truth. The
// two literal declarations are, and nothing keeps them in step today.

const UNION_SOURCES = [
  'src/utils/analysis-constants.ts',
  'src/services/analysis-core.ts',
] as const;

function parseSignalTypeUnion(relPath: string): string[] {
  const source = readRepo(relPath);
  const union = source.match(/export type SignalType =([\s\S]*?);/);
  assert.ok(union, `${relPath} must declare the SignalType union`);
  const members = [...union[1].matchAll(/^\s*\|\s*'([^']+)'/gm)].map((match) => match[1]);
  assert.ok(
    members.length > 0,
    `${relPath} SignalType union parsed to zero members — this parser is broken, ` +
      'and every assertion below it would pass vacuously',
  );
  return members;
}

const declaredTypes = parseSignalTypeUnion(UNION_SOURCES[0]);

// ---------------------------------------------------------------------------
// Emit-site scan
// ---------------------------------------------------------------------------
//
// Roots are `src/` and `shared/` because those are the only places that
// reference `CorrelationSignalCore`. `tests/`, `e2e/` and `scripts/` are
// deliberately excluded: a fixture must never be able to satisfy "this type is
// emitted", and both directories already contain `type: 'keyword_spike'` and
// `type: 'velocity_spike'` literals that would mask a deleted detector.

const EMIT_SCAN_ROOTS = ['src', 'shared'] as const;
const EMIT_SCAN_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'];
const EMIT_SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', 'locales']);

// Files whose `type:` fields belong to a DIFFERENT union that happens to share a
// member name with the correlation `SignalType`. A name-based scan would count
// these as emits and mask the deletion of the real detector.
const FOREIGN_TYPE_FIELD_FILES: Record<string, string> = {
  'src/services/cross-module-integration.ts':
    "`type: 'convergence'` is UnifiedAlert.type (the AlertType union declared in " +
    'the same file), not a correlation signal. The real convergence detector is ' +
    'in src/services/analysis-core.ts.',
};

// `shared/analysis-focal-points.ts` and `src/services/signal-aggregator.ts` also
// export unions named `SignalType`, but they share zero member names with the
// correlation union (military_flight, protest, internet_outage, ...), so they
// need no exclusion. Noted here because that is the first place a future reader
// will look.

// Requires the field name `type:`, a quoted literal, and a terminator. The
// terminator is what keeps an interface field declaration such as
// `type: 'geo_convergence';` in shared/analysis-geo-convergence.ts from counting
// as an emit — without it, deleting the detector while leaving the interface
// would stay green.
const emitPattern = (type: string): RegExp =>
  new RegExp(String.raw`\btype:\s*(['"])${type}\1\s*(?:,|\}|\))`);

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EMIT_SCAN_SKIP_DIRS.has(entry)) continue;
      walkSourceFiles(full, out);
    } else if (EMIT_SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const scannedFiles = EMIT_SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(repoRoot, root)));

// One read per file, reused by both the emit scan and the dead-symbol check.
const sourceByRelPath = new Map<string, string>();
for (const absPath of scannedFiles) {
  const relPath = relative(repoRoot, absPath).split('\\').join('/');
  sourceByRelPath.set(relPath, readFileSync(absPath, 'utf8'));
}

const emitSites = new Map<string, string[]>();
for (const [relPath, source] of sourceByRelPath) {
  if (relPath in FOREIGN_TYPE_FIELD_FILES) continue;
  for (const type of declaredTypes) {
    if (!emitPattern(type).test(source)) continue;
    emitSites.set(type, [...(emitSites.get(type) ?? []), relPath]);
  }
}

// ---------------------------------------------------------------------------
// Allowlist — declared types with no emitter, each with a recorded disposition
// ---------------------------------------------------------------------------
//
// Acceptance criterion 2 of #6422 (promote or delete, per type) is the
// maintainer's call. This allowlist records that the question is open; it is not
// an answer to it.

interface UnemittedEntry {
  /** Why nothing constructs a signal with this type today. */
  reason: string;
  /** The recorded disposition. Open until the maintainer decides. */
  disposition: string;
  /** A symbol that must stay uncalled for as long as the type stays unemitted. */
  deadSymbol?: { file: string; symbol: string };
}

const DECLARED_WITHOUT_EMITTER: Record<string, UnemittedEntry> = {
  news_leads_markets: {
    reason:
      'No detector constructs it. Display surfaces only: SIGNAL_CONTEXT in ' +
      'src/utils/analysis-constants.ts, SignalModal.ts, IntelligenceGapBadge.ts, ' +
      'story-renderer.ts and a modals.signal.newsLeading key in 28 src/locales files.',
    disposition:
      'Open. Note that #6530 shipped src/services/news-market-correlation.ts (lead/lag ' +
      'with confidence intervals) and closed #6418, so the capability this row promises ' +
      'now exists in a separate service with its own union — which strengthens the ' +
      'delete case but does not decide it.',
  },
  sector_cascade: {
    reason:
      'No detector constructs it. Display surfaces only: SIGNAL_CONTEXT in ' +
      'src/utils/analysis-constants.ts, SignalModal.ts, IntelligenceGapBadge.ts, ' +
      'story-renderer.ts and a modals.signal.sectorCascade key in 28 src/locales files.',
    disposition: 'Open — promote or delete, per acceptance criterion 2 of #6422.',
  },
  hotspot_escalation: {
    reason:
      'The decision function is complete but uncalled. shouldEmitSignal() in ' +
      'src/services/hotspot-escalation.ts delegates to evaluateEscalationSignal in ' +
      'shared/analysis-hotspot-escalation.ts and is backed by a two-hour ' +
      'SIGNAL_COOLDOWN_MS, but nothing calls it — and markSignalEmitted() is never ' +
      'called either, so the cooldown map it guards is never written. The name is ' +
      'separately a BreakingAlert origin, which docs/algorithms.mdx already documents ' +
      'as unwired.',
    disposition:
      'Open, and the cheapest of the three to promote: the decision function exists, ' +
      'so promoting it is a caller rather than a new detector.',
    deadSymbol: { file: 'src/services/hotspot-escalation.ts', symbol: 'shouldEmitSignal' },
  },
};

// ---------------------------------------------------------------------------
// Public documentation surfaces
// ---------------------------------------------------------------------------
//
// Both counts are parsed out of the prose and checked against the code, so
// neither can rot. The forbidden phrase is generated from the declared count
// rather than hardcoded, so it only fires when someone re-asserts the declared
// number as the evaluated one — which is the exact regression #6422 reports.

const UNEMITTED_MARKERS = { en: '**Not emitted**', zh: '**未发射**' } as const;

const DOC_SURFACES = [
  {
    path: 'docs/algorithms.mdx',
    sectionStart: '### Cross-Stream Correlation Engine',
    sectionEnd: '### PizzINT Activity Monitor',
    marker: UNEMITTED_MARKERS.en,
    emitted: /emits (\d+) signal types/,
    declared: /`SignalType` union declares (\d+)/,
    forbidden: (declaredCount: number) =>
      new RegExp(String.raw`${declaredCount}\s+signal types are continuously evaluated`),
  },
  {
    path: 'docs/zh/algorithms.mdx',
    sectionStart: '### 跨流关联引擎',
    sectionEnd: '### PizzINT',
    marker: UNEMITTED_MARKERS.zh,
    emitted: /当前发射 (\d+) 种信号类型/,
    declared: /`SignalType` 联合类型声明了 (\d+) 种/,
    forbidden: (declaredCount: number) =>
      new RegExp(String.raw`${declaredCount}\s*种信号类型持续评估`),
  },
] as const;

function readDocSection(surface: (typeof DOC_SURFACES)[number]): string {
  const doc = readRepo(surface.path);
  const start = doc.indexOf(surface.sectionStart);
  assert.notEqual(start, -1, `${surface.path} must contain "${surface.sectionStart}"`);
  const end = doc.indexOf(surface.sectionEnd, start);
  assert.notEqual(end, -1, `${surface.path} must contain "${surface.sectionEnd}" after the section`);
  return doc.slice(start, end);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignalType declarations, emitters and public docs (#6422)', () => {
  it('finds emitters for most declared types — sanity check for the scan itself', () => {
    assert.ok(
      scannedFiles.length > 100,
      `Emit scan walked only ${scannedFiles.length} files under ${EMIT_SCAN_ROOTS.join(', ')}`,
    );
    assert.ok(
      emitSites.size >= 10,
      `Emit scan found only ${emitSites.size} emitting types ` +
        `(${[...emitSites.keys()].join(', ')}) across ${scannedFiles.length} files. ` +
        'The walk or the emit pattern is broken, and every assertion below would pass ' +
        'vacuously.',
    );
  });

  it('both SignalType declarations list the same members in the same order', () => {
    const [first, second] = UNION_SOURCES.map(parseSignalTypeUnion);
    assert.deepEqual(
      first,
      second,
      `${UNION_SOURCES[0]} and ${UNION_SOURCES[1]} declare SignalType twice and must stay ` +
        'member-for-member identical. src/services/correlation.ts re-derives the type ' +
        'structurally, so a divergence silently splits the two copies.',
    );
  });

  for (const type of declaredTypes) {
    it(`${type} is emitted, or allowlisted with a recorded disposition`, () => {
      if (emitSites.has(type)) return;
      const entry = DECLARED_WITHOUT_EMITTER[type];
      assert.ok(
        entry,
        [
          `SignalType '${type}' is declared in ${UNION_SOURCES.join(' and ')}, but no file`,
          `under ${EMIT_SCAN_ROOTS.join('/ or ')}/ constructs a signal with it`,
          `(${scannedFiles.length} files scanned for /${emitPattern(type).source}/).`,
          '',
          'A declared type with no emitter is a promise the product cannot keep: it is',
          'published in the docs/algorithms.mdx signal table, carries display copy and',
          'emoji, and is translated into every locale — while never being evaluated,',
          'deduplicated or surfaced.',
          '',
          'Either wire a detector, or delete the union member together with its labels,',
          'emoji, SIGNAL_CONTEXT entry and locale keys. If it has to stay declared for',
          'now, add an entry to DECLARED_WITHOUT_EMITTER in this file carrying both a',
          'reason and a disposition (see #6422).',
        ].join('\n'),
      );
      assert.ok(entry.reason.length > 0 && entry.disposition.length > 0);
    });
  }

  it('every allowlisted type is still unemitted', () => {
    for (const [type, entry] of Object.entries(DECLARED_WITHOUT_EMITTER)) {
      assert.ok(
        !emitSites.has(type),
        `'${type}' is on DECLARED_WITHOUT_EMITTER but is now emitted at ` +
          `${emitSites.get(type)?.join(', ')}. Delete the allowlist entry, drop the ` +
          `"${UNEMITTED_MARKERS.en}" / "${UNEMITTED_MARKERS.zh}" marker from its row in ` +
          'docs/algorithms.mdx and docs/zh/algorithms.mdx, and bump the emitted count in ' +
          `both. The recorded disposition was: ${entry.disposition}`,
      );
    }
  });

  it('every allowlisted type is still a member of the union', () => {
    for (const type of Object.keys(DECLARED_WITHOUT_EMITTER)) {
      assert.ok(
        declaredTypes.includes(type),
        `Allowlist entry '${type}' is no longer in the SignalType union. The type was ` +
          'removed; drop the stale allowlist entry so the list cannot fossilise.',
      );
    }
  });

  it('an allowlisted type whose decision function exists still has no caller', () => {
    for (const [type, entry] of Object.entries(DECLARED_WITHOUT_EMITTER)) {
      if (!entry.deadSymbol) continue;
      const { file, symbol } = entry.deadSymbol;
      const callPattern = new RegExp(String.raw`\b${symbol}\s*\(`);
      const callers = [...sourceByRelPath]
        .filter(([relPath]) => relPath !== file)
        .filter(([, source]) => callPattern.test(source))
        .map(([relPath]) => relPath);
      assert.deepEqual(
        callers,
        [],
        `${symbol}() is now called from ${callers.join(', ')}, but nothing constructs a ` +
          `signal with type '${type}'. That is a half-wired detector: the decision is ` +
          'taken and then thrown away. Emit the signal, or revert the caller.',
      );
    }
  });

  for (const surface of DOC_SURFACES) {
    describe(surface.path, () => {
      it('publishes the emitted and declared counts that the code actually has', () => {
        const section = readDocSection(surface);
        const emitted = section.match(surface.emitted);
        assert.ok(emitted, `${surface.path} must publish how many signal types are emitted`);
        assert.equal(
          Number(emitted[1]),
          emitSites.size,
          `${surface.path} claims ${emitted[1]} emitted signal types; ${emitSites.size} have ` +
            `an emitter (${[...emitSites.keys()].sort().join(', ')}).`,
        );

        const declared = section.match(surface.declared);
        assert.ok(declared, `${surface.path} must publish how many signal types are declared`);
        assert.equal(
          Number(declared[1]),
          declaredTypes.length,
          `${surface.path} claims ${declared[1]} declared signal types; the union declares ` +
            `${declaredTypes.length}.`,
        );
      });

      it('does not present every declared type as continuously evaluated', () => {
        const section = readDocSection(surface);
        assert.doesNotMatch(
          section,
          surface.forbidden(declaredTypes.length),
          `${surface.path} describes all ${declaredTypes.length} declared signal types as ` +
            `continuously evaluated, but only ${emitSites.size} have an emitter. This is the ` +
            'claim #6422 was filed about.',
        );
      });

      it('marks exactly the unemitted types in its signal table', () => {
        const section = readDocSection(surface);
        const rows = section.split('\n');
        for (const type of declaredTypes) {
          const row = rows.find((line) => line.startsWith(`| \`${type}\``));
          assert.ok(row, `${surface.path} must keep a signal table row for \`${type}\``);
          if (emitSites.has(type)) {
            assert.ok(
              !row.includes(surface.marker),
              `${surface.path}: \`${type}\` is emitted at ${emitSites.get(type)?.join(', ')} ` +
                `but its row carries the "${surface.marker}" marker.`,
            );
          } else {
            assert.ok(
              row.includes(surface.marker),
              `${surface.path}: \`${type}\` has no emitter but its row does not carry the ` +
                `"${surface.marker}" marker, so the table reads as if it were live.`,
            );
          }
        }
      });
    });
  }
});
