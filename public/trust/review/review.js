// Operator view for #9093 reader error reports. Renders every reader-supplied
// value with textContent; the review key lives only in this tab's sessionStorage.
(function () {
  'use strict';
  var KEY_STORAGE = 'wm-trust-review-key';
  var HEADER = 'X-Trust-Review-Key';
  var keyInput = document.getElementById('key');
  var statusEl = document.getElementById('status');
  var listEl = document.getElementById('reports');
  var tabs = document.querySelectorAll('.tabs button');
  var current = 'pending';

  function readKey() {
    try { return sessionStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  function saveKey(value) {
    try { sessionStorage.setItem(KEY_STORAGE, value); } catch (e) {}
  }
  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'error' : '';
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function when(ms) {
    return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
  }
  function api(path, init) {
    var headers = { 'Content-Type': 'application/json' };
    headers[HEADER] = keyInput.value;
    return fetch(path, Object.assign({}, init, { headers: headers, credentials: 'omit', cache: 'no-store' }))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) {
            var err = new Error(res.status === 401 ? 'The review key was not accepted.' : (body.message || ('HTTP ' + res.status)));
            err.status = res.status;
            throw err;
          }
          return body;
        });
      });
  }

  // #9096: the same wording as shared/media-provenance-contract.js
  // (tests/dom/trust-review-page.test.mts holds them equal).
  var MEDIA_WORDING = {
    noCredentials: 'No content credentials found. Most sites remove them when images are uploaded, so this is common and says nothing about whether the media was edited.',
    unreadableCredentials: 'The file has content credentials that could not be read.',
    untrustedSigner: 'Signed, but the signer is not on the C2PA trust list this check uses.',
    unknownTrust: 'Signed. The signer could not be checked against a trust list.',
    aiDeclared: 'The credentials say this was made with a generative AI model.',
    changedAfterSigning: 'The credentials do not match the file: it was changed after it was signed. This does not say how or by whom.',
    failedValidation: 'The credentials failed validation: the signature or what they declare could not be confirmed. This does not say how the media was made or changed.',
    earliestNone: 'TinEye has not seen this image anywhere.',
    earliestUnsupported: 'The earliest-copy search covers images only.',
    earliestNotConfigured: 'The earliest-copy search is not set up on this server.',
    earliestCapReached: 'The earliest-copy search has reached its monthly limit. It is available again next month.',
    earliestUnavailable: 'The earliest-copy search could not run right now.'
  };
  var MEDIA_POLL_MS = 2000;
  var MEDIA_POLL_LIMIT = 150;

  function mediaLines(result) {
    var lines = [];
    var c = result.credentials || {};
    if (c.state === 'found') {
      var signer = c.signer || c.signerCommonName || 'an unnamed signer';
      // Only a trusted signer is stated as fact; otherwise the name is what the certificate says.
      lines.push(c.signerTrust === 'trusted'
        ? 'Content credentials found: signed by ' + signer + '.'
        : 'Content credentials found. They name the signer as ' + signer + '.');
      lines.push(c.signerTrust === 'trusted' ? 'The signer is on the C2PA trust list this check uses.'
        : c.signerTrust === 'untrusted' ? MEDIA_WORDING.untrustedSigner : MEDIA_WORDING.unknownTrust);
      if (c.contentChangedAfterSigning) lines.push(MEDIA_WORDING.changedAfterSigning);
      else if (c.validationState === 'invalid') lines.push(MEDIA_WORDING.failedValidation);
      if (c.declaresAiGeneration) lines.push(MEDIA_WORDING.aiDeclared);
      if (c.claimGenerator) lines.push('Made with: ' + c.claimGenerator);
      (c.actions || []).forEach(function (a) {
        lines.push('Declared step: ' + a.action + (a.softwareAgent ? ' with ' + a.softwareAgent : ''));
      });
    } else {
      lines.push(c.state === 'none' ? MEDIA_WORDING.noCredentials : MEDIA_WORDING.unreadableCredentials);
    }
    var e = result.earliest || {};
    if (e.state === 'ok' && e.copies && e.copies.length) {
      lines.push('Earliest copy TinEye has seen: ' + e.copies[0].crawlDate + ', ' + e.copies[0].domain + '.');
    } else {
      lines.push({ ok: MEDIA_WORDING.earliestNone, 'unsupported-media': MEDIA_WORDING.earliestUnsupported,
        'not-configured': MEDIA_WORDING.earliestNotConfigured, 'cap-reached': MEDIA_WORDING.earliestCapReached }[e.state]
        || MEDIA_WORDING.earliestUnavailable);
    }
    return lines.concat(result.caveats || []);
  }

  function checkMedia(report, button, box) {
    button.disabled = true;
    box.replaceChildren(el('p', '', 'Checking the file… This can take a few minutes.'));
    var polls = 0;
    function show(lines, isError) {
      box.replaceChildren();
      lines.forEach(function (line) { box.appendChild(el('p', isError ? 'error' : '', line)); });
      button.disabled = false;
    }
    function poll(statusUrl) {
      if (polls++ >= MEDIA_POLL_LIMIT) { show(['The check is taking too long. Try again later.'], true); return; }
      setTimeout(function () {
        api(statusUrl, { method: 'GET' }).then(function (body) {
          if (body.status === 'done' && body.result) show(mediaLines(body.result), false);
          else if (body.status === 'failed') show([body.error || 'The check could not be completed.'], true);
          else poll(statusUrl);
        }).catch(function (err) { show([err.message], true); });
      }, MEDIA_POLL_MS);
    }
    api('/api/news/v1/check-report-media', { method: 'POST', body: JSON.stringify({ reportId: report.id }) })
      .then(function (job) {
        if (typeof job.statusUrl !== 'string' || job.statusUrl.indexOf('/api/news/v1/get-report-media?') !== 0) {
          show(['The check could not be started.'], true);
          return;
        }
        poll(job.statusUrl);
      })
      .catch(function (err) { show([err.message], true); });
  }

  function renderReport(report) {
    var item = el('li', 'report');
    var meta = el('div', 'meta');
    meta.appendChild(el('span', 'badge ' + report.status, report.status));
    meta.appendChild(el('span', '', 'Received ' + when(report.createdAt)));
    if (report.reviewedAt) meta.appendChild(el('span', '', 'Reviewed ' + when(report.reviewedAt)));
    if (report.storyId) {
      var story = el('a', '', 'story ' + report.storyId.slice(0, 12) + '…');
      story.href = '/api/news/v1/list-label-changes?story_id=' + encodeURIComponent(report.storyId);
      meta.appendChild(story);
    }
    if (report.url) {
      var link = el('a', '', report.url);
      link.href = report.url;
      link.rel = 'noopener noreferrer nofollow';
      link.target = '_blank';
      meta.appendChild(link);
    }
    if (report.contact) meta.appendChild(el('span', '', 'Reply to: ' + report.contact));
    item.appendChild(meta);
    item.appendChild(el('p', 'message', report.message));
    if (report.url) {
      var mediaButton = el('button', 'media-check', 'Check image or video');
      mediaButton.type = 'button';
      var mediaBox = el('div', 'media-result');
      mediaBox.setAttribute('aria-live', 'polite');
      mediaButton.addEventListener('click', function () { checkMedia(report, mediaButton, mediaBox); });
      item.appendChild(mediaButton);
      item.appendChild(mediaBox);
    }

    if (report.status !== 'pending') {
      if (report.publicNote) item.appendChild(el('p', 'note-label', 'Public note: ' + report.publicNote));
      return item;
    }
    var noteId = 'note-' + report.id;
    var label = el('label', 'note-label', 'Public note (published with an accepted report; never include the reader’s email)');
    label.htmlFor = noteId;
    var note = el('textarea');
    note.id = noteId;
    note.maxLength = 500;
    var actions = el('div', 'actions');
    var accept = el('button', '', 'Accept');
    var reject = el('button', 'reject', 'Reject');
    accept.type = reject.type = 'button';
    function decide(decision) {
      if (decision === 'accept' && !note.value.trim()) {
        setStatus('An accepted report needs a public note.', true);
        note.focus();
        return;
      }
      accept.disabled = reject.disabled = true;
      api('/api/news/v1/review-error-report', {
        method: 'POST',
        body: JSON.stringify({ reportId: report.id, decision: decision, publicNote: note.value.trim() }),
      }).then(function () {
        setStatus(decision === 'accept' ? 'Accepted and published to the label log.' : 'Rejected.', false);
        item.remove();
      }).catch(function (err) {
        accept.disabled = reject.disabled = false;
        setStatus(err.message, true);
      });
    }
    accept.addEventListener('click', function () { decide('accept'); });
    reject.addEventListener('click', function () { decide('reject'); });
    actions.appendChild(accept);
    actions.appendChild(reject);
    item.appendChild(label);
    item.appendChild(note);
    item.appendChild(actions);
    return item;
  }

  // Only the latest load may render: switching tabs while a slower response is
  // in flight must not show the other tab's reports under this one.
  var loadSeq = 0;
  function load() {
    if (!keyInput.value) {
      setStatus('Enter the review key.', false);
      return;
    }
    var seq = ++loadSeq;
    var status = current;
    setStatus('Loading…', false);
    api('/api/news/v1/list-error-reports?status=' + status, { method: 'GET' })
      .then(function (body) {
        if (seq !== loadSeq) return;
        listEl.replaceChildren();
        if (body.state !== 'ok') {
          setStatus('Reports could not be read. Nothing was changed; try again.', true);
          return;
        }
        var reports = Array.isArray(body.reports) ? body.reports : [];
        reports.forEach(function (report) { listEl.appendChild(renderReport(report)); });
        setStatus(reports.length === 0
          ? (status === 'pending' ? 'No pending reports.' : 'No reviewed reports yet.')
          : reports.length + (status === 'pending' ? ' pending, oldest first.' : ' reviewed, newest first.'), false);
      })
      .catch(function (err) {
        if (seq !== loadSeq) return;
        listEl.replaceChildren();
        setStatus(err.message, true);
      });
  }

  document.getElementById('key-form').addEventListener('submit', function (event) {
    event.preventDefault();
    saveKey(keyInput.value);
    load();
  });
  Array.prototype.forEach.call(tabs, function (tab) {
    tab.addEventListener('click', function () {
      current = tab.getAttribute('data-status');
      Array.prototype.forEach.call(tabs, function (t) { t.setAttribute('aria-pressed', String(t === tab)); });
      load();
    });
  });
  keyInput.value = readKey();
  if (keyInput.value) load();
})();
