import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DESCRIPTION, SITUATION_PAGE_PATH, TITLE } from '../scripts/build-situation-page.mjs';
import { LIVE_TOPIC_PAGES } from '../scripts/live-pages/index.mjs';

function passedMeta() {
  return [
    ...LIVE_TOPIC_PAGES.map((page) => ({
      id: page.path,
      title: page.title,
      description: page.description,
    })),
    { id: SITUATION_PAGE_PATH, title: TITLE, description: DESCRIPTION },
  ];
}

describe('live page meta length', () => {
  it('keeps every passed title and description inside one shared limit', () => {
    const titles = new Set();
    const descriptions = new Set();
    for (const page of passedMeta()) {
      assert.equal(typeof page.title, 'string', `${page.id} title is a string`);
      assert.equal(typeof page.description, 'string', `${page.id} description is a string`);
      assert.equal(page.title.includes('\u2014'), false, `${page.id} title includes U+2014`);
      assert.equal(page.description.includes('\u2014'), false, `${page.id} description includes U+2014`);
      assert.ok(page.title.length <= 60, `${page.id} title length ${page.title.length}`);
      assert.ok(page.description.length >= 120, `${page.id} description length ${page.description.length}`);
      assert.ok(page.description.length <= 160, `${page.id} description length ${page.description.length}`);
      assert.equal(titles.has(page.title), false, `${page.id} title is duplicated`);
      titles.add(page.title);
      assert.equal(descriptions.has(page.description), false, `${page.id} description is duplicated`);
      descriptions.add(page.description);
    }
  });
});
