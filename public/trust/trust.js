// /trust (#9093): today's label counts, recent label changes, how first labels
// held up (#9097) and the reader error-report form. Every server value is rendered with textContent.
(function () {
  'use strict';
  var LIST_URL = '/api/news/v1/list-label-changes';
  var SUBMIT_URL = '/api/news/v1/submit-error-report';
  // The API serves at most 200 entries; the page says so when it is full.
  var PAGE_LIMIT = 200;
  var STATE_TEXT = { 'single-publisher': 'Single publisher', corroborated: 'Corroborated' };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function $(id) { return document.getElementById(id); }
  function when(ms) {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
  function safeLink(href) {
    try {
      var url = new URL(href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch (e) {
      return '';
    }
  }
  function credBand(score) {
    return score < 40 ? 'low' : score < 70 ? 'medium' : 'high';
  }
  function getJson(url) {
    return fetch(url, { credentials: 'omit' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function renderCounts(counts) {
    var note = $('today-note');
    if (!counts || !counts.stories) {
      note.textContent = "Today's counts are not available yet.";
      return;
    }
    $('count-corroborated').textContent = String(counts.corroborated);
    $('count-single').textContent = String(counts.singlePublisher);
    $('count-tier4').textContent = String(counts.tier4Only);
    $('count-unknown').textContent = String(counts.unknown);
    $('tiles').hidden = false;
    note.textContent = counts.stories + ' stories in the latest English digest, counted ' + when(counts.at) + '.';
  }

  // #9097: how first labels held up. Every figure is shown with its n.
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var HORIZON_TEXT = { '24h': '24 hours', '7d': '7 days' };
  function monthName(month) {
    var parts = String(month).split('-');
    var index = Number(parts[1]) - 1;
    return MONTHS[index] ? MONTHS[index] + ' ' + parts[0] : String(month);
  }
  function shortDay(day) {
    var parts = String(day).split('-');
    var index = Number(parts[1]) - 1;
    return MONTHS[index] ? Number(parts[2]) + ' ' + MONTHS[index].slice(0, 3) : String(day);
  }
  function share(count, n, low) {
    if (!n) return '–';
    if (low) return count + ' of ' + n;
    return Math.round((count / n) * 100) + '% (' + count + ' of ' + n + ')';
  }
  function calibrationTable(month, lowN, factCheck) {
    var wrap = el('figure', 'calibration-month');
    var caption = month.cohortDays + (month.cohortDays === 1 ? ' cohort day' : ' cohort days') + ' counted';
    if (month.firstDay && month.lastDay) caption += ' (' + shortDay(month.firstDay) + ' – ' + shortDay(month.lastDay) + ')';
    if (month.excludedDays) caption += '; ' + month.excludedDays + ' left out because the day\'s log was full';
    var scroll = el('div', 'table-scroll');
    var table = el('table', 'calibration-table');
    var cap = el('caption');
    cap.appendChild(el('strong', '', monthName(month.month)));
    cap.appendChild(document.createTextNode(' · ' + caption));
    table.appendChild(cap);
    var head = el('thead');
    var headRow = el('tr');
    ['First label', 'Checked after', 'Stories (n)', 'Same label', 'Label changed', 'Other label', 'A fact-checker published a rating']
      .forEach(function (name) {
        var th = el('th', '', name);
        th.scope = 'col';
        headRow.appendChild(th);
      });
    head.appendChild(headRow);
    table.appendChild(head);
    var body = el('tbody');
    (Array.isArray(month.rows) ? month.rows : []).forEach(function (row) {
      var low = row.stories < lowN;
      var tr = el('tr', low ? 'low-n' : '');
      var state = el('th', '', STATE_TEXT[row.state] || row.state);
      state.scope = 'row';
      tr.appendChild(state);
      tr.appendChild(el('td', '', HORIZON_TEXT[row.horizon] || row.horizon));
      var n = el('td', 'n', String(row.stories));
      if (low) n.appendChild(el('span', 'low-n-badge', 'low n'));
      tr.appendChild(n);
      tr.appendChild(el('td', '', share(row.same, row.stories, low)));
      tr.appendChild(el('td', '', share(row.changed, row.stories, low)));
      tr.appendChild(el('td', '', share(row.other, row.stories, low)));
      tr.appendChild(el('td', 'not-measured', factCheck));
      body.appendChild(tr);
    });
    table.appendChild(body);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    return wrap;
  }
  function renderCalibration(calibration) {
    var status = $('calibration-status');
    var container = $('calibration');
    container.replaceChildren();
    if (!calibration || !Array.isArray(calibration.months)) {
      status.textContent = 'Calibration figures are not available yet, or could not be read right now.';
      return;
    }
    var lowN = Number(calibration.lowNThreshold) || 0;
    var factCheck = calibration.factCheckStatus === 'not-measured' ? 'Not measured' : String(calibration.factCheckStatus || '');
    $('calibration-low-n').textContent = String(lowN);
    $('calibration-fact-check').textContent = calibration.factCheckNote || '';
    $('calibration-notes').hidden = false;
    if (calibration.months.length === 0) {
      status.textContent = 'No cohort day has been counted yet. A day is counted once every story first seen on it is seven days old.';
      return;
    }
    calibration.months.forEach(function (month) { container.appendChild(calibrationTable(month, lowN, factCheck)); });
    status.textContent = 'Computed ' + when(calibration.generatedAt) + ' from the logged label history.';
  }

  function transition(change) {
    var wrap = el('span', 'transition');
    if (change.field === 'correction') {
      wrap.appendChild(el('span', 'correction', 'Correction from a reader report'));
      return wrap;
    }
    wrap.appendChild(el('span', '', (STATE_TEXT[change.previous] || change.previous) + ' (' + change.previousPublishers + ')'));
    wrap.appendChild(document.createTextNode(' → '));
    wrap.appendChild(el('span', 'to-' + change.next, (STATE_TEXT[change.next] || change.next) + ' (' + change.nextPublishers + ')'));
    return wrap;
  }

  function historyLine(change) {
    var text = change.field === 'correction'
      ? 'Correction: ' + change.reason
      : (STATE_TEXT[change.previous] || change.previous) + ' → ' + (STATE_TEXT[change.next] || change.next);
    return el('li', '', when(change.at) + ' · ' + text);
  }

  function renderChange(change) {
    var item = el('li', 'change');
    var head = el('div', 'change-head');
    head.appendChild(transition(change));
    head.appendChild(el('time', '', when(change.at)));
    if (change.credibilityScore >= 0) {
      head.appendChild(el('span', 'cred ' + credBand(change.credibilityScore), 'CRED ' + change.credibilityScore + ' (' + credBand(change.credibilityScore) + ')'));
    }
    item.appendChild(head);

    var link = safeLink(change.link);
    if (change.title) {
      var title = link ? el('a', 'title', change.title) : el('span', 'title', change.title);
      if (link) {
        title.href = link;
        title.rel = 'noopener noreferrer nofollow';
        title.target = '_blank';
      }
      item.appendChild(title);
    } else if (link) {
      var bare = el('a', 'title', link);
      bare.href = link;
      bare.rel = 'noopener noreferrer nofollow';
      bare.target = '_blank';
      item.appendChild(bare);
    }
    if (change.reason) item.appendChild(el('p', 'reason', change.reason));

    if (Array.isArray(change.sources) && change.sources.length > 0) {
      var publishers = el('ul', 'publishers');
      publishers.setAttribute('aria-label', 'Publishers behind the new label');
      change.sources.forEach(function (source) {
        publishers.appendChild(el('li', '', source.name + (source.tier ? ' · T' + source.tier : '')));
      });
      item.appendChild(publishers);
    }

    var actions = el('div', 'actions');
    if (change.storyId) {
      var historyButton = el('button', '', 'Story history');
      historyButton.type = 'button';
      historyButton.setAttribute('aria-expanded', 'false');
      var history = null;
      historyButton.addEventListener('click', function () {
        if (history) {
          var open = history.hidden;
          history.hidden = !open;
          historyButton.setAttribute('aria-expanded', String(open));
          return;
        }
        historyButton.disabled = true;
        getJson(LIST_URL + '?story_id=' + encodeURIComponent(change.storyId) + '&limit=20')
          .then(function (body) {
            if (body.state !== 'ok') throw new Error('unavailable');
            history = el('ul', 'history');
            var entries = Array.isArray(body.changes) ? body.changes : [];
            if (entries.length === 0) history.appendChild(el('li', '', 'No other changes recorded.'));
            entries.forEach(function (entry) { history.appendChild(historyLine(entry)); });
            var failed = item.querySelector('.history-error');
            if (failed) failed.remove();
            item.appendChild(history);
            historyButton.setAttribute('aria-expanded', 'true');
          })
          .catch(function () {
            // Not kept: the next click retries instead of reopening the error.
            var failed = item.querySelector('.history-error');
            if (!failed) {
              failed = el('p', 'history history-error', 'History could not be loaded. Try again.');
              item.appendChild(failed);
            }
          })
          .then(function () { historyButton.disabled = false; });
      });
      actions.appendChild(historyButton);
    }
    if (change.title) {
      var verify = el('a', '', 'Check coverage');
      verify.href = '/verify?claim=' + encodeURIComponent(change.title);
      actions.appendChild(verify);
    }
    var report = el('button', '', 'Report an error');
    report.type = 'button';
    report.addEventListener('click', function () { startReport(change); });
    actions.appendChild(report);
    item.appendChild(actions);
    return item;
  }

  function loadChanges() {
    var status = $('changes-status');
    getJson(LIST_URL + '?limit=' + PAGE_LIMIT)
      .then(function (body) {
        renderCounts(body.counts);
        renderCalibration(body.calibration);
        if (body.retentionDays) $('retention').textContent = String(body.retentionDays);
        if (body.state !== 'ok') {
          status.textContent = 'The change log could not be read right now. Nothing is hidden; try again shortly.';
          status.className = 'error';
          return;
        }
        var changes = Array.isArray(body.changes) ? body.changes : [];
        var list = $('changes');
        list.replaceChildren();
        changes.forEach(function (change) { list.appendChild(renderChange(change)); });
        status.textContent = changes.length === 0
          ? 'No label changes in this period.'
          : changes.length >= PAGE_LIMIT
            ? 'Showing the latest ' + changes.length + ' changes; older ones from this period are not listed here.'
            : changes.length + (changes.length === 1 ? ' change.' : ' changes.');
      })
      .catch(function () {
        $('today-note').textContent = "Today's counts could not be loaded.";
        $('calibration-status').textContent = 'Calibration figures could not be loaded. Try again shortly.';
        status.textContent = 'The change log could not be loaded. Try again shortly.';
        status.className = 'error';
      });
  }

  var reportStoryId = '';
  var autoUrl = '';
  function startReport(change) {
    reportStoryId = change.storyId || '';
    var story = $('report-story');
    story.textContent = change.title ? 'About: ' + change.title : '';
    story.hidden = !change.title;
    // Replace a link this form filled for another story; keep one the reader typed.
    var urlField = $('report-url');
    if (!urlField.value || urlField.value === autoUrl) {
      autoUrl = safeLink(change.link || '');
      urlField.value = autoUrl;
    }
    $('report-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('report-message').focus();
  }

  $('report-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var status = $('report-status');
    var message = $('report-message').value.trim();
    if (message.length < 10) {
      status.textContent = 'Please describe what is wrong in at least 10 characters.';
      status.className = 'error';
      $('report-message').focus();
      return;
    }
    var button = event.target.querySelector('button[type=submit]');
    button.disabled = true;
    status.textContent = 'Sending…';
    status.className = '';
    fetch(SUBMIT_URL, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        storyId: reportStoryId,
        url: $('report-url').value.trim(),
        contact: $('report-contact').value.trim(),
        website: $('report-website').value,
      }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
      })
      .then(function (result) {
        var res = result.res;
        var body = result.body;
        if (res.status === 429) {
          status.textContent = 'Too many reports from this connection. Please try again later.';
          status.className = 'error';
        } else if (res.status === 400) {
          var violation = Array.isArray(body.violations) && body.violations[0];
          status.textContent = violation && violation.description ? violation.description + '.' : 'Please check the form.';
          status.className = 'error';
        } else if (!res.ok) {
          status.textContent = 'The report could not be sent. Please try again later.';
          status.className = 'error';
        } else if (body.status === 'queue-full') {
          status.textContent = 'The review queue is full right now, so your report was not stored. Please try again later.';
          status.className = 'error';
        } else if (body.status !== 'received') {
          status.textContent = 'The report could not be sent. Please try again later.';
          status.className = 'error';
        } else {
          status.textContent = 'Thank you. A person will review your report; nothing changes automatically.';
          status.className = '';
          event.target.reset();
          reportStoryId = '';
          autoUrl = '';
          $('report-story').hidden = true;
        }
      })
      .catch(function () {
        status.textContent = 'The report could not be sent. Please try again later.';
        status.className = 'error';
      })
      .then(function () { button.disabled = false; });
  });

  loadChanges();
})();
