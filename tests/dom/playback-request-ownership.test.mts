import { beforeEach, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '@/services/storage';
import { PlaybackControl } from '@/components/PlaybackControl';

const pending = vi.hoisted(() => [] as Array<(snapshot: DashboardSnapshot) => void>);
vi.mock('@/services/storage', () => ({
  getSnapshotTimestamps: async () => [1700000000000, 1700000060000],
  getSnapshotAt: () => new Promise(resolve => pending.push(resolve)),
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
const snapshot = (timestamp: number): DashboardSnapshot => ({ timestamp, events: [], marketPrices: {}, predictions: [], hotspotLevels: {} });
beforeEach(() => { pending.length = 0; document.body.replaceChildren(); document.body.className = ''; });
async function mount() {
  const control = new PlaybackControl();
  document.body.append(control.getElement());
  const changed = vi.fn(); control.onSnapshot(changed);
  control.getElement().querySelector<HTMLButtonElement>('.playback-toggle')!.click();
  await Promise.resolve();
  const click = (action: string) => control.getElement().querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
  return { control, changed, click };
}
it.each(['live', 'close', 'exit'])('late snapshot cannot overwrite %s', async action => {
  const {control, changed, click} = await mount();
  click('start');
  if (action === 'exit') control.exitPlayback();
  else if (action === 'close') control.getElement().querySelector<HTMLButtonElement>('.playback-close')!.click();
  else click('live');
  pending[0]!(snapshot(1700000000000)); await Promise.resolve();
  expect(changed.mock.calls).toEqual([[null]]);
  expect(control.isInPlaybackMode()).toBe(false);
  expect(document.body.classList.contains('playback-mode')).toBe(false);
});
it('newest selection wins out-of-order storage reads', async () => {
  const { changed, click } = await mount();
  click('start'); click('next');
  const latest = snapshot(1700000060000);
  pending[1]!(latest); await Promise.resolve();
  pending[0]!(snapshot(1700000000000)); await Promise.resolve();
  expect(changed.mock.calls).toEqual([[latest]]);
});
