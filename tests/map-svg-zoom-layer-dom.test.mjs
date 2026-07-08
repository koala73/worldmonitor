import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const mapPath = resolve(root, 'src/components/Map.ts');
const mapSrc = readFileSync(mapPath, 'utf-8');
const sourceFile = ts.createSourceFile(mapPath, mapSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function findClassMethod(className, methodName) {
  let result = null;

  function visit(node) {
    if (result) return;
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === methodName) {
          result = member;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  assert.ok(result, `missing ${className}.${methodName}`);
  return result;
}

function ifConditionText(node) {
  return ts.isIfStatement(node) ? node.expression.getText(sourceFile) : '';
}

function hasZoomGate(node, layer) {
  const condition = ifConditionText(node);
  return condition.includes(`this.state.layers.${layer}`)
    && condition.includes(`this.isLayerZoomVisible('${layer}')`);
}

function classNameAssignments(method, markerClass) {
  const matches = [];

  function visit(node, ancestors) {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.left.getText(sourceFile).endsWith('.className')
      && node.right.getText(sourceFile).includes(markerClass)
    ) {
      matches.push({ node, ancestors: [...ancestors] });
    }

    ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
  }

  visit(method, []);
  return matches;
}

describe('SVG map zoom-hidden layer DOM allocation', () => {
  it('routes zoom threshold checks through an override-aware helper', () => {
    const helper = findClassMethod('MapComponent', 'isLayerZoomVisible');
    const body = helper.getText(sourceFile);

    assert.ok(body.includes('if (!this.state.layers[layer]) return false;'));
    assert.match(body, /MapComponent\.LAYER_ZOOM_THRESHOLDS\[layer\]/);
    assert.match(body, /this\.layerZoomOverrides\[layer\]/);
    assert.match(body, /this\.state\.zoom >= thresholds\.minZoom/);
  });

  it('schedules one overlay rebuild when zoom interactions cross layer visibility thresholds', () => {
    const applyTransform = findClassMethod('MapComponent', 'applyTransform');
    const applyBody = applyTransform.getText(sourceFile);
    const updateZoomLayerVisibility = findClassMethod('MapComponent', 'updateZoomLayerVisibility');
    const updateBody = updateZoomLayerVisibility.getText(sourceFile);

    assert.match(applyBody, /rebuildOnZoomVisibilityChange = true/);
    assert.match(applyBody, /const zoomVisibilityChanged = this\.updateZoomLayerVisibility\(\)/);
    assert.match(
      applyBody,
      /if \(rebuildOnZoomVisibilityChange && zoomVisibilityChanged\) this\.scheduleRender\(\)/,
    );
    assert.ok(mapSrc.includes("SVG_MARKER_DOM_ZOOM_LAYERS = new Set<keyof MapLayers>(['bases', 'nuclear'])"));
    assert.match(updateBody, /let visibilityChanged = false/);
    assert.match(updateBody, /const wasVisible = !this\.wrapper\.hasAttribute\(hiddenAttr\)/);
    assert.match(updateBody, /const affectsSvgMarkerDom = MapComponent\.SVG_MARKER_DOM_ZOOM_LAYERS\.has\(layer\)/);
    assert.match(updateBody, /if \(affectsSvgMarkerDom && wasVisible !== isVisible\) visibilityChanged = true/);
    assert.match(updateBody, /return visibilityChanged/);
  });

  it('does not schedule another rebuild from render-time transform syncs', () => {
    const renderWithSize = findClassMethod('MapComponent', 'renderWithSize');
    const renderCalls = renderWithSize.getText(sourceFile).match(/this\.applyTransform\(false\)/g) ?? [];
    const initialDynamicPass = findClassMethod('MapComponent', 'renderInitialDynamicPass');

    assert.equal(renderCalls.length, 2, 'renderWithSize should opt out for both render-time transform syncs');
    assert.match(initialDynamicPass.getText(sourceFile), /this\.applyTransform\(false\)/);
  });

  for (const { layer, markerClass } of [
    { layer: 'nuclear', markerClass: 'nuclear-marker' },
    { layer: 'bases', markerClass: 'base-marker' },
  ]) {
    it(`does not create ${markerClass} nodes while ${layer} is zoom-hidden`, () => {
      const renderOverlays = findClassMethod('MapComponent', 'renderOverlays');
      const assignments = classNameAssignments(renderOverlays, markerClass);

      assert.equal(assignments.length, 1, `expected one ${markerClass} assignment`);
      const guarded = assignments[0].ancestors.some((ancestor) => hasZoomGate(ancestor, layer));

      assert.equal(
        guarded,
        true,
        `${markerClass} DOM allocation must sit inside the ${layer} zoom visibility gate`,
      );
    });
  }
});
