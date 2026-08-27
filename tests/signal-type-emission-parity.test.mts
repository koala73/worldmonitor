import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
// Verified runtime producers
// ---------------------------------------------------------------------------
//
// A literal alone does not prove a signal is live: unused helpers, stale code
// and unrelated unions can all contain `type: '...'`. Each entry below names a
// real producer and a runtime path that consumes it instead.
interface RuntimeProducer {
  types: readonly string[];
  emitterFile: string;
  emitterSymbol: RegExp;
  runtimePath: ReadonlyArray<{ file: string; evidence: RegExp }>;
}

const RUNTIME_PRODUCERS: readonly RuntimeProducer[] = [
  {
    types: [
      'prediction_leads_news',
      'silent_divergence',
      'velocity_spike',
      'convergence',
      'triangulation',
      'flow_drop',
      'flow_price_divergence',
      'explained_market_move',
    ],
    emitterFile: 'src/services/analysis-core.ts',
    emitterSymbol: /export function analyzeCorrelationsCore\(/,
    runtimePath: [{ file: 'src/services/correlation.ts', evidence: /analyzeCorrelationsCore\(/ }],
  },
  {
    types: ['keyword_spike'],
    emitterFile: 'src/services/trending-keywords.ts',
    emitterSymbol: /function checkForSpikes\(/,
    runtimePath: [
      { file: 'src/app/data-loader.ts', evidence: /ingestHeadlines\(headlines\)/ },
      { file: 'src/app/data-loader.ts', evidence: /drainTrendingSignals\(\)/ },
    ],
  },
  {
    types: ['geo_convergence'],
    emitterFile: 'shared/analysis-geo-convergence.ts',
    emitterSymbol: /export function geoConvergenceToSignal\(/,
    runtimePath: [
      { file: 'src/services/geo-convergence.ts', evidence: /return toSignal\(alert,/ },
      { file: 'src/app/data-loader.ts', evidence: /geoAlerts\.map\(geoConvergenceToSignal\)/ },
    ],
  },
  {
    types: ['military_surge'],
    emitterFile: 'shared/analysis-military-surge.ts',
    emitterSymbol: /export function surgeAlertToSignal\(/,
    runtimePath: [
      { file: 'src/services/military-surge.ts', evidence: /return surgeAlertToSignalCore\(surge\)/ },
      { file: 'src/app/data-loader.ts', evidence: /surgeAlerts\.map\(surgeAlertToSignal\)/ },
    ],
  },
];

const emitPattern = (type: string): RegExp =>
  new RegExp(String.raw`\btype:\s*(['"])${type}\1\s*(?:,|\}|\))`);

function collectEmitSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const producer of RUNTIME_PRODUCERS) {
    const emitter = readRepo(producer.emitterFile);
    assert.match(emitter, producer.emitterSymbol, `${producer.emitterFile} must keep its named producer`);
    for (const path of producer.runtimePath) {
      assert.match(readRepo(path.file), path.evidence, `${path.file} must consume ${producer.emitterFile}`);
    }
    for (const type of producer.types) {
      assert.match(emitter, emitPattern(type), `${producer.emitterFile} must construct '${type}'`);
      sites.set(type, [...(sites.get(type) ?? []), producer.emitterFile]);
    }
  }
  return sites;
}

const emitSites = collectEmitSites();

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
      emitSites.size >= 10,
      `Runtime producer contract found only ${emitSites.size} emitting types ` +
        `(${[...emitSites.keys()].join(', ')}).`,
    );
  });

  it('does not count an unused type literal as a runtime emitter', () => {
    const deadCodeLiteral = "const unused = { type: 'news_leads_markets' };";
    assert.match(deadCodeLiteral, emitPattern('news_leads_markets'));
    assert.ok(
      !emitSites.has('news_leads_markets'),
      'An unused type literal must not satisfy the runtime producer contract',
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
          'in the verified runtime producer contract constructs a signal with it.',
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
      const callers = RUNTIME_PRODUCERS
        .flatMap((producer) => [producer.emitterFile, ...producer.runtimePath.map((path) => path.file)])
        .filter((relPath) => relPath !== file)
        .filter((relPath) => callPattern.test(readRepo(relPath)));
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
