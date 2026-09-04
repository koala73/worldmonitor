/**
 * syncPanelPreview lifecycle (plan U5 wiring core; review P1 test gap).
 *
 * The seam every preview attach/detach converges through: create when the
 * active mission targets this panel, no-op on repeat syncs, destroy when the
 * mission switches away while the panel stays mounted, and replace when a
 * different preview should own the slot.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  type MissionPreviewHandle,
  syncPanelPreview,
} from '@/services/mission-preview-registry';

function makeHandle(previewId: string): MissionPreviewHandle & { destroyed: () => boolean } {
  const el = document.createElement('section');
  let destroyed = false;
  return {
    getElement: () => el,
    getPreviewId: () => previewId,
    destroy: () => {
      destroyed = true;
      el.remove();
    },
    destroyed: () => destroyed,
  };
}

describe('syncPanelPreview', () => {
  it('creates once and no-ops on repeat syncs', () => {
    const previews = new Map<string, MissionPreviewHandle>();
    const host = document.createElement('div');
    const create = vi.fn((spec: { previewId: string }) => makeHandle(spec.previewId));

    syncPanelPreview(previews, 'supply-chain', host, 'supply-chain-risk', create);
    syncPanelPreview(previews, 'supply-chain', host, 'supply-chain-risk', create);

    expect(create).toHaveBeenCalledTimes(1);
    expect(host.childElementCount).toBe(1);
    expect(previews.size).toBe(1);
  });

  it('destroys and removes when the mission switches away while the panel stays mounted', () => {
    const previews = new Map<string, MissionPreviewHandle>();
    const host = document.createElement('div');
    const handles: ReturnType<typeof makeHandle>[] = [];
    const create = (spec: { previewId: string }) => {
      const h = makeHandle(spec.previewId);
      handles.push(h);
      return h;
    };

    syncPanelPreview(previews, 'supply-chain', host, 'supply-chain-risk', create);
    syncPanelPreview(previews, 'supply-chain', host, 'tech-ai-watch', create);

    expect(handles[0]!.destroyed()).toBe(true);
    expect(host.childElementCount).toBe(0);
    expect(previews.size).toBe(0);
  });

  it('attaches nothing for untreated missions, no mission, or the wrong panel', () => {
    const previews = new Map<string, MissionPreviewHandle>();
    const host = document.createElement('div');
    const create = vi.fn((spec: { previewId: string }) => makeHandle(spec.previewId));

    syncPanelPreview(previews, 'supply-chain', host, null, create);
    syncPanelPreview(previews, 'supply-chain', host, 'good-news-explorer', create);
    syncPanelPreview(previews, 'cascade', host, 'supply-chain-risk', create);

    expect(create).not.toHaveBeenCalled();
    expect(host.childElementCount).toBe(0);
  });

  it('replaces a stale preview when a different mission targets the same panel slot', () => {
    const previews = new Map<string, MissionPreviewHandle>();
    const host = document.createElement('div');
    const stale = makeHandle('some-other-preview');
    host.appendChild(stale.getElement());
    previews.set('gdelt-intel', stale);
    const create = vi.fn((spec: { previewId: string }) => makeHandle(spec.previewId));

    syncPanelPreview(previews, 'gdelt-intel', host, 'osint-newsroom', create);

    expect(stale.destroyed()).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(previews.get('gdelt-intel')?.getPreviewId()).toBe('intel-memory');
  });
});
