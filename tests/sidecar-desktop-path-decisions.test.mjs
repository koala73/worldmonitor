import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/**
 * #5907: every sebuf route family under server/worldmonitor/ needs an explicit
 * desktop-path decision. A v1 family is bundled into the Tauri sidecar by
 * scripts/build-sidecar-handlers.mjs (api/{domain}/v1/[rpc].ts). A versioned
 * family (api/v{N}/{domain}/[rpc].ts) is invisible to that glob, so it must be
 * declared cloud-only in the build script AND routed to the cloud on purpose by
 * the sidecar — otherwise it only reaches the cloud through the 404 "handler
 * missing" fallback, which is an accident, and a dead end when cloudFallback
 * is off.
 */

const buildScript = readFileSync(resolve(root, 'scripts/build-sidecar-handlers.mjs'), 'utf-8');
const sidecar = readFileSync(resolve(root, 'src-tauri/sidecar/local-api-server.mjs'), 'utf-8');

function listFromSource(source, name) {
  const match = source.match(new RegExp(`const ${name} = (?:new Set\\()?\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${name} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const declaredCloudOnly = listFromSource(buildScript, 'CLOUD_ONLY_ROUTE_FAMILIES');
const sidecarCloudOnlyPrefixes = listFromSource(sidecar, 'cloudOnlyRouteFamilyPrefixes');

/** Every {domain, version} pair under server/worldmonitor/, with its api entry. */
function serverFamilies() {
  const serverRoot = resolve(root, 'server/worldmonitor');
  const families = [];
  for (const domain of readdirSync(serverRoot).sort()) {
    const domainDir = join(serverRoot, domain);
    if (!statSync(domainDir).isDirectory()) continue;
    for (const version of readdirSync(domainDir).sort()) {
      if (!/^v\d+$/.test(version)) continue;
      const bundledEntry = `api/${domain}/v1/[rpc].ts`;
      const versionedEntry = `api/${version}/${domain}/[rpc].ts`;
      families.push({
        domain,
        version,
        key: `${version}/${domain}`,
        bundled: version === 'v1' && existsSync(resolve(root, bundledEntry)),
        versioned: existsSync(resolve(root, versionedEntry)),
        urlPrefix: version === 'v1' ? `/api/${domain}/v1/` : `/api/${version}/${domain}/`,
      });
    }
  }
  return families;
}

describe('desktop path decision per server/worldmonitor route family (#5907)', () => {
  const families = serverFamilies();

  it('finds the families the repo is known to have', () => {
    assert.ok(families.length >= 36, `expected the sebuf domains, saw ${families.length}`);
    assert.ok(families.some((f) => f.key === 'v2/shipping'), 'the shipping v2 family is the case this test exists for');
  });

  it('every family has exactly one api entry the sidecar build can reason about', () => {
    for (const f of families) {
      assert.ok(
        f.bundled || f.versioned,
        `${f.key}: no api/${f.domain}/v1/[rpc].ts and no api/${f.version}/${f.domain}/[rpc].ts — the desktop cannot see this family at all`,
      );
      assert.ok(!(f.bundled && f.versioned), `${f.key}: bundled and versioned entries both exist`);
    }
  });

  it('every versioned family is declared cloud-only in the build script and routed to the cloud by the sidecar', () => {
    for (const f of families.filter((x) => x.versioned)) {
      assert.ok(
        declaredCloudOnly.includes(f.key),
        `${f.key}: api/${f.key}/[rpc].ts is outside the v1 build glob; add it to CLOUD_ONLY_ROUTE_FAMILIES (or bundle it)`,
      );
      assert.ok(
        sidecarCloudOnlyPrefixes.includes(f.urlPrefix),
        `${f.key}: declared cloud-only but the sidecar has no '${f.urlPrefix}' in cloudOnlyRouteFamilyPrefixes — it would reach the cloud only via the 404 fallback`,
      );
    }
  });

  it('the build-script declaration and the sidecar prefix list are the same set, with no stale entries', () => {
    const fromBuild = declaredCloudOnly.map((key) => {
      const [version, domain] = key.split('/');
      return `/api/${version}/${domain}/`;
    }).sort();
    assert.deepEqual(fromBuild, [...sidecarCloudOnlyPrefixes].sort());
    for (const key of declaredCloudOnly) {
      assert.ok(existsSync(resolve(root, 'api', key, '[rpc].ts')), `${key} is declared cloud-only but api/${key}/[rpc].ts no longer exists`);
    }
  });

  it('bundled v1 families are not also declared cloud-only', () => {
    for (const f of families.filter((x) => x.bundled)) {
      assert.ok(!declaredCloudOnly.includes(f.key), `${f.key} is bundled and declared cloud-only`);
    }
  });

  it('the sidecar consults the family prefixes inside isCloudPreferred', () => {
    const fn = sidecar.slice(sidecar.indexOf('function isCloudPreferred(pathname)'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /cloudOnlyRouteFamilyPrefixes\.some\(p => pathname\.startsWith\(p\)\)/);
  });

  it('the build script refuses an undeclared versioned family instead of silently skipping it', () => {
    assert.match(buildScript, /undeclaredFamilies\.length > 0[\s\S]*?process\.exit\(1\)/);
    assert.match(buildScript, /const VERSION_DIR = \/\^v\\d\+\$\//);
  });
});
