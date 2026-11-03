// /agent: copy buttons, and first-touch capture of an inbound agent link
// (`/agent/?ref=agent-claude`). The capture is the shared module itself:
// agent-client-source.js here is a byte-for-byte copy of
// shared/agent-client-source.js, pinned by tests/agent-page.test.mjs. The
// dashboard reads the stored ref when it creates the account record.
import { agentRefCookieStorage, captureAgentRefFromSearch } from './agent-client-source.js';

const RESET_MS = 2000;

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(area);
    if (ok) resolve(); else reject(new Error('copy failed'));
  });
}

function selectContents(node) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function wireCopyButtons() {
  const status = document.getElementById('copy-status');
  const announce = (text) => { if (status) status.textContent = text; };
  for (const button of document.querySelectorAll('[data-copy]')) {
    let resetTimer = 0;
    button.addEventListener('click', () => {
      const code = button.parentNode.querySelector('code');
      if (!code) return;
      window.clearTimeout(resetTimer);
      copyText(code.textContent).then(() => {
        button.textContent = 'Copied';
        button.classList.add('done');
        announce('Copied to clipboard');
        // Only a success resets itself; the failure hint stays until the next click.
        resetTimer = window.setTimeout(() => {
          button.textContent = 'Copy';
          button.classList.remove('done');
        }, RESET_MS);
      }, () => {
        button.textContent = 'Select and copy';
        button.classList.remove('done');
        selectContents(code);
        announce('Copy failed. The text is selected; copy it with your keyboard.');
      });
    });
  }
}

captureAgentRefFromSearch(window.location.search, agentRefCookieStorage(document, window.location));
wireCopyButtons();
