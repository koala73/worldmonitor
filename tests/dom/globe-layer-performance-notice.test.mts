import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('globe.gl', () => ({ default: vi.fn() }));
const { showLayerWarning } = vi.hoisted(() => ({ showLayerWarning: vi.fn() }));
vi.mock('@/utils/layer-warning', () => ({ showLayerWarning }));
import { GlobeMap } from '@/components/GlobeMap';

beforeEach(() => { showLayerWarning.mockClear(); });

// A real GlobeMap, so the field initializers under test run; only the picker is
// stubbed, since globe.gl (mocked above) never renders one here.
function globeWithLayers(checked: number): { host: { enforceLayerLimit(): void }; inputs: HTMLInputElement[] } {
  const toggles = document.createElement('div');
  const inputs = Array.from({ length: checked }, (_, index) => {
    const label = document.createElement('label');
    label.className = 'layer-toggle';
    label.dataset.layer = `layer${index}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    label.append(input);
    toggles.append(label);
    return input;
  });
  const state = { layers: {}, timeRange: '7d', view: 'global', zoom: 1, pan: { x: 0, y: 0 } };
  const globe = new GlobeMap(document.createElement('div'), state as unknown as ConstructorParameters<typeof GlobeMap>[1]);
  globe.whenReady().catch(() => {});
  const host = Object.assign(globe, { layerTogglesEl: toggles }) as unknown as { enforceLayerLimit(): void };
  return { host, inputs };
}

function reAdd(host: { enforceLayerLimit(): void }, input: HTMLInputElement): void {
  input.checked = false;
  host.enforceLayerLimit();
  input.checked = true;
  host.enforceLayerLimit();
}

it('does not warn about the layers the globe starts with, only about layers added past the threshold', () => {
  const { host, inputs } = globeWithLayers(15);
  host.enforceLayerLimit();
  expect(showLayerWarning).not.toHaveBeenCalled();

  reAdd(host, inputs[0]!);
  expect(showLayerWarning).toHaveBeenCalledExactlyOnceWith(13);
});

it('treats the threshold itself as allowed, matching "more than 13 layers"', () => {
  const { host, inputs } = globeWithLayers(13);
  host.enforceLayerLimit();
  reAdd(host, inputs[0]!);
  expect(showLayerWarning).not.toHaveBeenCalled();
});
