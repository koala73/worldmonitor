import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function parseSource(relPath) {
  const fileName = resolve(root, relPath);
  const source = readFileSync(fileName, 'utf-8');
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function staticValueImports(sourceFile) {
  return sourceFile.statements
    .filter(ts.isImportDeclaration)
    .filter((statement) => !statement.importClause?.isTypeOnly)
    .map((statement) => statement.moduleSpecifier)
    .filter(ts.isStringLiteral)
    .map((specifier) => specifier.text);
}

function dynamicImportSpecifiers(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function mapContainerClass(sourceFile) {
  const cls = sourceFile.statements.find((statement) => (
    ts.isClassDeclaration(statement) && statement.name?.text === 'MapContainer'
  ));
  assert.ok(cls, 'MapContainer class should exist');
  return cls;
}

function classMemberNames(cls) {
  return new Set(cls.members
    .filter((member) => ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member))
    .map((member) => member.name)
    .filter(ts.isIdentifier)
    .map((name) => name.text));
}

function methodBodyText(cls, methodName) {
  const method = cls.members.find((member) => (
    ts.isMethodDeclaration(member)
    && ts.isIdentifier(member.name)
    && member.name.text === methodName
  ));
  assert.ok(method?.body, `MapContainer.${methodName} should have a method body`);
  return method.body.getText();
}

describe('map renderer deferral boundary', () => {
  it('keeps MapContainer free of top-level renderer/runtime value imports', () => {
    const mapContainer = parseSource('src/components/MapContainer.ts');
    const imports = staticValueImports(mapContainer);
    const forbidden = [
      './Map',
      './DeckGLMap',
      './GlobeMap',
      'maplibre-gl/dist/maplibre-gl.css',
      'maplibre-gl',
      'pmtiles',
      'globe.gl',
    ];

    for (const specifier of forbidden) {
      assert.ok(
        !imports.includes(specifier),
        `MapContainer must not statically import renderer/runtime value ${specifier}`,
      );
    }
  });

  it('loads each concrete renderer through an explicit dynamic import', () => {
    const mapContainer = parseSource('src/components/MapContainer.ts');
    const imports = new Set(dynamicImportSpecifiers(mapContainer));

    assert.ok(imports.has('./Map'), 'SVG fallback renderer should be loaded on demand');
    assert.ok(imports.has('./DeckGLMap'), 'DeckGL renderer should be loaded on demand');
    assert.ok(imports.has('./GlobeMap'), 'Globe renderer should be loaded on demand');
    assert.ok(imports.has('maplibre-gl/dist/maplibre-gl.css'), 'MapLibre CSS should load with the DeckGL renderer');
  });

  it('caches renderer data calls that can arrive before the deferred renderer exists', () => {
    const mapContainer = parseSource('src/components/MapContainer.ts');
    const cls = mapContainerClass(mapContainer);
    const members = classMemberNames(cls);

    for (const field of ['cachedTrafficAnomalies', 'cachedDdosLocations', 'cachedChokepointData']) {
      assert.ok(members.has(field), `MapContainer should cache ${field} for deferred renderer replay`);
    }

    const rehydrateBody = methodBodyText(cls, 'rehydrateActiveMap');
    const setterExpectations = [
      ['setTrafficAnomalies', 'cachedTrafficAnomalies'],
      ['setDdosLocations', 'cachedDdosLocations'],
      ['setChokepointData', 'cachedChokepointData'],
    ];

    for (const [setter, cacheField] of setterExpectations) {
      const setterBody = methodBodyText(cls, setter);
      assert.match(
        setterBody,
        new RegExp(`this\\.${cacheField}\\s*=`),
        `${setter} should update ${cacheField}`,
      );
      assert.match(
        rehydrateBody,
        new RegExp(`this\\.${setter}\\(this\\.${cacheField}\\)`),
        `rehydrateActiveMap should replay ${setter}`,
      );
    }
  });

  it('gates desktop DeckGL startup behind viewport idle or first interaction', () => {
    const mapContainer = parseSource('src/components/MapContainer.ts');
    const cls = mapContainerClass(mapContainer);
    const members = classMemberNames(cls);

    assert.ok(
      members.has('rendererDemandCleanup'),
      'MapContainer should keep a cleanup handle for pending renderer demand listeners',
    );

    const initBody = methodBodyText(cls, 'init');
    assert.match(
      initBody,
      /await\s+this\.waitForDeckRendererDemand\(token\)[\s\S]*await\s+this\.createDeckGLMap\(token\)/,
      'DeckGL renderer creation should wait for the demand gate before importing maplibre/deck',
    );

    const demandBody = methodBodyText(cls, 'waitForDeckRendererDemand');
    assert.match(demandBody, /IntersectionObserver/, 'demand gate should observe map viewport visibility');
    assert.match(demandBody, /requestIdleCallback/, 'visible maps should wait for browser idle before loading DeckGL');
    assert.match(demandBody, /pointerdown/, 'first map pointer interaction should release the demand gate');
    assert.match(demandBody, /wheel/, 'first map wheel interaction should release the demand gate');
    assert.match(demandBody, /touchstart/, 'first touch interaction should release the demand gate');
    assert.match(
      demandBody,
      /idleFallbackDelayId[\s\S]*window\.clearTimeout\(idleFallbackDelayId\)/,
      'requestIdleCallback fallback timers should be canceled when the demand wait is cleaned up',
    );
    assert.match(
      demandBody,
      /fallbackDelayId\s*=\s*window\.setTimeout\([\s\S]*DECK_RENDERER_MAX_WAIT_MS/,
      'demand gate must arm a universal backstop timer (not only when IntersectionObserver is absent) so an off-screen / partially-visible / deferred-mounted map always loads instead of hanging on the shell',
    );
  });
});
