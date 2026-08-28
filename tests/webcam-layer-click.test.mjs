import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEBCAM_STREAM_OPEN_FEATURES,
  dispatchWebcamLayerClick,
  isWebcamClusterMarker,
  isWebcamLeafMarker,
  openWebcamStreamInNewTab,
  resolveWebcamStreamUrl,
  webcamLayerClickKind,
} from '../src/components/map/webcam-click.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deckGLMapSrc = readFileSync(join(root, 'src', 'components', 'DeckGLMap.ts'), 'utf-8');

const leaf = {
  _kind: 'webcam',
  webcamId: 'abc/123',
  title: 'Harbour Cam',
  lat: 51.5,
  lng: -0.1,
  category: 'city',
  country: 'GB',
};

const cluster = {
  _kind: 'webcam-cluster',
  lat: 51.5,
  lng: -0.1,
  count: 12,
};

describe('webcam layer click routing (#3877)', () => {
  it('narrows leaf vs cluster on _kind without treating a cluster as a leaf', () => {
    assert.equal(isWebcamLeafMarker(leaf), true);
    assert.equal(isWebcamClusterMarker(leaf), false);
    assert.equal(isWebcamLeafMarker(cluster), false);
    assert.equal(isWebcamClusterMarker(cluster), true);
    assert.equal(webcamLayerClickKind(leaf), 'leaf');
    assert.equal(webcamLayerClickKind(cluster), 'cluster');
    assert.equal(webcamLayerClickKind(null), 'none');
    assert.equal(webcamLayerClickKind({ lat: 1, lng: 2 }), 'none');
  });

  it('falls back to count/webcamId when _kind is missing', () => {
    assert.equal(isWebcamLeafMarker({ webcamId: 'x', lat: 0, lng: 0 }), true);
    assert.equal(isWebcamClusterMarker({ count: 4, lat: 0, lng: 0 }), true);
    assert.equal(isWebcamLeafMarker({ webcamId: 'x', count: 4, lat: 0, lng: 0 }), false);
    assert.equal(isWebcamClusterMarker({ webcamId: 'x', count: 4, lat: 0, lng: 0 }), false);
  });

  it('resolves a public stream URL and no-ops when the id is missing', () => {
    assert.equal(
      resolveWebcamStreamUrl(leaf),
      'https://www.windy.com/webcams/abc%2F123',
    );
    assert.equal(
      resolveWebcamStreamUrl(leaf, { windyUrl: 'https://www.windy.com/webcams/abc/123' }),
      'https://www.windy.com/webcams/abc/123',
    );
    assert.equal(resolveWebcamStreamUrl({ webcamId: '' }), null);
    assert.equal(resolveWebcamStreamUrl({ webcamId: '   ' }), null);
  });

  it('opens the stream in a new tab with noopener,noreferrer and skips empty URLs', () => {
    const calls = [];
    const openWindow = (url, target, features) => {
      calls.push({ url, target, features });
    };

    assert.equal(openWebcamStreamInNewTab(resolveWebcamStreamUrl(leaf), openWindow), true);
    assert.equal(openWebcamStreamInNewTab(null, openWindow), false);
    assert.equal(openWebcamStreamInNewTab('', openWindow), false);

    assert.deepEqual(calls, [{
      url: 'https://www.windy.com/webcams/abc%2F123',
      target: '_blank',
      features: WEBCAM_STREAM_OPEN_FEATURES,
    }]);
  });

  it('opens one tab for a leaf click and none for a cluster click', () => {
    const opens = [];
    const leaves = [];
    const clusters = [];
    const handlers = {
      openWindow: (url, target, features) => {
        opens.push({ url, target, features });
      },
      onLeaf: (webcam) => {
        leaves.push(webcam.webcamId);
      },
      onCluster: (group) => {
        clusters.push(group.count);
      },
    };

    assert.equal(dispatchWebcamLayerClick(leaf, handlers), true);
    assert.equal(dispatchWebcamLayerClick(cluster, handlers), true);
    assert.equal(dispatchWebcamLayerClick({ lat: 0, lng: 0 }, handlers), false);

    assert.equal(opens.length, 1);
    assert.equal(opens[0].target, '_blank');
    assert.equal(opens[0].features, WEBCAM_STREAM_OPEN_FEATURES);
    assert.deepEqual(leaves, ['abc/123']);
    assert.deepEqual(clusters, [12]);
  });

  it('does not throw when a leaf has no stream URL', () => {
    const opens = [];
    assert.equal(
      dispatchWebcamLayerClick(
        { _kind: 'webcam', webcamId: '', title: '', lat: 0, lng: 0, category: '', country: '' },
        {
          openWindow: (url) => {
            opens.push(url);
          },
          onLeaf: () => {},
          onCluster: () => {
            throw new Error('cluster handler must not run for a leaf');
          },
        },
      ),
      true,
    );
    assert.equal(opens.length, 0);
  });
});

describe('DeckGLMap webcam-layer wiring (#3877)', () => {
  it('gives webcam-layer an onClick that consumes the event', () => {
    const layerMatch = deckGLMapSrc.match(
      /\/\/ Webcam layer \(server-side clustered markers\)[\s\S]*?id: 'webcam-layer',[\s\S]*?\}\)\);/,
    );
    assert.ok(layerMatch, 'webcam-layer ScatterplotLayer should still exist');
    assert.match(layerMatch[0], /onClick:\s*\(info\)\s*=>\s*this\.handleWebcamLayerClick\(info\)/);
  });

  it('routes webcam-layer clicks through the cluster/leaf helper and returns true', () => {
    const handlerMatch = deckGLMapSrc.match(
      /private handleWebcamLayerClick\(info: PickingInfo\): boolean \{[\s\S]*?^\s{2}\}/m,
    );
    assert.ok(handlerMatch, 'handleWebcamLayerClick should exist');
    assert.match(handlerMatch[0], /dispatchWebcamLayerClick/);
    assert.match(handlerMatch[0], /return dispatchWebcamLayerClick/);
    assert.match(handlerMatch[0], /onCluster:/);
    assert.doesNotMatch(handlerMatch[0], /as WebcamEntry/);
  });

  it('keeps the global handleClick webcam branch from double-firing via the same helper', () => {
    assert.match(
      deckGLMapSrc,
      /if \(layerId === 'webcam-layer'\) \{\s*this\.handleWebcamLayerClick\(info\);\s*return;/,
    );
  });
});
