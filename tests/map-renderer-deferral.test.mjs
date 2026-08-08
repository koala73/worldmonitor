import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs']);

function rootRelative(fileName) {
  return relative(root, fileName) || '.';
}

function parseSource(relPath) {
  const fileName = resolve(root, relPath);
  const source = readFileSync(fileName, 'utf-8');
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function staticValueImports(sourceFile) {
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }
  return specifiers;
}

function sourcePathCandidate(base) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.mjs`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
    resolve(base, 'index.js'),
    resolve(base, 'index.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function isSourceFile(fileName) {
  return sourceExtensions.has(extname(fileName));
}

function tsconfigPathMappings() {
  const configPath = resolve(root, 'tsconfig.json');
  const source = readFileSync(configPath, 'utf-8');
  const parsed = ts.parseConfigFileTextToJson(configPath, source);
  assert.ifError(parsed.error ? new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')) : null);
  const paths = parsed.config?.compilerOptions?.paths ?? {};
  return Object.entries(paths).flatMap(([pattern, targets]) => (
    (Array.isArray(targets) ? targets : []).map((target) => ({ pattern, target }))
  ));
}

let cachedPathMappings = null;

function pathMappings() {
  cachedPathMappings ??= tsconfigPathMappings();
  return cachedPathMappings;
}

function matchPathPattern(specifier, pattern) {
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex === -1) {
    return specifier === pattern ? '' : null;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;

  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function resolvePathMappedSource(specifier) {
  let matchedPath = false;
  for (const { pattern, target } of pathMappings()) {
    const matched = matchPathPattern(specifier, pattern);
    if (matched === null) continue;
    matchedPath = true;
    const targetBase = target.replace('*', matched);
    const resolved = sourcePathCandidate(resolve(root, targetBase));
    if (resolved) return { matched: true, fileName: resolved };
  }
  return { matched: matchedPath, fileName: null };
}

function resolveInRepoSpecifier(fromFileName, specifier) {
  if (specifier.startsWith('.')) {
    const resolved = sourcePathCandidate(resolve(dirname(fromFileName), specifier));
    assert.ok(
      resolved,
      `Static import ${specifier} from ${rootRelative(fromFileName)} must resolve to a real file`,
    );
    return resolved;
  }

  const resolved = resolvePathMappedSource(specifier);
  if (resolved.fileName || !resolved.matched) return resolved.fileName;

  assert.fail(`Static path alias import ${specifier} from ${rootRelative(fromFileName)} must resolve to a real file`);
}

function staticValueImportGraph(entryRelPath) {
  const visited = new Set();
  const imports = new Set();

  const visit = (relOrAbsPath) => {
    const fileName = relOrAbsPath.startsWith(root) ? relOrAbsPath : resolve(root, relOrAbsPath);
    if (visited.has(fileName)) return;
    visited.add(fileName);
    const sourceFile = parseSource(fileName);

    for (const specifier of staticValueImports(sourceFile)) {
      imports.add(specifier);
      const resolved = resolveInRepoSpecifier(sourceFile.fileName, specifier);
      if (resolved && isSourceFile(resolved)) visit(resolved);
    }
  };

  visit(entryRelPath);
  return imports;
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

function findClass(sourceFile, className) {
  const cls = sourceFile.statements.find((statement) => (
    ts.isClassDeclaration(statement) && statement.name?.text === className
  ));
  assert.ok(cls, `${className} class should exist`);
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

  it('keeps optional deck.gl specialty packages out of the base WebGL renderer chunk', () => {
    const imports = staticValueImportGraph('src/components/DeckGLMap.ts');
    const forbidden = [
      '@deck.gl/aggregation-layers',
      '@deck.gl/geo-layers',
      '@deck.gl/extensions',
      'pmtiles',
      '@protomaps/basemaps',
      'h3-js',
    ];

    for (const specifier of forbidden) {
      assert.ok(
        !imports.has(specifier),
        `DeckGLMap import graph must avoid static optional WebGL package ${specifier}`,
      );
    }
  });

  it('walks tsconfig path aliases in the DeckGLMap static import graph', () => {
    const imports = staticValueImportGraph('src/components/DeckGLMap.ts');

    assert.ok(
      imports.has('@/services/bootstrap'),
      'DeckGLMap graph should traverse @/-aliased transitive imports, not only direct relative imports',
    );
    assert.ok(
      imports.has('./feeds'),
      'DeckGLMap graph should resolve @/config and traverse its relative re-export edges',
    );
  });

  it('fails loudly when an in-repo static import edge cannot be resolved', () => {
    assert.throws(
      () => resolveInRepoSpecifier(resolve(root, 'src/components/DeckGLMap.ts'), '@/missing/deckgl-test-fixture'),
      /must resolve to a real file/,
    );
    assert.throws(
      () => resolveInRepoSpecifier(resolve(root, 'src/components/DeckGLMap.ts'), './missing-deckgl-test-fixture'),
      /must resolve to a real file/,
    );
  });

  it('keeps provider-specific PMTiles deps out of the emitted MapLibre manual chunk', () => {
    const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf-8');

    assert.match(
      viteConfig,
      /id\.includes\('\/pmtiles\/'\)[\s\S]*id\.includes\('\/@protomaps\/basemaps\/'\)[\s\S]*return 'protomaps'/,
      'PMTiles and Protomaps must share a provider-specific lazy chunk',
    );
    assert.doesNotMatch(
      viteConfig,
      /if\s*\([^{]*id\.includes\('\/pmtiles\/'\)[^{]*\)\s*\{\s*return 'maplibre'/,
      'MapLibre manual chunk must not include PMTiles provider code',
    );
    assert.doesNotMatch(
      viteConfig,
      /if\s*\([^{]*id\.includes\('\/@protomaps\/basemaps\/'\)[^{]*\)\s*\{\s*return 'maplibre'/,
      'MapLibre manual chunk must not include Protomaps basemap code',
    );
  });

  // Real bundle-output guard. The static import-graph and vite.config text checks
  // above cannot prove the split actually happened: staticValueImportGraph does not
  // follow @/-aliased imports into basemap-styles.ts (where pmtiles/@protomaps/basemaps
  // live), and a config-text regex says nothing about the emitted bundle. When a build
  // is present, assert the split survived in dist — the #4382 onlyExplicitManualChunks
  // fold-back stays green in source-level tests and only surfaces in the real output.
  it('emits provider-specific WebGL vendor chunks that stay lazy in the real build', () => {
    const assetsDir = resolve(root, 'dist/assets');
    if (!existsSync(assetsDir)) return; // no build present — runs meaningfully post-build (CI)

    const assets = readdirSync(assetsDir);
    const findChunk = (name) => assets.find((file) => new RegExp(`^${name}-[A-Za-z0-9_-]+\\.js$`).test(file));

    const maplibre = findChunk('maplibre');
    const deckStack = findChunk('deck-stack');
    const protomaps = findChunk('protomaps');
    const h3 = findChunk('h3-js');

    // Fold-back guard: if pmtiles/@protomaps/basemaps or h3-js regress back into the
    // shared vendor chunks, their dedicated chunks disappear (the #4382 failure mode).
    assert.ok(maplibre, 'maplibre vendor chunk must be emitted');
    assert.ok(deckStack, 'deck-stack vendor chunk must be emitted');
    assert.ok(protomaps, 'protomaps (pmtiles + @protomaps/basemaps) chunk must be emitted');
    assert.ok(h3, 'h3-js chunk must be emitted');

    // The whole point of the split: the maplibre chunk must not reference the
    // provider-specific chunks at all (neither static nor dynamic).
    const maplibreSrc = readFileSync(resolve(assetsDir, maplibre), 'utf-8');
    assert.doesNotMatch(maplibreSrc, /protomaps-[A-Za-z0-9_-]+\.js/, 'maplibre chunk must not reference the protomaps chunk');
    assert.doesNotMatch(maplibreSrc, /h3-js-[A-Za-z0-9_-]+\.js/, 'maplibre chunk must not reference the h3-js chunk');

    // deck-stack may reach h3-js, but only via dynamic import() so it stays lazy —
    // never a static `import"./h3-js-…"` / `from"./h3-js-…"`.
    const deckStackSrc = readFileSync(resolve(assetsDir, deckStack), 'utf-8');
    assert.doesNotMatch(
      deckStackSrc,
      /(?:import|from)\s*["']\.\/h3-js-[A-Za-z0-9_-]+\.js["']/,
      'deck-stack must load h3-js lazily (dynamic import), never as a static import',
    );

    // None of the WebGL chunks may be modulepreloaded by the dashboard entry HTML.
    const dashboard = resolve(root, 'dist/dashboard.html');
    if (existsSync(dashboard)) {
      const html = readFileSync(dashboard, 'utf-8');
      const preloads = [...html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g)].map((match) => match[1]);
      const offenders = preloads.filter((href) => /\/assets\/(?:maplibre|deck-stack|protomaps|h3-js)-[A-Za-z0-9_-]+\.js$/.test(href));
      assert.deepEqual(offenders, [], `WebGL vendor chunks must not be modulepreloaded by dashboard.html: ${offenders.join(', ')}`);
    }
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

  it('queues chokepoint popup opens that arrive before the deferred renderer exists', () => {
    const mapContainer = parseSource('src/components/MapContainer.ts');
    const cls = mapContainerClass(mapContainer);
    const members = classMemberNames(cls);

    assert.ok(
      members.has('pendingChokepointOpen'),
      'MapContainer should cache chokepoint deep-link opens for deferred renderer replay',
    );
    assert.ok(
      members.has('rendererReady'),
      'MapContainer should track concrete renderer readiness before replaying chokepoint opens',
    );
    assert.ok(
      members.has('replayPendingChokepointOpen'),
      'MapContainer should replay queued chokepoint opens from explicit renderer-ready points',
    );

    const openBody = methodBodyText(cls, 'openChokepoint');
    assert.match(
      openBody,
      /!this\.isChokepointRendererReady\(\)[\s\S]*this\.pendingChokepointOpen\s*=\s*id[\s\S]*return/,
      'openChokepoint should queue the id until the concrete renderer is ready',
    );

    const replayBody = methodBodyText(cls, 'replayPendingChokepointOpen');
    assert.match(
      replayBody,
      /this\.pendingChokepointOpen[\s\S]*this\.openChokepoint\(pendingChokepointOpen\)/,
      'replayPendingChokepointOpen should drain the queued chokepoint through the public open path',
    );

    const rehydrateBody = methodBodyText(cls, 'rehydrateActiveMap');
    assert.doesNotMatch(
      rehydrateBody,
      /pendingChokepointOpen/,
      'rehydrateActiveMap must not consume chokepoint opens before async renderer readiness/fallback settles',
    );

    const svgBody = methodBodyText(cls, 'initSvgMap');
    assert.match(
      svgBody,
      /this\.rendererReady\s*=\s*true[\s\S]*this\.replayPendingChokepointOpen\(\)/,
      'SVG fallback should replay queued chokepoint opens once it is ready',
    );

    const deckBody = methodBodyText(cls, 'createDeckGLMap');
    assert.match(
      deckBody,
      /await\s+this\.deckGLMap\.whenReady\(\)[\s\S]*this\.rendererReady\s*=\s*true[\s\S]*this\.replayPendingChokepointOpen\(\)/,
      'DeckGL should replay queued chokepoint opens only after whenReady() succeeds',
    );
  });

  // The MapContainer queue only covers "no renderer object yet". A deferred
  // renderer object can exist while its underlying map (DeckGL maplibreMap /
  // GlobeMap globe) is still being built asynchronously — rehydrateActiveMap
  // replays the queued open *before* createDeckGLMap awaits whenReady(). Each
  // renderer's setCenter no-ops until its map exists, so openChokepoint must
  // defer the pan+popup until it is ready rather than dropping it silently.
  it('defers chokepoint opens in the async WebGL/globe renderers until their map is built', () => {
    const deckBody = methodBodyText(findClass(parseSource('src/components/DeckGLMap.ts'), 'DeckGLMap'), 'openChokepoint');
    assert.match(deckBody, /this\.maplibreMap/, 'DeckGLMap.openChokepoint should gate on maplibreMap readiness');
    assert.match(deckBody, /whenReady\(\)/, 'DeckGLMap.openChokepoint should defer until whenReady() when maplibreMap is not built yet');

    const globeBody = methodBodyText(findClass(parseSource('src/components/GlobeMap.ts'), 'GlobeMap'), 'openChokepoint');
    assert.match(globeBody, /this\.globe/, 'GlobeMap.openChokepoint should gate on globe readiness');
    assert.match(globeBody, /whenReady\(\)/, 'GlobeMap.openChokepoint should defer until whenReady() when the globe is not built yet');
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
