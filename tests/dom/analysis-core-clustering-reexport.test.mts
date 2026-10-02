/**
 * The dashboard's analysis worker clusters news through
 * `@/services/analysis-core`, and the server-side MCP `get_news_clusters`
 * tool clusters through `shared/news-clustering-core.js` (#5697). The two
 * surfaces agree only while analysis-core re-exports the shared functions
 * instead of carrying its own copy, so this checks object identity.
 *
 * It lives under tests/dom because analysis-core pulls in `@/services/i18n`,
 * which needs Vite's `import.meta.glob` and cannot load under `tsx --test`.
 */
import { describe, expect, it } from 'vitest';

import * as analysisCore from '@/services/analysis-core';
import * as sharedCore from '../../shared/news-clustering-core.js';

describe('analysis-core news clustering re-export (#5697)', () => {
  it('hands the client the shared implementation, not a fork', () => {
    expect(analysisCore.clusterNewsCore).toBe(sharedCore.clusterNewsCore);
    expect(analysisCore.aggregateThreats).toBe(sharedCore.aggregateThreats);
    expect(analysisCore.MAX_CLUSTER_NEWS_ITEMS).toBe(sharedCore.MAX_CLUSTER_NEWS_ITEMS);
  });
});
