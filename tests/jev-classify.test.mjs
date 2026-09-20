import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_MODEL, THREAT_LEVELS, THREAT_CATEGORIES, LEVEL_CRITERIA, CATEGORY_CRITERIA,
  buildJevRequest, parseJevAnswers, sanitizeHeadline, hasNonLatinLetters,
} from '../shared/jev-classify.js';

const choice = (value, confidence, probabilities = { [value]: confidence }) => ({ type: 'choice', choice: value, confidence, probabilities });

describe('jev-classify criteria', () => {
  it('describes exactly the production levels and categories', () => {
    assert.deepEqual(Object.keys(LEVEL_CRITERIA), THREAT_LEVELS);
    assert.deepEqual(Object.keys(CATEGORY_CRITERIA), THREAT_CATEGORIES);
  });

  it('pins a model version, never the moving alias', () => {
    assert.match(JEV_MODEL, /^jev-\d+\.\d+\.\d+$/);
  });
});

describe('buildJevRequest', () => {
  it('gives a single title its own state and two questions', () => {
    const req = buildJevRequest(['Iran closes Strait of Hormuz']);
    assert.deepEqual(req.state, { headline: 'Iran closes Strait of Hormuz' });
    assert.deepEqual(Object.keys(req.questions), ['l0', 'c0']);
    assert.ok(req.questions.l0.instructions.includes('`headline`'));
  });

  it('keys a batch h0..hN and points each question at its own headline', () => {
    const req = buildJevRequest(['a', 'b', 'c']);
    assert.deepEqual(req.state.headlines, { h0: 'a', h1: 'b', h2: 'c' });
    assert.equal(Object.keys(req.questions).length, 6);
    assert.ok(req.questions.l2.instructions.includes('`headlines.h2`'));
    assert.ok(req.questions.c1.instructions.includes('`headlines.h1`'));
  });

  it('strips newlines and clips to maxTextChars', () => {
    assert.equal(sanitizeHeadline('a\nb\rc', 200), 'a b c');
    assert.equal(buildJevRequest(['x'.repeat(500)], { maxTextChars: 120 }).state.headline.length, 120);
  });
});

describe('parseJevAnswers', () => {
  it('levelOnly asks and requires the level question alone', () => {
    const req = buildJevRequest(['Strike on port'], { levelOnly: true });
    assert.deepEqual(Object.keys(req.questions), ['l0']);
    const body = { answers: { l0: { type: 'choice', choice: 'high', confidence: 0.7, probabilities: { high: 0.7, medium: 0.3 } } } };
    assert.deepEqual(parseJevAnswers(body, 1), [], 'without levelOnly a missing category is no label');
    const [label] = parseJevAnswers(body, 1, { levelOnly: true });
    assert.equal(label.l, 'high');
    assert.equal('c' in label, false);
  });

  it('returns level, category, level confidence and pAlert per index', () => {
    const labels = parseJevAnswers({
      answers: {
        l0: choice('critical', 0.83, { critical: 0.87, high: 0.1, medium: 0.03 }),
        c0: choice('conflict', 0.6),
      },
    }, 1);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].l, 'critical');
    assert.equal(labels[0].c, 'conflict');
    assert.equal(labels[0].levelConf, 0.83);
    assert.ok(Math.abs(labels[0].pAlert - 0.97) < 1e-9);
  });

  it('drops an index whose level or category is outside the enum, keeps its neighbours', () => {
    const labels = parseJevAnswers({
      answers: {
        l0: choice('catastrophic', 0.9), c0: choice('conflict', 0.9),
        l1: choice('low', 0.9), c1: choice('diplomatic', 0.9),
        l2: choice('info', 0.9),
      },
    }, 3);
    assert.deepEqual(labels.map((l) => l.i), [1]);
  });

  it('drops an answer with a non-numeric confidence or the wrong type', () => {
    assert.deepEqual(parseJevAnswers({ answers: { l0: choice('low', 'high'), c0: choice('general', 0.9) } }, 1), []);
    assert.deepEqual(parseJevAnswers({ answers: { l0: { type: 'noul', noul: 0.9 }, c0: choice('general', 0.9) } }, 1), []);
  });

  it('drops a level answer that carries no probability for its own choice', () => {
    for (const probabilities of [{}, undefined, { low: 0.9 }, { high: 'n/a' }, { high: null }, { high: '' }, { high: '0.9' }]) {
      const body = { answers: { l0: { type: 'choice', choice: 'high', confidence: 0.9, probabilities }, c0: choice('conflict', 0.9) } };
      assert.deepEqual(parseJevAnswers(body, 1), [], JSON.stringify(probabilities));
    }
  });

  it('returns nothing for a malformed body', () => {
    for (const body of [null, undefined, 'oops', {}, { answers: null }, { answers: 'x' }]) {
      assert.deepEqual(parseJevAnswers(body, 2), []);
    }
  });
});

describe('hasNonLatinLetters', () => {
  it('is true only when a letter is outside the Latin script', () => {
    assert.equal(hasNonLatinLetters('Trafikkulykke på Riksvei 4: “En” – 3 døde'), false);
    assert.equal(hasNonLatinLetters('الدفاع المدني يحذر'), true);
    assert.equal(hasNonLatinLetters('Путин заявил'), true);
    assert.equal(hasNonLatinLetters('Tokyo 東京 summit'), true);
  });
});
