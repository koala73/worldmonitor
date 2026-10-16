#!/usr/bin/env node
// Builds public/deck.html: the stage deck (deck/verified-truth-stage.html, or
// a path you pass) with the live WorldMonitor scenes plugged in. The deck's
// own content is not edited; two tags are added, so a new version of the
// deck can be dropped in and re-installed:
//   npm run deck                      # from deck/verified-truth-stage.html
//   npm run deck -- ~/Downloads/new-stage.html
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = process.argv[2] ?? fileURLToPath(new URL('../deck/verified-truth-stage.html', import.meta.url));
const out = fileURLToPath(new URL('../public/deck.html', import.meta.url));
let html = readFileSync(src, 'utf8');
if (!html.includes('</head>') || !html.includes('</body>')) throw new Error('deck has no </head> or </body>');
html = html.replace('</head>', '<link rel="stylesheet" href="deck-live.css">\n</head>');
const at = html.lastIndexOf('</body>');
html = `${html.slice(0, at)}<script type="module" src="deck-live.js"></script>\n${html.slice(at)}`;
writeFileSync(out, html);
console.log(`Deck installed -> ${out} (${(html.length / 1e6).toFixed(1)} MB)`);
