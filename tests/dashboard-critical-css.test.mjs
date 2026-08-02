import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function src(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

function builtSrc(relPath) {
  const absPath = resolve(repoRoot, relPath);
  assert.ok(
    existsSync(absPath),
    `${relPath} must exist before running built-output CSS assertions. Run VITE_VARIANT=full vite build first.`,
  );
  return readFileSync(absPath, 'utf8');
}

function toRepoPath(absPath) {
  return relative(repoRoot, absPath).replaceAll('\\', '/');
}

function sourceScriptKind(relPath) {
  if (relPath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relPath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function staticModuleSpecifiers(relPath) {
  const sourceText = src(relPath);
  const ast = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceScriptKind(relPath),
  );

  const specifiers = [];
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function dynamicModuleSpecifiers(relPath) {
  const sourceText = src(relPath);
  const ast = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceScriptKind(relPath),
  );

  const specifiers = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return specifiers;
}

function stripSpecifierSuffix(specifier) {
  return specifier.replace(/[?#].*$/, '');
}

function resolveCandidate(absBase) {
  const ext = extname(absBase);
  if (ext) return existsSync(absBase) ? toRepoPath(absBase) : null;

  for (const suffix of ['.ts', '.tsx', '.js', '.mjs', '.mts', '.css', '.json']) {
    const withSuffix = `${absBase}${suffix}`;
    if (existsSync(withSuffix)) return toRepoPath(withSuffix);
  }

  for (const suffix of ['.ts', '.tsx', '.js', '.mjs', '.css']) {
    const indexPath = resolve(absBase, `index${suffix}`);
    if (existsSync(indexPath)) return toRepoPath(indexPath);
  }

  return null;
}

function resolveImport(fromRelPath, rawSpecifier) {
  const specifier = stripSpecifierSuffix(rawSpecifier);
  if (specifier.startsWith('@/')) return resolveCandidate(resolve(repoRoot, 'src', specifier.slice(2)));
  if (specifier.startsWith('.')) return resolveCandidate(resolve(repoRoot, dirname(fromRelPath), specifier));
  return null;
}

function cssImportSpecifiers(relPath) {
  return [...src(relPath).matchAll(/@import\s+(?:url\()?["']([^"')]+)["']\)?/g)]
    .map((match) => match[1]);
}

function staticDependencies(relPath) {
  if (relPath.endsWith('.css')) return cssImportSpecifiers(relPath).map((specifier) => resolveImport(relPath, specifier)).filter(Boolean);
  if (!/\.[cm]?[jt]sx?$/.test(relPath)) return [];
  return staticModuleSpecifiers(relPath).map((specifier) => resolveImport(relPath, specifier)).filter(Boolean);
}

function collectStaticGraph(entryRelPath) {
  const seen = new Set();
  const stack = [entryRelPath];

  while (stack.length > 0) {
    const relPath = stack.pop();
    if (!relPath || seen.has(relPath)) continue;
    seen.add(relPath);
    for (const dep of staticDependencies(relPath)) {
      if (!seen.has(dep)) stack.push(dep);
    }
  }

  return seen;
}

function linkAttributes(linkTag) {
  const attrs = new Map();
  for (const match of linkTag.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function stylesheetHrefs(html) {
  const hrefs = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = linkAttributes(match[0]);
    const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = attrs.get('href');
    if (href?.endsWith('.css') && rels.includes('stylesheet')) hrefs.push(href);
  }
  return hrefs;
}

function stripNoscript(html) {
  return html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
}

function renderBlockingStylesheetHrefs(html) {
  const hrefs = [];
  for (const match of stripNoscript(html).matchAll(/<link\b[^>]*>/gi)) {
    const attrs = linkAttributes(match[0]);
    const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = attrs.get('href');
    const rawMedia = attrs.get('media');
    const media = rawMedia === undefined ? 'all' : rawMedia.trim().toLowerCase();
    if (!href?.endsWith('.css') || !rels.includes('stylesheet')) continue;
    if (media === 'all' || media === 'screen') hrefs.push(href);
  }
  return hrefs;
}

describe('dashboard critical CSS graph', () => {
  it('extracts stylesheet links regardless of link attribute order', () => {
    assert.deepEqual(
      stylesheetHrefs(`
        <link rel="stylesheet" href="/assets/main.css">
        <link href="/assets/settings.css" rel="preload stylesheet">
        <link href="/assets/ignored.css" rel="preload">
      `),
      ['/assets/main.css', '/assets/settings.css'],
    );
  });

  it('identifies only screen-blocking stylesheet links outside noscript fallbacks', () => {
    assert.deepEqual(
      renderBlockingStylesheetHrefs(`
        <link rel="stylesheet" href="/assets/main.css">
        <link rel="stylesheet" media="screen" href="/assets/screen.css">
        <link rel="stylesheet" media="print" href="/assets/deferred.css">
        <link rel="stylesheet" media="" href="/assets/empty-media.css">
        <noscript><link rel="stylesheet" href="/assets/nojs.css"></noscript>
      `),
      ['/assets/main.css', '/assets/screen.css'],
    );
  });

  it('keeps standalone settings window CSS out of the in-dashboard settings module', () => {
    const unifiedSettingsImports = staticModuleSpecifiers('src/components/UnifiedSettings.ts');

    assert.equal(
      unifiedSettingsImports.includes('@/styles/settings-window.css'),
      false,
      'UnifiedSettings renders inside the dashboard and must not pull standalone settings CSS onto the dashboard critical path.',
    );

    assert.equal(
      staticModuleSpecifiers('src/settings-main.ts').includes('./styles/settings-window.css'),
      true,
      'The standalone settings entry must keep importing its own settings-window stylesheet.',
    );
  });

  it('keeps standalone settings CSS out of the dashboard static import graph', () => {
    const dashboardGraph = collectStaticGraph('src/main.ts');
    const unifiedSettingsGraph = collectStaticGraph('src/components/UnifiedSettings.ts');
    const settingsGraph = collectStaticGraph('src/settings-main.ts');

    assert.equal(
      dashboardGraph.has('src/components/UnifiedSettings.ts'),
      false,
      'The dashboard static graph must keep the in-dashboard UnifiedSettings modal on the lazy interaction path.',
    );
    assert.equal(
      dashboardGraph.has('src/app/event-handlers.ts'),
      true,
      'sanity check: the dashboard static graph must still reach the lazy settings controller owner.',
    );
    assert.equal(
      dynamicModuleSpecifiers('src/app/event-handlers.ts').includes('@/components/UnifiedSettings'),
      true,
      'sanity check: the dashboard still reaches UnifiedSettings through the lazy settings controller.',
    );
    assert.equal(
      dashboardGraph.has('src/styles/settings-window.css'),
      false,
      'The dashboard static graph must not reach the standalone settings-window stylesheet.',
    );
    assert.equal(
      unifiedSettingsGraph.has('src/styles/settings-window.css'),
      false,
      'The lazy in-dashboard settings chunk must not reach the standalone settings-window stylesheet.',
    );
    assert.equal(
      settingsGraph.has('src/styles/settings-window.css'),
      true,
      'The standalone settings entry should still reach settings-window.css.',
    );
  });

  it('keeps happy variant theme CSS off the default dashboard static graph', () => {
    const dashboardGraph = collectStaticGraph('src/main.ts');

    assert.equal(
      dashboardGraph.has('src/styles/happy-theme.css'),
      false,
      'Non-happy dashboard variants must not eagerly import happy-theme.css through src/main.ts.',
    );

    assert.equal(
      dynamicModuleSpecifiers('src/main.ts').includes('./styles/happy-theme.css'),
      true,
      'The happy variant should still be able to load happy-theme.css through an explicit dynamic import.',
    );
  });

  it('keeps dashboard preferences content on dashboard-owned button styles', () => {
    const preferencesContent = src('src/services/preferences-content.ts');
    const mainCss = src('src/styles/main.css');

    assert.doesNotMatch(
      preferencesContent,
      /\bsettings-btn(?:-(?:primary|secondary))?\b/,
      'Dashboard preference controls must not rely on settings-window.css-only button classes.',
    );
    assert.match(mainCss, /\.btn\s*\{/);
    assert.match(mainCss, /\.btn-primary\s*\{/);
    assert.match(mainCss, /\.btn-secondary\s*\{/);
  });

  it('keeps in-dashboard notification channel styles on dashboard-owned CSS', () => {
    // notifications-settings.ts renders inside the dashboard UnifiedSettings modal, which no
    // longer imports settings-window.css. Any class it emits that is styled ONLY by
    // settings-window.css would render unstyled on the dashboard — its rules must live in
    // dashboard-owned main.css. (Guards the P1 that the original split introduced.)
    const notif = src('src/services/notifications-settings.ts');
    const mainCss = src('src/styles/main.css');
    const settingsWindowCss = src('src/styles/settings-window.css');

    const emitted = [...new Set([...notif.matchAll(/\bus-notif-[a-z0-9-]+/g)].map((m) => m[0]))];
    assert.ok(emitted.length > 0, 'sanity: notifications-settings.ts should emit us-notif-* classes');

    const unstyledOnDashboard = emitted.filter((cls) => {
      const selector = new RegExp(`\\.${cls}\\b`);
      return selector.test(settingsWindowCss) && !selector.test(mainCss);
    });
    assert.deepEqual(
      unstyledOnDashboard,
      [],
      `Notification channel classes rendered on the dashboard are styled only by settings-window.css (unstyled after the critical-CSS split): ${unstyledOnDashboard.join(', ')}`,
    );
  });

  it('does not link or merge the settings-only stylesheet into built dashboard.html', () => {
    const dashboardHtml = builtSrc('dist/dashboard.html');
    const hrefs = stylesheetHrefs(dashboardHtml);
    const settingsStylesheets = hrefs.filter((href) =>
      /\/assets\/settings(?:-(?:persistence|window))?-[A-Za-z0-9_-]+\.css$/.test(href)
    );

    assert.deepEqual(
      settingsStylesheets,
      [],
      'Built dashboard.html must not render-block on the settings-only stylesheet.',
    );

    const standaloneSettingsSelectors = [
      '.settings-shell',
      '.settings-sidebar',
      '.settings-main',
      '.settings-content',
      '.settings-titlebar',
    ];
    const dashboardCss = hrefs
      .map((href) => builtSrc(`dist/${href.replace(/^\//, '')}`))
      .join('\n');
    for (const selector of standaloneSettingsSelectors) {
      assert.equal(
        dashboardCss.includes(selector),
        false,
        `Built dashboard stylesheets must not include standalone settings selector ${selector}.`,
      );
    }

    assert.ok(
      dashboardCss.includes('.us-notif-ch-row'),
      'Built dashboard stylesheets must include the in-modal notification channel styles (relocated to main.css).',
    );

    if (existsSync(resolve(repoRoot, 'dist/settings.html'))) {
      const settingsHrefs = stylesheetHrefs(builtSrc('dist/settings.html'));
      assert.ok(
        settingsHrefs.some((href) => /\/assets\/settings(?:-(?:persistence|window))?-[A-Za-z0-9_-]+\.css$/.test(href)),
        'Built settings.html should still link the settings-only stylesheet for the standalone settings window.',
      );
      const settingsCss = settingsHrefs
        .map((href) => builtSrc(`dist/${href.replace(/^\//, '')}`))
        .join('\n');
      assert.equal(
        standaloneSettingsSelectors.every((selector) => settingsCss.includes(selector)),
        true,
        'Built settings.html stylesheets should still include standalone settings selectors.',
      );
    }
  });

  it('keeps large dashboard CSS off the render-blocking stylesheet path', () => {
    const dashboardHtml = builtSrc('dist/dashboard.html');
    const blockingHrefs = renderBlockingStylesheetHrefs(dashboardHtml);

    assert.deepEqual(
      blockingHrefs,
      [],
      `Built dashboard.html must not render-block on app CSS; found ${blockingHrefs.join(', ')}`,
    );

    const deferredHrefs = [];
    for (const match of stripNoscript(dashboardHtml).matchAll(/<link\b[^>]*>/gi)) {
      const attrs = linkAttributes(match[0]);
      if (
        attrs.get('data-wm-deferred-style') === 'dashboard' &&
        attrs.get('media') === 'print' &&
        attrs.get('href')?.endsWith('.css')
      ) {
        deferredHrefs.push(attrs.get('href'));
      }
    }
    assert.ok(deferredHrefs.length > 0, 'Built dashboard.html should still request app CSS on a deferred stylesheet path.');

    const noscriptLinkTags = [...dashboardHtml.matchAll(/<noscript>\s*(<link\b[^>]*>)\s*<\/noscript>/gi)].map((m) => m[1]);
    for (const href of deferredHrefs) {
      const hasFallback = noscriptLinkTags.some((tag) => {
        const attrs = linkAttributes(tag);
        const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
        return attrs.get('href') === href && rels.includes('stylesheet');
      });
      assert.ok(
        hasFallback,
        `Deferred dashboard stylesheet ${href} must keep a no-JS stylesheet fallback (rel=stylesheet, any attribute order).`,
      );
    }
  });
});
