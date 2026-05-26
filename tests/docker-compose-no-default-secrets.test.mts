import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

// Regression coverage for issue #3804: the self-hosted Docker stack must
// not ship default Redis credentials. Earlier releases defaulted SRH_TOKEN
// and UPSTASH_REDIS_REST_TOKEN to the publicly documented literal
// "wm-local-token"; flipping the redis-rest binding from 127.0.0.1 to
// 0.0.0.0 instantly exposed an authenticated interface with a known token.
//
// These tests grep the relevant repo files for forbidden patterns rather
// than starting containers, because:
//   - the dangerous shape is a literal default in YAML / shell, which a
//     literal-absence regex catches deterministically without any harness;
//   - any future contributor who reintroduces the default in any of the
//     three files (compose, manual seeder docs, or the wrapper script) is
//     blocked at CI time, not at deploy time.

const REPO_ROOT = new URL('..', import.meta.url);

async function read(rel: string): Promise<string> {
  return readFile(new URL(rel, REPO_ROOT), 'utf8');
}

// Allow a documentation note that EXPLAINS the historical default while
// scanning for live shipped defaults. The note has the literal in prose
// (e.g. "shipped `wm-local-token` as a default") rather than as a YAML
// scalar or shell assignment.
const WM_LOCAL_TOKEN = /wm-local-token/;

// A shipped default has the literal on the right-hand side of an env
// assignment, a YAML mapping, or a parameter-expansion default — NOT in
// a Markdown code-comment, prose paragraph, or backtick-quoted reference.
const SHIPPED_DEFAULT_PATTERNS: RegExp[] = [
  // YAML:     SRH_TOKEN: "${REDIS_TOKEN:-wm-local-token}"
  /:-\s*wm-local-token/,
  // Shell:    UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-wm-local-token}"
  /=\s*"?\$\{[^}]*:-wm-local-token/,
  // Bare assignment: UPSTASH_REDIS_REST_TOKEN=wm-local-token (export line)
  /UPSTASH_REDIS_REST_TOKEN\s*=\s*wm-local-token\b/,
  // YAML literal value (no parameter expansion): TOKEN: wm-local-token
  /^\s*(SRH_TOKEN|UPSTASH_REDIS_REST_TOKEN|REDIS_TOKEN)\s*:\s*["']?wm-local-token/m,
];

describe('docker self-hosting — no default credentials (#3804)', () => {
  it('docker-compose.yml does not default REDIS_TOKEN or UPSTASH_REDIS_REST_TOKEN to a literal', async () => {
    const compose = await read('docker-compose.yml');
    assert.ok(
      !WM_LOCAL_TOKEN.test(compose),
      'docker-compose.yml must not contain the literal wm-local-token — see #3804',
    );
    // Belt-and-braces: any future "default" of any shape on either token name fails the test.
    assert.ok(
      !/\$\{REDIS_TOKEN:-/.test(compose),
      'docker-compose.yml must not provide a default for ${REDIS_TOKEN}; require fail-closed via ${REDIS_TOKEN:?...}',
    );
    assert.ok(
      !/\$\{REDIS_PASSWORD:-/.test(compose),
      'docker-compose.yml must not provide a default for ${REDIS_PASSWORD}; require fail-closed via ${REDIS_PASSWORD:?...}',
    );
    // The fail-closed assertion: EVERY expansion of either var must use
    // the ${VAR:?...} form. A bare ${VAR} silently expands to empty if
    // the upstream guard ever moves or gets deleted (PR #3829 reviewer
    // P2 — SRH_CONNECTION_STRING used a bare ${REDIS_PASSWORD} before fix).
    const bareTokenExpansions = compose.match(/\$\{REDIS_TOKEN(?![:?])/g) ?? [];
    assert.equal(
      bareTokenExpansions.length,
      0,
      `docker-compose.yml must use \${REDIS_TOKEN:?...} at every expansion (found ${bareTokenExpansions.length} bare \${REDIS_TOKEN})`,
    );
    const barePasswordExpansions = compose.match(/\$\{REDIS_PASSWORD(?![:?])/g) ?? [];
    assert.equal(
      barePasswordExpansions.length,
      0,
      `docker-compose.yml must use \${REDIS_PASSWORD:?...} at every expansion (found ${barePasswordExpansions.length} bare \${REDIS_PASSWORD})`,
    );
    // Both vars must appear in at least one fail-closed expansion (i.e. the
    // file actually requires them somewhere, not just by total absence).
    assert.ok(
      /\$\{REDIS_TOKEN:\?/.test(compose),
      'docker-compose.yml must require REDIS_TOKEN via ${REDIS_TOKEN:?...} fail-closed syntax',
    );
    assert.ok(
      /\$\{REDIS_PASSWORD:\?/.test(compose),
      'docker-compose.yml must require REDIS_PASSWORD via ${REDIS_PASSWORD:?...} fail-closed syntax',
    );
    // Redis itself must be authenticated.
    assert.ok(
      /--requirepass\s+"\$\{REDIS_PASSWORD/.test(compose),
      'docker-compose.yml redis service must pass --requirepass using REDIS_PASSWORD',
    );
  });

  it('SELF_HOSTING.md instructions reference $REDIS_TOKEN, not the literal wm-local-token', async () => {
    const md = await read('SELF_HOSTING.md');
    for (const pat of SHIPPED_DEFAULT_PATTERNS) {
      assert.ok(
        !pat.test(md),
        `SELF_HOSTING.md must not show wm-local-token as a default or assigned value (matched ${pat}) — see #3804`,
      );
    }
    // Either both new env vars are explicitly required, or the doc was
    // restructured to point at .env.example. Accept either, fail closed
    // on both being absent.
    const documentsTokens = /REDIS_TOKEN/.test(md) && /REDIS_PASSWORD/.test(md);
    assert.ok(
      documentsTokens,
      'SELF_HOSTING.md must document REDIS_TOKEN and REDIS_PASSWORD as required env vars',
    );
  });

  it('scripts/run-seeders.sh does not silently fall back to wm-local-token', async () => {
    const sh = await read('scripts/run-seeders.sh');
    for (const pat of SHIPPED_DEFAULT_PATTERNS) {
      assert.ok(
        !pat.test(sh),
        `scripts/run-seeders.sh must not default UPSTASH_REDIS_REST_TOKEN to wm-local-token (matched ${pat}) — see #3804`,
      );
    }
    assert.ok(
      /REDIS_TOKEN/.test(sh),
      'scripts/run-seeders.sh must reference REDIS_TOKEN so it picks up the value from .env',
    );
    // Precedence guard for PR #3829 reviewer P1: a developer with BOTH
    // tokens in .env (Vercel/Upstash token + local Docker proxy token)
    // would otherwise have UPSTASH_REDIS_REST_TOKEN populated from .env
    // and the script would silently pass the Vercel bearer to
    // localhost:8079 → 401 with no hint. Inversion: REDIS_TOKEN wins
    // unconditionally if set, then fall back to UPSTASH_REDIS_REST_TOKEN.
    assert.ok(
      !/if \[ -z "\$\{UPSTASH_REDIS_REST_TOKEN[^}]*}" \] && \[ -n "\$\{REDIS_TOKEN/.test(sh),
      'scripts/run-seeders.sh must not gate REDIS_TOKEN copy on UPSTASH_REDIS_REST_TOKEN being absent (PR #3829 P1)',
    );
    assert.ok(
      /if \[ -n "\$\{REDIS_TOKEN[^}]*}" \]/.test(sh),
      'scripts/run-seeders.sh must unconditionally prefer REDIS_TOKEN when set (PR #3829 P1)',
    );
  });

  it('.env.example documents REDIS_PASSWORD and REDIS_TOKEN as self-hosted Docker vars', async () => {
    const env = await read('.env.example');
    assert.ok(
      /^REDIS_PASSWORD=/m.test(env),
      '.env.example must include a REDIS_PASSWORD= line for Docker self-hosting',
    );
    assert.ok(
      /^REDIS_TOKEN=/m.test(env),
      '.env.example must include a REDIS_TOKEN= line for Docker self-hosting',
    );
    assert.ok(
      !/REDIS_PASSWORD=wm-local-token/.test(env) && !/REDIS_TOKEN=wm-local-token/.test(env),
      '.env.example must not pre-fill the credentials with a literal value',
    );
  });

  it('meta — the SHIPPED_DEFAULT_PATTERNS regexes match the historical bad shapes', () => {
    const cases: Array<[string, boolean]> = [
      ['SRH_TOKEN: "${REDIS_TOKEN:-wm-local-token}"', true],
      ['UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-wm-local-token}"', true],
      ['export UPSTASH_REDIS_REST_TOKEN=wm-local-token', true],
      ['  SRH_TOKEN: wm-local-token', true],
      // Negative cases — prose mentions of the literal should NOT match.
      ['Earlier releases shipped `wm-local-token` as a default.', false],
      ['// the literal wm-local-token was the dangerous default — see #3804', false],
      ['SRH_TOKEN: "${REDIS_TOKEN:?REDIS_TOKEN required}"', false],
    ];
    for (const [sample, shouldMatch] of cases) {
      const matched = SHIPPED_DEFAULT_PATTERNS.some((p) => p.test(sample));
      assert.equal(
        matched,
        shouldMatch,
        `pattern coverage broke for input: ${JSON.stringify(sample)} (expected match=${shouldMatch}, got ${matched})`,
      );
    }
  });
});
