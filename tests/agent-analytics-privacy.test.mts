import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAgentAnalyticsSuppressed,
  isAgentPanelViewSuppressed,
  runWithAgentAnalyticsSuppressed,
  suppressNextAgentPanelView,
} from '../src/services/agent-analytics-privacy.ts';

describe('agent selection analytics privacy (#6212)', () => {
  it('suppresses synchronous downstream analytics and always restores the scope', () => {
    assert.equal(isAgentAnalyticsSuppressed(), false);
    runWithAgentAnalyticsSuppressed(() => {
      assert.equal(isAgentAnalyticsSuppressed(), true);
      runWithAgentAnalyticsSuppressed(() => {
        assert.equal(isAgentAnalyticsSuppressed(), true);
      });
    });
    assert.equal(isAgentAnalyticsSuppressed(), false);

    assert.throws(() => runWithAgentAnalyticsSuppressed(() => {
      throw new Error('selection failed');
    }));
    assert.equal(isAgentAnalyticsSuppressed(), false);
  });

  it('suppresses async panel-view events only within the bounded window', () => {
    suppressNextAgentPanelView('agent-panel', 1_000);
    assert.equal(isAgentPanelViewSuppressed('agent-panel', 5_999), true);
    assert.equal(isAgentPanelViewSuppressed('agent-panel', 5_999), true);

    suppressNextAgentPanelView('expired-panel', 10_000);
    assert.equal(isAgentPanelViewSuppressed('expired-panel', 15_001), false);
  });
});
