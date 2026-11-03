/**
 * `/verify` page bootstrap (#9092): paste a claim, see who is reporting it.
 *
 * Each check searches every fresh headline in WorldMonitor's feed caches for
 * the claim's words, then builds the same evidence card the verify_claim MCP
 * tool returns, in the browser. It works signed out. The claim lives in
 * `?claim=` so a result can be shared as a link.
 */
import { renderClaimCardHtml, renderFactChecksHtml } from '@/components/claim-card';
import {
  CLAIM_MAX_CHARS,
  checkClaim,
  fetchClaimSearch,
  fetchFactChecks,
  normalizeClaim,
  type ClaimSearch,
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

// Only the latest check may touch the page: a slow earlier search must not
// paint over a newer one, or over a URL with no claim. The status line has its
// own counter, so only the latest search to start may write it.
let latestRun = 0;
let latestStatus = 0;

function showCounts(search: ClaimSearch | null, statusId: number): void {
  if (statusId !== latestStatus) return;
  status.textContent = search ? describeSearch(search) : 'The live headlines are unavailable right now.';
}

/** The status line with no claim: an empty claim returns only the counts. */
function loadCounts(): void {
  const statusId = ++latestStatus;
  fetchClaimSearch('').then((search) => showCounts(search, statusId), () => showCounts(null, statusId));
}

function describeSearch(search: ClaimSearch): string {
  const age = search.readAt ? Math.round((Date.now() - Date.parse(search.readAt)) / 60_000) : NaN;
  const updated = Number.isFinite(age) && age >= 0 ? `, updated ${age < 1 ? 'just now' : `${age} min ago`}` : '';
  return `Searching ${search.searched.toLocaleString('en-US')} live headlines from ${search.feeds} feeds${updated}.`;
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
    loadCounts();
    return;
  }
  if (push) {
    const url = new URL(location.href);
    url.searchParams.set('claim', text);
    history.pushState(null, '', url);
  }
  submit.disabled = true;
  submit.textContent = 'Checking…';
  // #9094: published fact-checks load beside the headline search and render
  // below the coverage card, which never waits for them.
  const factChecks = fetchFactChecks(text);
  const statusId = ++latestStatus;
  try {
    const search = await fetchClaimSearch(text);
    showCounts(search, statusId);
    if (runId !== latestRun) return;
    setTrustedHtml(result, trustedHtml(
      renderClaimCardHtml(checkClaim(text, search)) + '<div id="factChecks"></div>',
      'claim card escapes every headline and claim string',
    ));
    const slot = document.getElementById('factChecks') as HTMLDivElement;
    setTrustedHtml(slot, trustedHtml(renderFactChecksHtml(null), 'static loading text'));
    void factChecks.then((found) => {
      if (runId !== latestRun) return;
      setTrustedHtml(slot, trustedHtml(renderFactChecksHtml(found), 'fact-check card escapes every fact-check string'));
    });
  } catch {
    showCounts(null, statusId);
    if (runId !== latestRun) return;
    result.replaceChildren();
    const error = document.createElement('p');
    error.className = 'vc-error';
    error.setAttribute('role', 'alert');
    error.textContent = 'The live headlines could not be searched. Try again in a moment.';
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
