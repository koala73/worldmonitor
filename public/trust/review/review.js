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
