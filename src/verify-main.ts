/**
 * `/verify` page bootstrap (#9092): paste a claim, see who is reporting it.
 *
 * The page reads the public news digest once and builds the same evidence card
 * the verify_claim MCP tool returns, in the browser, so a check costs no API
 * call and works signed out. The claim lives in `?claim=` so a result can be
 * shared as a link.
 */
import { renderClaimCardHtml, renderFactChecksHtml } from '@/components/claim-card';
import {
  CLAIM_MAX_CHARS,
  checkClaim,
  fetchClaimDigest,
  fetchFactChecks,
  normalizeClaim,
  type ClaimDigest,
} from '@/services/verify-claim';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { safeStorageGet } from '@/utils/safe-storage';

if (safeStorageGet('worldmonitor-theme') === 'light') document.documentElement.dataset.theme = 'light';

const form = document.getElementById('verifyForm') as HTMLFormElement;
const input = document.getElementById('claimInput') as HTMLTextAreaElement;
const submit = document.getElementById('verifySubmit') as HTMLButtonElement;
const status = document.getElementById('digestStatus') as HTMLParagraphElement;
const result = document.getElementById('result') as HTMLDivElement;

input.maxLength = CLAIM_MAX_CHARS;

let digest: Promise<ClaimDigest> | null = null;
// Only the latest check may touch the page: a slow first digest load must not
// let an earlier claim paint over a newer one, or over a URL with no claim.
let latestRun = 0;

function loadDigest(): Promise<ClaimDigest> {
  digest ??= fetchClaimDigest().catch((error: unknown) => {
    digest = null;
    throw error;
  });
  return digest;
}

function describeDigest(loaded: ClaimDigest): string {
  const age = loaded.generatedAt ? Math.round((Date.now() - Date.parse(loaded.generatedAt)) / 60_000) : NaN;
  const updated = Number.isFinite(age) && age >= 0 ? `, updated ${age < 1 ? 'just now' : `${age} min ago`}` : '';
  const stale = loaded.stale ? ' The live feed is delayed, so this is the last good copy.' : '';
  return `Searching ${loaded.items.length} live headlines from ${loaded.publishers} feeds${updated}.${stale}`;
}

function resetSubmit(): void {
  submit.disabled = false;
  submit.textContent = 'Check coverage';
}

async function run(claim: string, { push }: { push: boolean }): Promise<void> {
  const runId = ++latestRun;
  const text = normalizeClaim(claim);
  if (!text) {
    result.replaceChildren();
    resetSubmit();
    return;
  }
  if (push) {
    const url = new URL(location.href);
    url.searchParams.set('claim', text);
    history.pushState(null, '', url);
  }
  submit.disabled = true;
  submit.textContent = 'Checking…';
  // #9094: published fact-checks load beside the digest and render below the
  // coverage card, which never waits for them.
  const factChecks = fetchFactChecks(text);
  try {
    const loaded = await loadDigest();
    if (runId !== latestRun) return;
    status.textContent = describeDigest(loaded);
    setTrustedHtml(result, trustedHtml(
      renderClaimCardHtml(checkClaim(text, loaded)) + '<div id="factChecks"></div>',
      'claim card escapes every digest and claim string',
    ));
    const slot = document.getElementById('factChecks') as HTMLDivElement;
    setTrustedHtml(slot, trustedHtml(renderFactChecksHtml(null), 'static loading text'));
    void factChecks.then((found) => {
      if (runId !== latestRun) return;
      setTrustedHtml(slot, trustedHtml(renderFactChecksHtml(found), 'fact-check card escapes every fact-check string'));
    });
  } catch {
    if (runId !== latestRun) return;
    result.replaceChildren();
    const error = document.createElement('p');
    error.className = 'vc-error';
    error.setAttribute('role', 'alert');
    error.textContent = 'The live news digest could not be loaded. Try again in a moment.';
    result.append(error);
  } finally {
    if (runId === latestRun) resetSubmit();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(input.value, { push: true });
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

function runFromLocation(): void {
  const claim = new URLSearchParams(location.search).get('claim') ?? '';
  input.value = normalizeClaim(claim);
  void run(claim, { push: false });
}

window.addEventListener('popstate', runFromLocation);

runFromLocation();
loadDigest().then((loaded) => { status.textContent = describeDigest(loaded); }).catch(() => {
  status.textContent = 'The live news digest is unavailable right now.';
});
