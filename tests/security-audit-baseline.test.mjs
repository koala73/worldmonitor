import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASELINE_ADVISORIES_BY_LOCKFILE,
  collectAuditFindings,
  collectUnbaselinedFindings,
} from '../.github/scripts/audit-production-dependencies.mjs';

function auditReportWith(via) {
  return {
    vulnerabilities: {
      [via.name]: {
        name: via.name,
        severity: via.severity,
        via: [via],
      },
    },
  };
}

describe('security audit baseline', () => {
  it('allows currently baselined high and critical advisories', () => {
    const report = auditReportWith({
      name: 'shell-quote',
      severity: 'critical',
      title: 'known shell-quote advisory',
      url: 'https://github.com/advisories/GHSA-w7jw-789q-3m8p',
    });

    assert.deepEqual(collectUnbaselinedFindings(report, 'package-lock.json'), []);
  });

  it('ignores moderate production advisories for the high-severity PR gate', () => {
    const report = auditReportWith({
      name: 'uuid',
      severity: 'moderate',
      title: 'moderate advisory',
      url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
    });

    assert.deepEqual(collectAuditFindings(report), []);
  });

  it('fails a new unbaselined high advisory', () => {
    const report = auditReportWith({
      name: 'new-package',
      severity: 'high',
      title: 'new advisory',
      url: 'https://github.com/advisories/GHSA-1111-2222-3333',
    });

    assert.deepEqual(collectUnbaselinedFindings(report, 'package-lock.json'), [
      {
        id: 'GHSA-1111-2222-3333',
        name: 'new-package',
        severity: 'high',
        title: 'new advisory',
        url: 'https://github.com/advisories/GHSA-1111-2222-3333',
      },
    ]);
  });

  it('tracks a baseline entry for each audited lockfile', () => {
    assert.deepEqual(Object.keys(BASELINE_ADVISORIES_BY_LOCKFILE).sort(), [
      'blog-site/package-lock.json',
      'consumer-prices-core/package-lock.json',
      'docker/runtime-package-lock.json',
      'package-lock.json',
      'pro-test/package-lock.json',
      'scripts/package-lock.json',
    ]);
  });
});
