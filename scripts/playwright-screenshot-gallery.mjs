#!/usr/bin/env node
/**
 * Build a scan-friendly Playwright screenshot gallery from a test-results tree.
 *
 * Usage:
 *   node scripts/playwright-screenshot-gallery.mjs <results-dir> <output-dir>
 *   node scripts/playwright-screenshot-gallery.mjs --merge-history <existing-history.json> <output-dir>
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_HISTORY = 100;

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '\u0026amp;')
    .replaceAll('"', '\u0026quot;')
    .replaceAll("'", '\u0026#039;')
    .replaceAll('<', '\u0026lt;')
    .replaceAll('>', '\u0026gt;');
}

export function titleFromFileName(fileName) {
  return fileName
    .replace(/\.png$/i, '')
    .replace(/^\d+-/, '')
    .replaceAll(/[-_]+/g, ' ')
    .trim();
}

export function sanitizeFileName(fileName) {
  return fileName.replaceAll(/[^a-zA-Z0-9._-]/g, '-');
}

export function isHttpsUrl(value) {
  return typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:';
}

export function updateRunHistory(existingHistory, run) {
  const history = Array.isArray(existingHistory)
    ? existingHistory.filter(isPublishedRun)
    : [];
  return [
    run,
    ...history.filter((previous) => previous.id !== run.id || previous.attempt !== run.attempt),
  ]
    .sort((left, right) => {
      if (left.id !== right.id) return left.id > right.id ? -1 : 1;
      return right.attempt - left.attempt;
    })
    .slice(0, MAX_HISTORY);
}

function isPublishedRun(value) {
  if (!value || typeof value !== 'object') return false;
  const run = value;
  return (
    typeof run.attempt === 'number' &&
    typeof run.branch === 'string' &&
    typeof run.createdAt === 'string' &&
    typeof run.event === 'string' &&
    typeof run.id === 'string' &&
    typeof run.result === 'string' &&
    typeof run.runNumber === 'number' &&
    typeof run.screenshotCount === 'number' &&
    typeof run.sha === 'string' &&
    (run.reportUrl === '' || isHttpsUrl(run.reportUrl)) &&
    (run.runUrl === '' || isHttpsUrl(run.runUrl)) &&
    (run.screenshotsUrl === '' || isHttpsUrl(run.screenshotsUrl))
  );
}

export function renderDashboard(history) {
  const data = JSON.stringify(history).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>Playwright · World Monitor</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #070b10; color: #f4f1ea; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #16324a 0, #070b10 34rem); }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 64px 0; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 32px; }
    h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.6rem); letter-spacing: -0.06em; }
    .eyebrow { margin: 0 0 10px; color: #7dd3c7; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
    .subtitle { margin: 10px 0 0; color: #9aa4b2; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card, .table-wrap { border: 1px solid rgba(125, 211, 199, 0.18); border-radius: 18px; background: rgba(7, 11, 16, 0.78); }
    .card { padding: 20px; }
    .label { color: #9aa4b2; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
    .value { display: block; margin-top: 8px; font-size: 1.5rem; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 16px 18px; border-bottom: 1px solid rgba(63, 63, 70, 0.72); text-align: left; }
    th { color: #9aa4b2; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; }
    .status { font-weight: 700; text-transform: capitalize; }
    .status.success { color: #4ade80; }
    .status.failure, .status.cancelled { color: #fb7185; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .links a { color: #7dd3c7; text-decoration: none; margin-right: 12px; }
    .empty { padding: 56px 24px; color: #9aa4b2; text-align: center; }
    @media (max-width: 760px) {
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .table-wrap { overflow-x: auto; }
      table { min-width: 880px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">World Monitor · visual evidence</p>
        <h1>Playwright</h1>
        <p class="subtitle">Named chrome captures and results from the deterministic e2e suite. Not a merge gate.</p>
      </div>
    </header>
    <section class="summary" id="summary"></section>
    <section class="table-wrap">
      <table>
        <thead>
          <tr><th>Result</th><th>Run</th><th>Commit</th><th>Trigger</th><th>Screenshots</th><th>Published</th><th>Links</th></tr>
        </thead>
        <tbody id="runs"></tbody>
      </table>
      <div class="empty" id="empty" hidden>No Playwright runs have been published yet.</div>
    </section>
  </main>
  <script>
    const history = ${data};
    const runs = document.querySelector("#runs");
    const empty = document.querySelector("#empty");
    const summary = document.querySelector("#summary");
    if (history.length === 0) empty.hidden = false;
    const latest = history[0];
    const recent = history.slice(0, 10);
    const recentPassing = recent.filter((run) => run.result === "success").length;
    const cards = [
      ["Latest result", latest?.result ?? "No runs"],
      ["Latest screenshots", latest ? String(latest.screenshotCount) : "\u2014"],
      ["Recent pass rate", recent.length ? Math.round((recentPassing / recent.length) * 100) + "%" : "\u2014"],
      ["Stored runs", String(history.length)],
    ];
    for (const [label, value] of cards) {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = "";
      const labelEl = document.createElement("span");
      labelEl.className = "label";
      labelEl.textContent = label;
      const valueEl = document.createElement("span");
      valueEl.className = "value";
      valueEl.textContent = value;
      card.append(labelEl, valueEl);
      summary.append(card);
    }
    for (const [index, run] of history.entries()) {
      const row = document.createElement("tr");
      const result = document.createElement("td");
      const status = document.createElement("span");
      status.className = "status " + (["success", "failure", "cancelled"].includes(run.result) ? run.result : "other");
      status.textContent = run.result;
      result.append(status);
      const runNumber = document.createElement("td");
      runNumber.textContent = "#" + run.runNumber + " \u00b7 attempt " + run.attempt;
      const commit = document.createElement("td");
      commit.className = "mono";
      commit.textContent = run.sha.slice(0, 7);
      const event = document.createElement("td");
      event.textContent = run.event + " \u00b7 " + run.branch;
      const shots = document.createElement("td");
      shots.textContent = String(run.screenshotCount);
      const published = document.createElement("td");
      published.textContent = new Date(run.createdAt).toLocaleString();
      const links = document.createElement("td");
      links.className = "links";
      const screenshotsHref = run.screenshotsUrl || (index === 0 ? "screenshots/index.html" : "");
      if (screenshotsHref) {
        const a = document.createElement("a");
        a.href = screenshotsHref;
        a.textContent = "Screenshots";
        links.append(a);
      }
      if (run.reportUrl) {
        const a = document.createElement("a");
        a.href = run.reportUrl;
        a.textContent = "Report";
        links.append(a);
      }
      if (run.runUrl) {
        const a = document.createElement("a");
        a.href = run.runUrl;
        a.textContent = "Actions";
        links.append(a);
      }
      row.append(result, runNumber, commit, event, shots, published, links);
      runs.append(row);
    }
  </script>
</body>
</html>`;
}

export function renderScreenshotGallery(input) {
  const screenshots = input.screenshots
    .map(
      (screenshot, index) => `
        <figure>
          <a href="${escapeHtml(screenshot.fileName)}" target="_blank" rel="noreferrer">
            <img src="${escapeHtml(screenshot.fileName)}" alt="${escapeHtml(screenshot.title)}" loading="lazy" />
          </a>
          <figcaption>
            <span class="number">${String(index + 1).padStart(2, '0')}</span>
            <span><strong>${escapeHtml(screenshot.title)}</strong><small>${escapeHtml(screenshot.source)}</small></span>
          </figcaption>
        </figure>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>Run screenshots · World Monitor</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #070b10; color: #f4f1ea; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #16324a 0, #070b10 36rem); }
    main { width: min(1440px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0 80px; }
    h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.2rem); letter-spacing: -0.06em; }
    .eyebrow { margin: 0 0 10px; color: #7dd3c7; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
    .subtitle { margin: 10px 0 0; color: #9aa4b2; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; margin: 24px 0 28px; }
    .pill { padding: 8px 12px; border: 1px solid rgba(125, 211, 199, 0.28); border-radius: 999px; color: #d4d4d8; }
    .gallery { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
    figure { margin: 0; overflow: hidden; border: 1px solid rgba(125, 211, 199, 0.18); border-radius: 18px; background: rgba(7, 11, 16, 0.84); }
    figure > a { display: grid; min-height: 240px; place-items: center; padding: 12px; background: #101820; }
    img { display: block; width: 100%; max-height: 820px; object-fit: contain; object-position: top; border-radius: 10px; }
    figcaption { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-top: 1px solid rgba(63, 63, 70, 0.72); }
    figcaption strong, figcaption small { display: block; }
    figcaption small { margin-top: 4px; color: #7a8490; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .number { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 50%; color: #042f2e; background: #7dd3c7; font-size: 0.78rem; font-weight: 700; }
    .empty { padding: 80px 24px; color: #9aa4b2; text-align: center; }
    @media (max-width: 900px) { .gallery { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">World Monitor · visual review</p>
      <h1>Run screenshots</h1>
      <p class="subtitle">Scan every captured product state from this Playwright run.</p>
    </header>
    <section class="meta">
      <span class="pill">${escapeHtml(input.result)}</span>
      <span class="pill">${escapeHtml(input.sha.slice(0, 7))}</span>
      <span class="pill">${input.screenshots.length} screenshots</span>
      <span class="pill">${escapeHtml(input.createdAt)} UTC</span>
    </section>
    ${screenshots ? `<section class="gallery">${screenshots}</section>` : '<div class="empty">No screenshots were produced by this run.</div>'}
  </main>
</body>
</html>`;
}

export async function collectPngFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === 'attachments') return [];
      if (entry.isDirectory()) return collectPngFiles(entryPath);
      return entry.isFile() && entry.name.toLowerCase().endsWith('.png') ? [entryPath] : [];
    }),
  );
  return files.flat();
}

export async function buildGallery({ resultsDir, outputDir, history = [], meta }) {
  const pngs = (await collectPngFiles(resultsDir)).sort((left, right) =>
    path.basename(left).localeCompare(path.basename(right)),
  );
  const imageDir = path.join(outputDir, 'screenshots', 'images');
  await mkdir(imageDir, { recursive: true });

  const screenshots = [];
  for (const [index, file] of pngs.entries()) {
    const fileName = `${String(index + 1).padStart(3, '0')}-${sanitizeFileName(path.basename(file))}`;
    await copyFile(file, path.join(imageDir, fileName));
    screenshots.push({
      fileName: `images/${fileName}`,
      source: path.relative(resultsDir, file),
      title: titleFromFileName(path.basename(file)),
    });
  }

  const run = {
    attempt: meta.attempt,
    branch: meta.branch,
    createdAt: meta.createdAt,
    event: meta.event,
    id: meta.id,
    reportUrl: meta.reportUrl ?? '',
    result: meta.result,
    runNumber: meta.runNumber,
    runUrl: meta.runUrl ?? '',
    screenshotCount: screenshots.length,
    screenshotsUrl: meta.screenshotsUrl ?? '',
    sha: meta.sha,
  };
  const nextHistory = updateRunHistory(history, run);

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'history.json'), `${JSON.stringify(nextHistory, null, 2)}\n`);
  await writeFile(path.join(outputDir, 'index.html'), renderDashboard(nextHistory));
  await writeFile(
    path.join(outputDir, 'screenshots', 'index.html'),
    renderScreenshotGallery({
      createdAt: meta.createdAt,
      result: meta.result,
      sha: meta.sha,
      screenshots,
    }),
  );

  return { screenshots, history: nextHistory };
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return fallback;
    throw error;
  }
}

export async function mergePublishedHistory({ outputDir, existingHistoryPath }) {
  const currentHistory = await readJsonFile(path.join(outputDir, 'history.json'), []);
  const currentRun = Array.isArray(currentHistory) ? currentHistory[0] : null;
  if (!isPublishedRun(currentRun)) {
    throw new Error('gallery/history.json does not contain a publishable current run');
  }
  const existing = existingHistoryPath ? await readJsonFile(existingHistoryPath, []) : [];
  const nextHistory = updateRunHistory(existing, currentRun);
  await writeFile(path.join(outputDir, 'history.json'), `${JSON.stringify(nextHistory, null, 2)}\n`);
  await writeFile(path.join(outputDir, 'index.html'), renderDashboard(nextHistory));
  return { history: nextHistory };
}

function readMetaFromEnv() {
  const now = new Date().toISOString();
  return {
    attempt: Number(process.env.PLAYWRIGHT_RUN_ATTEMPT ?? 1),
    branch: process.env.PLAYWRIGHT_BRANCH ?? 'local',
    createdAt: now,
    event: process.env.PLAYWRIGHT_EVENT ?? 'local',
    id: process.env.PLAYWRIGHT_RUN_ID ?? String(Date.now()),
    reportUrl: process.env.PLAYWRIGHT_REPORT_URL ?? '',
    result: process.env.PLAYWRIGHT_RESULT ?? 'success',
    runNumber: Number(process.env.PLAYWRIGHT_RUN_NUMBER ?? 0),
    runUrl: process.env.PLAYWRIGHT_RUN_URL ?? '',
    screenshotsUrl: process.env.PLAYWRIGHT_SCREENSHOTS_URL ?? '',
    sha: process.env.PLAYWRIGHT_SHA ?? 'local',
  };
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args[0] === '--merge-history') {
    const existingHistoryPath = args[1];
    const outputDir = args[2];
    if (!existingHistoryPath || !outputDir) {
      throw new Error(
        'Usage: node scripts/playwright-screenshot-gallery.mjs --merge-history <existing-history.json> <output-dir>',
      );
    }
    const { history } = await mergePublishedHistory({ outputDir, existingHistoryPath });
    console.log(`Merged ${history.length} runs into ${outputDir}`);
  } else {
    const [resultsDir, outputDir] = args;
    if (!resultsDir || !outputDir) {
      throw new Error('Usage: node scripts/playwright-screenshot-gallery.mjs <results-dir> <output-dir>');
    }
    const { screenshots } = await buildGallery({
      resultsDir,
      outputDir,
      meta: readMetaFromEnv(),
    });
    console.log(`Wrote ${screenshots.length} screenshots to ${outputDir}`);
  }
}
