import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  IRELAND_SUMMITS,
  getUpcomingSummits,
  getFeaturedSummits,
  formatSummitDate,
} from '../src/config/summits.js';

describe('summits', () => {
  describe('IRELAND_SUMMITS', () => {
    it('contains Dublin Tech Summit', () => {
      const dts = IRELAND_SUMMITS.find(s => s.id === 'dublin-tech-summit-2026');
      assert.ok(dts);
      assert.strictEqual(dts.location, 'Dublin, Ireland');
    });

    it('contains Web Summit', () => {
      const ws = IRELAND_SUMMITS.find(s => s.id === 'web-summit-2026');
      assert.ok(ws);
      assert.strictEqual(ws.location, 'Lisbon, Portugal');
    });

    it('all summits have required fields', () => {
      for (const summit of IRELAND_SUMMITS) {
        assert.ok(summit.id, 'missing id');
        assert.ok(summit.name, 'missing name');
        assert.ok(summit.date, 'missing date');
        assert.ok(summit.location, 'missing location');
        assert.ok(summit.url, 'missing url');
      }
    });
  });

  describe('getFeaturedSummits', () => {
    it('returns only featured summits', () => {
      const featured = getFeaturedSummits();
      assert.ok(featured.length > 0);
      assert.ok(featured.every(s => s.featured === true));
    });
  });

  describe('formatSummitDate', () => {
    it('formats single day event', () => {
      const summit = { id: 't', name: 't', date: '2026-05-15', location: '', url: '' };
      const formatted = formatSummitDate(summit);
      assert.ok(formatted.includes('May'));
      assert.ok(formatted.includes('2026'));
    });

    it('formats multi-day event in same month', () => {
      const summit = { id: 't', name: 't', date: '2026-05-15', endDate: '2026-05-16', location: '', url: '' };
      const formatted = formatSummitDate(summit);
      assert.ok(formatted.includes('15-16'));
      assert.ok(formatted.includes('May'));
    });
  });
});
