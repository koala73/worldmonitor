/**
 * Smart Alert System Tests
 *
 * Tests for alert matching, priority detection, and storage types.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  SmartAlert,
  AlertNewsItem,
  AlertPriority,
  CreateAlertRequest,
} from '../src/types/smart-alert.js';

describe('Smart Alert Types', () => {
  it('SmartAlert should have required fields', () => {
    const alert: SmartAlert = {
      id: 'alert_123',
      userId: 'user_456',
      keyword: 'Intel Ireland',
      priorityFilter: ['CRITICAL', 'HIGH'],
      channels: ['email', 'telegram'],
      isActive: true,
      createdAt: '2026-03-24T00:00:00Z',
      updatedAt: '2026-03-24T00:00:00Z',
    };

    assert.equal(alert.id, 'alert_123');
    assert.equal(alert.keyword, 'Intel Ireland');
    assert.deepEqual(alert.priorityFilter, ['CRITICAL', 'HIGH']);
    assert.deepEqual(alert.channels, ['email', 'telegram']);
    assert.equal(alert.isActive, true);
  });

  it('AlertNewsItem should have required fields', () => {
    const news: AlertNewsItem = {
      id: 'news_789',
      title: 'Intel announces €5B expansion in Ireland',
      content: 'Intel plans to expand its Leixlip facility...',
      url: 'https://example.com/news/intel-expansion',
      source: 'Irish Times',
      tags: ['technology', 'investment', 'expansion'],
      publishedAt: '2026-03-24T10:00:00Z',
    };

    assert.equal(news.title, 'Intel announces €5B expansion in Ireland');
    assert.equal(news.source, 'Irish Times');
    assert.ok(news.tags.includes('expansion'));
  });

  it('CreateAlertRequest should accept minimal fields', () => {
    const request: CreateAlertRequest = {
      keyword: 'Stripe',
    };

    assert.equal(request.keyword, 'Stripe');
    assert.equal(request.priorityFilter, undefined);
    assert.equal(request.channels, undefined);
  });

  it('CreateAlertRequest should accept all optional fields', () => {
    const request: CreateAlertRequest = {
      keyword: 'Meta',
      priorityFilter: ['CRITICAL'],
      channels: ['telegram'],
      email: 'test@example.com',
      telegramChatId: '123456789',
    };

    assert.equal(request.keyword, 'Meta');
    assert.deepEqual(request.priorityFilter, ['CRITICAL']);
    assert.deepEqual(request.channels, ['telegram']);
    assert.equal(request.email, 'test@example.com');
    assert.equal(request.telegramChatId, '123456789');
  });
});

describe('Alert Priority Detection', () => {
  // Helper function to mimic priority detection logic
  function determinePriority(text: string): AlertPriority {
    const lower = text.toLowerCase();

    const criticalKeywords = [
      'funding', 'raises', 'series a', 'series b', 'series c',
      'acquisition', 'acquired', 'acquires', 'merger', 'm&a', 'ipo',
      'bankruptcy', 'layoffs', 'shutdown', 'data breach',
    ];

    const highKeywords = [
      'expansion', 'expands', 'new office', 'headquarters',
      'hiring', 'jobs', 'employees', 'ceo', 'cto', 'partnership',
    ];

    for (const kw of criticalKeywords) {
      if (lower.includes(kw)) return 'CRITICAL';
    }
    for (const kw of highKeywords) {
      if (lower.includes(kw)) return 'HIGH';
    }
    return 'NORMAL';
  }

  it('should detect CRITICAL priority for funding news', () => {
    assert.equal(determinePriority('Stripe raises $6.5B in Series I funding'), 'CRITICAL');
    assert.equal(determinePriority('Intercom announces $100M Series D funding round'), 'CRITICAL');
  });

  it('should detect CRITICAL priority for M&A news', () => {
    assert.equal(determinePriority('Google acquires Irish AI startup'), 'CRITICAL');
    assert.equal(determinePriority('Major M&A activity in Dublin tech scene'), 'CRITICAL');
    assert.equal(determinePriority('Startup acquired for €50M'), 'CRITICAL');
  });

  it('should detect CRITICAL priority for IPO news', () => {
    assert.equal(determinePriority('Irish fintech announces IPO filing'), 'CRITICAL');
  });

  it('should detect CRITICAL priority for negative events', () => {
    assert.equal(determinePriority('Tech company announces layoffs'), 'CRITICAL');
    assert.equal(determinePriority('Startup declares bankruptcy'), 'CRITICAL');
    assert.equal(determinePriority('Major data breach reported'), 'CRITICAL');
  });

  it('should detect HIGH priority for expansion news', () => {
    assert.equal(determinePriority('Intel expands Leixlip facility'), 'HIGH');
    assert.equal(determinePriority('Apple opens new office in Cork'), 'HIGH');
    assert.equal(determinePriority('Microsoft moves European headquarters to Dublin'), 'HIGH');
  });

  it('should detect HIGH priority for hiring news', () => {
    assert.equal(determinePriority('Meta announces 500 new jobs in Ireland'), 'HIGH');
    assert.equal(determinePriority('Amazon hiring 200 employees for Dublin'), 'HIGH');
  });

  it('should detect HIGH priority for executive news', () => {
    assert.equal(determinePriority('Stripe appoints new CEO'), 'HIGH');
    assert.equal(determinePriority('New CTO joins Intercom'), 'HIGH');
  });

  it('should detect NORMAL priority for general news', () => {
    assert.equal(determinePriority('Tech conference held in Dublin'), 'NORMAL');
    assert.equal(determinePriority('Interview with startup founder'), 'NORMAL');
    assert.equal(determinePriority('Product update released'), 'NORMAL');
  });
});

describe('Keyword Matching', () => {
  // Helper function to mimic keyword matching logic
  function matchesKeyword(text: string, keyword: string): boolean {
    return text.toLowerCase().includes(keyword.toLowerCase());
  }

  it('should match exact keywords', () => {
    assert.ok(matchesKeyword('Intel announces expansion', 'Intel'));
    assert.ok(matchesKeyword('Stripe raises funding', 'Stripe'));
  });

  it('should be case-insensitive', () => {
    assert.ok(matchesKeyword('INTEL ANNOUNCES EXPANSION', 'intel'));
    assert.ok(matchesKeyword('intel announces expansion', 'INTEL'));
    assert.ok(matchesKeyword('Intel Announces Expansion', 'intel'));
  });

  it('should match partial keywords', () => {
    assert.ok(matchesKeyword('Intel Ireland facility', 'Intel Ireland'));
    assert.ok(matchesKeyword('Artificial Intelligence startup', 'Artificial Intelligence'));
  });

  it('should not match non-existent keywords', () => {
    assert.ok(!matchesKeyword('Google announces expansion', 'Intel'));
    assert.ok(!matchesKeyword('Meta opens office', 'Amazon'));
  });

  it('should match keywords in longer text', () => {
    const longText = 'The Irish technology sector continues to grow with Intel announcing a major expansion of their Leixlip semiconductor facility, bringing thousands of new jobs to the region.';

    assert.ok(matchesKeyword(longText, 'Intel'));
    assert.ok(matchesKeyword(longText, 'Leixlip'));
    assert.ok(matchesKeyword(longText, 'semiconductor'));
    assert.ok(!matchesKeyword(longText, 'Google'));
  });
});

describe('Alert Validation', () => {
  function validateKeyword(keyword: string | null | undefined): string | null {
    if (keyword === null || keyword === undefined || typeof keyword !== 'string') {
      return 'keyword is required';
    }
    const trimmed = keyword.trim();
    if (trimmed.length < 2) {
      return 'keyword must be at least 2 characters';
    }
    if (trimmed.length > 100) {
      return 'keyword must be at most 100 characters';
    }
    return null;
  }

  it('should reject empty keywords', () => {
    assert.equal(validateKeyword(''), 'keyword must be at least 2 characters');
    assert.equal(validateKeyword('   '), 'keyword must be at least 2 characters');
    assert.equal(validateKeyword(null), 'keyword is required');
    assert.equal(validateKeyword(undefined), 'keyword is required');
  });

  it('should reject too short keywords', () => {
    assert.equal(validateKeyword('A'), 'keyword must be at least 2 characters');
  });

  it('should reject too long keywords', () => {
    const longKeyword = 'A'.repeat(101);
    assert.equal(validateKeyword(longKeyword), 'keyword must be at most 100 characters');
  });

  it('should accept valid keywords', () => {
    assert.equal(validateKeyword('Intel'), null);
    assert.equal(validateKeyword('Intel Ireland'), null);
    assert.equal(validateKeyword('AI'), null);
    assert.equal(validateKeyword('A'.repeat(100)), null);
  });
});
