// /agent: copy buttons, and first-touch capture of an inbound agent link
// (`/agent/?ref=agent-claude`). The capture mirrors captureAgentRefFromSearch in
// shared/agent-client-source.js; tests/agent-page.test.mjs pins the pattern,
// storage key and TTL to that module so the two cannot drift. The dashboard
// reads the stored ref at sign-up and on API key creation.
(function () {
  'use strict';
  var AGENT_REF_PATTERN = /^agent(?:-[a-z0-9]{1,24}){0,2}$/;
  var AGENT_REF_STORAGE_KEY = 'wm-agent-ref';
  var AGENT_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function normalize(raw) {
    if (typeof raw !== 'string') return null;
    var value = raw.trim().toLowerCase();
    if (!value || value.length > 64) return null;
    return AGENT_REF_PATTERN.test(value) ? value : null;
  }

  function storedRef(storage, now) {
    try {
      var raw = storage.getItem(AGENT_REF_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var ref = normalize(parsed && parsed.ref);
      if (!ref || typeof parsed.capturedAt !== 'number' || now - parsed.capturedAt > AGENT_REF_TTL_MS || parsed.capturedAt > now + 60000) {
        storage.removeItem(AGENT_REF_STORAGE_KEY);
        return null;
      }
      return ref;
    } catch (e) {
      return null;
    }
  }

  function captureRef() {
    try {
      var storage = window.localStorage;
      var now = Date.now();
      var refs = new URLSearchParams(window.location.search).getAll('ref');
      var incoming = null;
      for (var i = 0; i < refs.length && !incoming; i++) incoming = normalize(refs[i]);
      if (!incoming || storedRef(storage, now)) return;
      storage.setItem(AGENT_REF_STORAGE_KEY, JSON.stringify({ ref: incoming, capturedAt: now }));
    } catch (e) {
      // Storage blocked: no attribution, the page still works.
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  function wireCopyButtons() {
    var buttons = document.querySelectorAll('[data-copy]');
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener('click', function () {
        var code = button.parentNode.querySelector('code');
        if (!code) return;
        copyText(code.textContent).then(function () {
          button.textContent = 'Copied';
          button.classList.add('done');
        }, function () {
          button.textContent = 'Select and copy';
        });
        window.setTimeout(function () {
          button.textContent = 'Copy';
          button.classList.remove('done');
        }, 2000);
      });
    });
  }

  captureRef();
  wireCopyButtons();
})();
