import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

// Guards the multi-language SDK packages (orank Access "Multi-language SDK
// packages" gap). Agents verify a package is the official SDK through its
// homepage metadata pointing at the product domain, and each ecosystem keeps
// its version in TWO places (manifest + source constant) that the publish
// workflows cross-check against the release tag — these assertions stop any
// of that wiring from silently drifting.

const HOMEPAGE = 'https://worldmonitor.app';

describe('Python SDK package (sdk/python → PyPI worldmonitor-sdk)', () => {
  const pyproject = read('sdk/python/pyproject.toml');
  const module = read('sdk/python/src/worldmonitor_sdk/__init__.py');

  it('is the worldmonitor-sdk distribution with the product-domain homepage', () => {
    assert.match(pyproject, /^name = "worldmonitor-sdk"$/m);
    assert.match(pyproject, new RegExp(`^Homepage = "${HOMEPAGE}"$`, 'm'));
    assert.match(pyproject, /^license = "MIT"$/m);
  });

  it('keeps __version__ in sync with pyproject.toml (drift guard)', () => {
    const [, pkgVersion] = pyproject.match(/^version = "([^"]+)"$/m) ?? [];
    const [, modVersion] = module.match(/^__version__ = "([^"]+)"$/m) ?? [];
    assert.ok(pkgVersion, 'pyproject.toml must declare a version');
    assert.equal(modVersion, pkgVersion);
  });

  it('sends a descriptive User-Agent (Cloudflare WAF passes it, not python-urllib)', () => {
    assert.match(module, /USER_AGENT = "worldmonitor-python\/%s \(\+https:\/\/worldmonitor\.app\)"/);
  });
});

describe('Ruby SDK package (sdk/ruby → gem worldmonitor)', () => {
  const gemspec = read('sdk/ruby/worldmonitor.gemspec');
  const versionRb = read('sdk/ruby/lib/worldmonitor/version.rb');
  const lib = read('sdk/ruby/lib/worldmonitor.rb');

  it('is the worldmonitor gem with the product-domain homepage', () => {
    assert.match(gemspec, /spec\.name = "worldmonitor"/);
    assert.match(gemspec, new RegExp(`spec\\.homepage = "${HOMEPAGE}"`));
    assert.match(gemspec, new RegExp(`"homepage_uri" => "${HOMEPAGE}"`));
    assert.match(gemspec, /spec\.license = "MIT"/);
  });

  it('declares VERSION where the gemspec and publish workflow read it', () => {
    assert.match(versionRb, /VERSION = "\d+\.\d+\.\d+"/);
    assert.match(gemspec, /require_relative "lib\/worldmonitor\/version"/);
  });

  it('sends a descriptive User-Agent', () => {
    assert.match(lib, /USER_AGENT = "worldmonitor-ruby\/#\{VERSION\} \(\+https:\/\/worldmonitor\.app\)"/);
  });
});

describe('Go SDK module (sdk/go → pkg.go.dev)', () => {
  const gomod = read('sdk/go/go.mod');
  const source = read('sdk/go/worldmonitor.go');

  it('is the sdk/go submodule of this repository', () => {
    assert.match(gomod, /^module github\.com\/koala73\/worldmonitor\/sdk\/go$/m);
  });

  it('declares the Version constant the publish workflow checks against the tag', () => {
    assert.match(source, /^const Version = "\d+\.\d+\.\d+"$/m);
  });

  it('documents the product domain and sends a descriptive User-Agent', () => {
    assert.match(source, /https:\/\/worldmonitor\.app/);
    assert.match(source, /const UserAgent = "worldmonitor-go\/" \+ Version \+ " \(\+https:\/\/worldmonitor\.app\)"/);
  });
});

describe('SDK publish workflows', () => {
  it('publish-python.yml releases sdk/python on py-v* tags via OIDC', () => {
    const wf = read('.github/workflows/publish-python.yml');
    assert.match(wf, /tags: \['py-v\*'\]/);
    assert.match(wf, /working-directory: sdk\/python/);
    assert.match(wf, /id-token: write/);
    assert.match(wf, /pypa\/gh-action-pypi-publish@[0-9a-f]{40}/);
  });

  it('publish-ruby.yml releases sdk/ruby on gem-v* tags via OIDC', () => {
    const wf = read('.github/workflows/publish-ruby.yml');
    assert.match(wf, /tags: \['gem-v\*'\]/);
    assert.match(wf, /working-directory: sdk\/ruby/);
    assert.match(wf, /id-token: write/);
    assert.match(wf, /rubygems\/configure-rubygems-credentials@[0-9a-f]{40}/);
  });

  it('publish-go.yml validates sdk/go on sdk/go/v* tags and warms the module proxy', () => {
    const wf = read('.github/workflows/publish-go.yml');
    assert.match(wf, /tags: \['sdk\/go\/v\*'\]/);
    assert.match(wf, /working-directory: sdk\/go/);
    assert.match(wf, /proxy\.golang\.org/);
  });
});

describe('SDK discovery surfaces', () => {
  it('llms.txt advertises every registry package', () => {
    const llms = read('public/llms.txt');
    assert.match(llms, /pypi\.org\/project\/worldmonitor-sdk/);
    assert.match(llms, /rubygems\.org\/gems\/worldmonitor/);
    assert.match(llms, /pkg\.go\.dev\/github\.com\/koala73\/worldmonitor\/sdk\/go/);
  });

  it('api/llms.txt advertises the SDK surface', () => {
    const llms = read('public/api/llms.txt');
    assert.match(llms, /pip install worldmonitor-sdk/);
    assert.match(llms, /gem install worldmonitor/);
    assert.match(llms, /go get github\.com\/koala73\/worldmonitor\/sdk\/go/);
  });

  it('the docs site has an SDKs page wired into navigation', () => {
    assert.ok(existsSync(join(ROOT, 'docs/sdks.mdx')), 'docs/sdks.mdx must exist');
    const nav = JSON.parse(read('docs/docs.json'));
    assert.match(JSON.stringify(nav.navigation), /"sdks"/);
  });
});
