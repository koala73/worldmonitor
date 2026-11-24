#!/usr/bin/env node
// Decides which agent-browser calls a dogfood agent may make. run-agent.sh puts a wrapper first on PATH that runs
// this before every call and refuses the call when it prints a reason.
//
// agent-browser can do more than browse: `plugin`/`plugins` and --engine or --executable-path run programs the
// caller names, `download`, `state` and `upload` move files, and a config file can load a plugin at launch. So
// every run allows only the browsing commands below and refuses the global options that change what runs.
//
// A locked-down run is one whose browser holds a Pro session. The key sits in an HttpOnly cookie, which page
// JavaScript cannot read, but Chrome's debugging port can: a page served from 127.0.0.1:<port> may open the
// DevTools socket and list every cookie. A locked-down run therefore also refuses everything that runs JavaScript
// the agent chose: `eval`, and every option outside a short allowlist, because several options evaluate
// JavaScript (`wait --fn`, `--restore-check-fn`, `--init-script`, `--enable`) and new ones can appear. It also
// refuses network mocking (`network route` can serve a script), `get cdp-url`, and URL arguments that are not
// https on a worldmonitor.app host, including the ones `read`, `tab new` and `record start` would load. Navigation
// the agent starts can then reach only the product's own hosts; a page reached by clicking a third-party link
// cannot learn the debugging port or a target id.
//
// Usage: node browser-guard.mjs <0|1 locked down> <agent-browser args...>   (exit 2 with a reason when refused)
import { isMainModule } from '../lib/main-module.mjs';

const COMMANDS = new Set([
  'open', 'goto', 'navigate', 'read', 'back', 'forward', 'reload', 'wait', 'snapshot', 'screenshot', 'click',
  'dblclick', 'type', 'fill', 'press', 'keyboard', 'hover', 'focus', 'check', 'uncheck', 'select', 'drag', 'scroll',
  'scrollintoview', 'get', 'is', 'find', 'eval', 'errors', 'console', 'network', 'record', 'set', 'tab', 'frame',
  'mouse', 'dialog', 'skills', 'close',
]);
const REFUSED_OPTIONS = [
  '--executable-path', '--engine', '--config', '--extension', '--init-script', '--args', '--provider', '--proxy',
  '--allowed-domains', '--allow-file-access', '--auto-connect', '--cdp', '--profile', '--state', '--credential-provider',
  '--restore', '--restore-save', '--restore-check-url', '--restore-check-text', '--restore-check-fn', '--session-name',
  '--namespace', '--enable',
];
/**
 * Options a locked-down call may carry; the value-taking ones consume the next word unless it is itself an
 * option. Short forms mean different things per command (`wait -f` is `--fn`, `screenshot -f` is `--full`), so
 * a short form is allowed only on the command it was checked for.
 */
const LOCKED_FLAGS = new Set([
  '--json', '-i', '--interactive', '-c', '--compact', '-u', '--urls', '--full', '--annotate', '--delta',
  '--clear', '--raw', '--outline', '--exact', '--new-tab', '-h', '--help',
]);
const LOCKED_COMMAND_FLAGS = { screenshot: new Set(['-f']) };
const LOCKED_VALUE_OPTIONS = new Set([
  '-d', '--depth', '-s', '--selector', '--filter', '--type', '--method', '--status', '--timeout', '--label', '--fps',
  '--url', '--load', '--name', '--button', '--delay', '--count',
]);
const NAVIGATING = new Set(['open', 'goto', 'navigate', 'read']);
/**
 * Commands that load a URL given as an argument. They take no value option the agent needs, and a value option
 * they do not accept would hide a word they still load (`open --url evil.example <product url>`), so a
 * locked-down call refuses every value option on them.
 */
const DESTINATION_COMMANDS = new Set([...NAVIGATING, 'tab', 'record']);
const URL_LIKE = /:\/\/|^(javascript|data|blob|file|about|chrome|chrome-[a-z-]+|devtools|view-source|filesystem|ws|wss|http):/i;

/** True for https://worldmonitor.app or a subdomain, written plainly. */
export function isProductUrl(value) {
  if (!/^https:\/\/[a-z0-9.-]+(?:[/?#]|$)/i.test(value) || /[\\\s]/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && (host === 'worldmonitor.app' || host.endsWith('.worldmonitor.app'));
}

/** The refusal reason for one agent-browser call, or null when it may run. */
export function refusal(args, { lockedDown = false } = {}) {
  const words = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--session') { i += 1; continue; }
    if (args[i].startsWith('--session=')) continue;
    words.push(args[i]);
  }
  const [command] = words;
  if (command === undefined) return 'an agent-browser call with no command';
  if (command === '--version' || command === '-V') return null;
  if (command.startsWith('-')) return `agent-browser option ${command} before the command`;
  if (!COMMANDS.has(command)) return `agent-browser command '${command}'`;
  for (const word of words) {
    if (REFUSED_OPTIONS.some((option) => word === option || word.startsWith(`${option}=`))) return `agent-browser option ${word}`;
  }
  if (!lockedDown) return null;

  // Split options from positional words. Subcommands are then matched anywhere in the call, not only as the first
  // word after the command, so a value-taking option placed first cannot shift which word reads as the subcommand.
  const positional = [];
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    if (!word.startsWith('-')) { positional.push(word); continue; }
    const name = word.split('=')[0];
    if (LOCKED_VALUE_OPTIONS.has(name)) {
      if (DESTINATION_COMMANDS.has(command)) return `option ${name} on ${command} while the browser holds a Pro session`;
      // A following option is checked in its own right, never swallowed as this one's value: agent-browser
      // finds `--fn` anywhere in the call.
      if (!word.includes('=') && rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')) i += 1;
      continue;
    }
    if (!LOCKED_FLAGS.has(name) && !LOCKED_COMMAND_FLAGS[command]?.has(name)) {
      return `option ${name} while the browser holds a Pro session`;
    }
  }
  if (command === 'eval') return 'eval while the browser holds a Pro session';
  if (command === 'network') {
    const banned = positional.find((word) => ['route', 'unroute', 'har'].includes(word));
    if (banned || !positional.some((word) => word === 'requests' || word === 'request')) {
      return `network ${banned ?? positional[0] ?? ''} while the browser holds a Pro session`.trim();
    }
  }
  if (command === 'get' && positional.includes('cdp-url')) return 'get cdp-url';
  const offProduct = (list) => list.find((word) => !isProductUrl(word));
  if (NAVIGATING.has(command)) {
    if (positional.length === 0 && command !== 'read') return `${command} with no URL`;
    const bad = offProduct(positional);
    if (bad !== undefined) return `opening ${bad}: only https URLs on worldmonitor.app hosts`;
  }
  // `tab new [url]` loads its argument; other tab operations take ids and labels and load nothing.
  if (command === 'tab' && positional.includes('new')) {
    const bad = offProduct(positional.slice(positional.indexOf('new') + 1));
    if (bad !== undefined) return `opening ${bad}: only https URLs on worldmonitor.app hosts`;
  }
  // `record start|restart <absolute path> [url]`.
  if (command === 'record') {
    const at = positional.findIndex((word) => word === 'start' || word === 'restart');
    if (at !== -1) {
      const [path, ...urls] = positional.slice(at + 1);
      if (path !== undefined && !path.startsWith('/')) return `record to ${path}: give an absolute path`;
      const bad = offProduct(urls);
      if (bad !== undefined) return `opening ${bad}: only https URLs on worldmonitor.app hosts`;
    }
  }
  const urlArg = words.find((word) => URL_LIKE.test(word) && !isProductUrl(word));
  if (urlArg !== undefined) return `the URL ${urlArg}: only https URLs on worldmonitor.app hosts`;
  return null;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const [lockedDown, ...args] = process.argv.slice(2);
  const reason = refusal(args, { lockedDown: lockedDown === '1' });
  if (reason) {
    console.error(`dogfood: ${reason} is not allowed in this run`);
    process.exitCode = 2;
  }
}
