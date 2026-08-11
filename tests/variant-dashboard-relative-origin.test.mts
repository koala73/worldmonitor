import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderVariantDashboardHtml } from '../src/config/variant-dashboard-html';
import { VARIANT_META } from '../src/config/variant-meta';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));

test('variant dashboard generation accepts the fork-relative full dashboard route', () => {
  const rendered = renderVariantDashboardHtml(readFileSync(indexPath, 'utf8'), 'finance');

  assert.match(rendered, new RegExp(`hreflang="x-default" href="${VARIANT_META.finance.url}"`));
  assert.match(rendered, new RegExp(`hreflang="en" href="${VARIANT_META.finance.url}"`));
});
