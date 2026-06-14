import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  BASELINE_ADVISORIES_BY_LOCKFILE,
  collectAuditFindings,
  collectStaleBaselineEntries,
  collectUnbaselinedFindings,
  isInvokedAsScript,
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

function readRepoJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
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

  it('keeps the root esbuild audit fix scoped away from Vite build tooling', () => {
    const packageJson = readRepoJson('package.json');
    const lockfile = readRepoJson('package-lock.json');
    const rootEsbuild = lockfile.packages['node_modules/esbuild'];
    const vite = lockfile.packages['node_modules/vite'];
    const viteEsbuild = lockfile.packages['node_modules/vite/node_modules/esbuild'];

    assert.equal(packageJson.overrides?.esbuild, undefined);
    assert.equal(packageJson.overrides?.convex?.esbuild, '0.28.1');
    assert.equal(rootEsbuild?.version, '0.28.1');
    assert.equal(vite?.dependencies?.esbuild, '^0.25.0');
    assert.ok(viteEsbuild, 'Vite must keep its own esbuild when root uses the audit-patched version');
    assert.match(viteEsbuild.version, /^0\.25\./);
    assert.notEqual(viteEsbuild.version, rootEsbuild.version);
  });

  it('flags baseline entries that no longer match any current advisory', () => {
    const report = auditReportWith({
      name: 'shell-quote',
      severity: 'critical',
      title: 'known shell-quote advisory',
      url: 'https://github.com/advisories/GHSA-w7jw-789q-3m8p',
    });

    // The still-present id is not reported as stale.
    assert.deepEqual(collectStaleBaselineEntries(report, 'package-lock.json'), []);
    // The other pro-test baseline ids matched nothing this run, so they are stale.
    assert.deepEqual(collectStaleBaselineEntries(report, 'pro-test/package-lock.json').sort(), [
      'GHSA-qjx8-664m-686j',
      'GHSA-w24r-5266-9c3c',
    ]);
  });

  it('treats a symlinked entry path as direct invocation (no silent fail-open)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-guard-'));
    try {
      const real = join(dir, 'audit.mjs');
      writeFileSync(real, '// stub\n');
      const link = join(dir, 'audit-link.mjs');
      symlinkSync(real, link);
      const moduleUrl = pathToFileURL(real).href;

      // Invoked through the symlink, the guard still fires (the bug being fixed).
      assert.equal(isInvokedAsScript(link, moduleUrl), true);
      assert.equal(isInvokedAsScript(real, moduleUrl), true);
      // A different file must not be mistaken for the module entry.
      assert.equal(isInvokedAsScript(join(dir, 'other.mjs'), moduleUrl), false);
      assert.equal(isInvokedAsScript(undefined, moduleUrl), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
