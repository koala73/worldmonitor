import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGHTINGS_KEY,
  crossWordingFamilies,
  familyOf,
  judgePrompt,
  parseJudgeVerdict,
  recordSightings,
} from '../scripts/lib/news-corroboration.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');

function memoryPipeline() {
  const rows = [];
  const pipeline = async (commands) => commands.map(([cmd, key, ...args]) => {
    if (cmd === 'ZADD' && key === SIGHTINGS_KEY) {
      for (let i = 0; i < args.length; i += 2) rows.push({ at: Number(args[i]), member: args[i + 1] });
      return { result: args.length / 2 };
    }
    if (cmd === 'ZRANGEBYSCORE') {
      const min = Number(String(args[0]).replace('(', ''));
      return { result: rows.filter(r => r.at > min && r.at <= Number(args[1])).flatMap(r => [r.member, String(r.at)]) };
    }
    return { result: 0 };
  });
  return { rows, pipeline };
}

// Vectors keyed by the first word, so related wordings share a direction.
const embed = async (titles) => titles.map(t => (/tanker|vessel|ship/i.test(t) ? [1, 0.1] : [0, 1]));

describe('news cross-wording corroboration (#10977)', () => {
  it('counts publisher families, so copies of one wire count once', () => {
    assert.equal(familyOf('Reuters'), familyOf('reuters'));
    assert.equal(familyOf(''), '');
  });

  it('adds the families of the wordings the judge calls the same incident', async () => {
    const { pipeline } = memoryPipeline();
    await recordSightings([
      { title: 'ADNOC tanker hit by projectile in Strait of Hormuz', source: 'Reuters', level: 'high' },
      { title: 'UAE vessel attacked near Hormuz, crew safe', source: 'Al Arabiya', level: 'critical' },
      { title: 'UAE vessel attacked near Hormuz, crew safe', source: 'Al Arabiya English', level: 'critical' },
      { title: 'Oil prices climb on Gulf supply fears', source: 'Bloomberg', level: 'high' },
    ], { now: NOW - 60_000, pipeline });
    const prompts = [];
    const judge = async (_system, user) => { prompts.push(user); return JSON.stringify({ same: /ADNOC tanker|UAE vessel/.test(user) }); };
    const lines = [];
    const found = await crossWordingFamilies(
      [{ title: 'Attack on ADNOC vessel reported off Hormuz', source: 'Gulf News' }],
      { now: NOW, pipeline, embed, judge, log: (l) => lines.push(l) },
    );
    const result = found.get('Attack on ADNOC vessel reported off Hormuz');
    assert.ok(result, 'boost found');
    assert.equal(prompts.length, 2, 'one call per wording, the copies of a wording judged once');
    assert.doesNotMatch(prompts.join('\n'), /Oil prices/, 'an unrelated wording is not judged');
    assert.equal(new Set(result.families).size, result.families.length);
    assert.ok(result.families.includes(familyOf('Gulf News')));
    assert.ok(result.families.includes(familyOf('Reuters')));
    assert.match(lines.join('\n'), /\[news-corroboration\].*matched/, 'every boost is logged with what it matched');
  });

  it('adds nothing when the judge finds no same incident', async () => {
    const { pipeline } = memoryPipeline();
    await recordSightings([{ title: 'Drone strikes LPG tanker in Gulf of Oman', source: 'Reuters', level: 'critical' }], { now: NOW - 60_000, pipeline });
    const found = await crossWordingFamilies(
      [{ title: 'Second strike on LPG tanker in Gulf of Oman', source: 'Gulf News' }],
      { now: NOW, pipeline, embed, judge: async () => '{"same":false}', log: () => {} },
    );
    assert.equal(found.size, 0);
  });

  it('adds nothing on any failure or past the deadline', async () => {
    const { pipeline } = memoryPipeline();
    await recordSightings([{ title: 'Drone strikes LPG tanker in Gulf of Oman', source: 'Reuters', level: 'critical' }], { now: NOW - 60_000, pipeline });
    const candidates = [{ title: 'Tanker struck by drone off Oman', source: 'Gulf News' }];
    for (const judge of [async () => 'yes', async () => '{"same":[1]}', async () => { throw new Error('down'); }, async () => null]) {
      assert.equal((await crossWordingFamilies(candidates, { now: NOW, pipeline, embed, judge, log: () => {} })).size, 0);
    }
    const slow = () => new Promise(done => setTimeout(() => done('{"same":true}'), 200));
    assert.equal((await crossWordingFamilies(candidates, { now: NOW, pipeline, embed, judge: slow, deadlineMs: 20, log: () => {} })).size, 0);
    const broken = async () => null;
    assert.equal((await crossWordingFamilies(candidates, { now: NOW, pipeline: broken, embed, judge: async () => '{"same":true}', log: () => {} })).size, 0);
  });

  it('does not judge a copy against wordings only its own publisher carried', async () => {
    const { pipeline } = memoryPipeline();
    await recordSightings([{ title: 'Drone strikes LPG tanker in Gulf of Oman', source: 'Gulf News', level: 'critical' }], { now: NOW - 60_000, pipeline });
    let judged = false;
    const found = await crossWordingFamilies(
      [{ title: 'Tanker struck by drone off Oman', source: 'Gulf News' }],
      { now: NOW, pipeline, embed, judge: async () => { judged = true; return '{"same":true}'; }, log: () => {} },
    );
    assert.equal(judged, false);
    assert.equal(found.size, 0);
  });

  it('reads only a well-formed verdict', () => {
    assert.equal(parseJudgeVerdict('{"same":true}'), true);
    assert.equal(parseJudgeVerdict('```json\n{"same":false}\n```'), false);
    assert.equal(parseJudgeVerdict('{"same":"yes"}'), null);
    assert.equal(parseJudgeVerdict('{"same":true,"why":"x"}'), null);
    assert.equal(judgePrompt('A', { title: 'B', at: NOW - 2 * 3_600_000 }, NOW), 'Headline A: A\nHeadline B, seen 2h earlier: B');
  });
});
