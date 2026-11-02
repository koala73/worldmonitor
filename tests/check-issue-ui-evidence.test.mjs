// UI reports need a picture. The issue form cannot require an attachment, so
// the Issue UI Evidence workflow closes a UI report that has none and reopens
// it once one is attached. These tests pin the decision, the GitHub writes it
// performs, and the workflow wiring.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  COMMENT_MARKER,
  LABEL,
  apply,
  decide,
  hasAttachment,
  main,
  mentionsUi,
} from '../scripts/check-issue-ui-evidence.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/issue-ui-evidence.yml');
const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));

const PASTED_IMAGE = 'https://github.com/user-attachments/assets/0d2c7a5e-1b2f-4b8e-9d1f-1a2b3c4d5e6f';

function issue(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    title: 'bug(ui/etf-flows): four-column summary crowds narrow panels',
    body: 'The summary row wraps badly when the panel is narrow.',
    labels: [],
    author_association: 'NONE',
    user: { login: 'reporter', type: 'User' },
    ...overrides,
  };
}

function event(overrides = {}) {
  return { action: 'opened', repository: { full_name: 'koala73/worldmonitor' }, issue: issue(overrides) };
}

describe('mentionsUi', () => {
  it('matches the word UI in any case and in the bug(ui/...) title convention', () => {
    assert.equal(mentionsUi('The UI freezes'), true);
    assert.equal(mentionsUi('bug(ui/displacement): narrow panel'), true);
    assert.equal(mentionsUi('ui glitch'), true);
  });

  it('does not match words that merely contain the letters', () => {
    for (const text of ['build fails', 'see the guide', 'the test suite', 'GUI toolkit', 'quid pro quo', '']) {
      assert.equal(mentionsUi(text), false, text);
    }
    assert.equal(mentionsUi(undefined), false);
  });
});

describe('hasAttachment', () => {
  it('recognises every attachment form issue text can carry', () => {
    const forms = [
      `Here: ${PASTED_IMAGE}`,
      'https://github.com/user-attachments/files/12345/recording.mp4',
      'https://user-images.githubusercontent.com/1/abc.png',
      'https://private-user-images.githubusercontent.com/1/abc.png?jwt=x',
      'https://github.com/koala73/worldmonitor/assets/12345/0d2c7a5e-1b2f-4b8e-9d1f-1a2b3c4d5e6f',
      '![screenshot](https://example.com/shot.png)',
      '![shot](https://example.com/shot.png "mobile view")',
      '![shot][image]\n\n[image]: https://example.com/shot.png',
      '![shot][]\n\n[shot]: https://example.com/shot.png',
      '<img width="800" alt="panel" src="https://example.com/shot.png" />',
    ];
    for (const text of forms) assert.equal(hasAttachment(text), true, text);
  });

  it('does not count a plain link, a mention of the word, or an empty body', () => {
    for (const text of ['see https://www.worldmonitor.app/dashboard', 'screenshot: none', '[link](https://x.y)', '![alt]()', '![alt]', '', undefined]) {
      assert.equal(hasAttachment(text), false, String(text));
    }
  });
});

describe('decide', () => {
  it('closes an open UI report with no attachment and posts the explanation', () => {
    assert.deepEqual(decide(event()), { action: 'close', reason: 'missing-attachment', comment: true });
  });

  it('re-closes a manually reopened report silently when the label is still on it', () => {
    const result = decide(event({ labels: [{ name: LABEL }] }));
    assert.deepEqual(result, { action: 'close', reason: 'missing-attachment', comment: false });
  });

  it('reads the word from the title alone and from the body alone', () => {
    assert.equal(decide(event({ title: 'Panel overflow', body: 'The UI clips the header count.' })).action, 'close');
    assert.equal(decide(event({ title: 'UI: header count clipped', body: '' })).action, 'close');
    assert.equal(decide(event({ title: 'Panel overflow', body: null })).action, 'none');
  });

  it('leaves a UI report alone when an attachment is present', () => {
    assert.deepEqual(decide(event({ body: `Looks like this:\n\n${PASTED_IMAGE}` })), {
      action: 'none',
      reason: 'attachment-present',
    });
  });

  it('leaves a non-UI report alone', () => {
    assert.deepEqual(decide(event({ title: 'feed(rss): source returns 403', body: 'Every poll fails.' })), {
      action: 'none',
      reason: 'no-ui-mention',
    });
  });

  it('reopens a closed labelled report once the edit adds an attachment', () => {
    const result = decide({
      ...event({ state: 'closed', labels: [{ name: LABEL }], body: `Attached: ${PASTED_IMAGE}` }),
      action: 'edited',
    });
    assert.deepEqual(result, { action: 'reopen', reason: 'attachment-present' });
  });

  it('reopens a closed labelled report when the edit drops the UI mention', () => {
    const result = decide(event({ state: 'closed', labels: [LABEL], title: 'feed(rss): 403', body: 'Polls fail.' }));
    assert.deepEqual(result, { action: 'reopen', reason: 'ui-mention-removed' });
  });

  it('only removes the label when a labelled report is already open with evidence', () => {
    const result = decide(event({ labels: [{ name: LABEL }], body: PASTED_IMAGE }));
    assert.deepEqual(result, { action: 'unlabel', reason: 'attachment-present' });
  });

  it('never touches a closed report it did not label, or one it closed that is still missing evidence', () => {
    assert.deepEqual(decide(event({ state: 'closed' })), { action: 'none', reason: 'closed-by-human' });
    assert.deepEqual(decide(event({ state: 'closed', labels: [{ name: LABEL }] })), { action: 'none', reason: 'already-closed' });
  });

  it('exempts maintainers, bots and pull requests', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      assert.deepEqual(decide(event({ author_association: association })), { action: 'none', reason: 'trusted-author' }, association);
    }
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']) {
      assert.equal(decide(event({ author_association: association })).action, 'close', association);
    }
    assert.deepEqual(decide(event({ user: { login: 'github-actions[bot]', type: 'Bot' } })), { action: 'none', reason: 'bot-author' });
    assert.deepEqual(decide(event({ pull_request: { url: 'x' } })), { action: 'none', reason: 'pull-request' });
    assert.deepEqual(decide({}), { action: 'none', reason: 'no-issue' });
  });
});

describe('apply', () => {
  const target = { repo: 'koala73/worldmonitor', number: 42 };
  const recorder = () => {
    const calls = [];
    const gh = (args, options) => {
      calls.push({ args, input: options?.input ? JSON.parse(options.input) : undefined });
      return '';
    };
    return { calls, gh };
  };

  it('close: ensures the label exists, applies it, comments, then closes as not planned', () => {
    const { calls, gh } = recorder();
    apply({ action: 'close', comment: true }, { gh, ...target });
    assert.deepEqual(calls.map((c) => c.args.slice(0, 4)), [
      ['api', '--method', 'POST', 'repos/koala73/worldmonitor/labels'],
      ['api', '--method', 'POST', 'repos/koala73/worldmonitor/issues/42/labels'],
      ['api', '--method', 'POST', 'repos/koala73/worldmonitor/issues/42/comments'],
      ['api', '--method', 'PATCH', 'repos/koala73/worldmonitor/issues/42'],
    ]);
    assert.equal(calls[0].input.name, LABEL);
    assert.deepEqual(calls[1].input, { labels: [LABEL] });
    assert.match(calls[2].input.body, /attach a screenshot/);
    assert.ok(calls[2].input.body.endsWith(COMMENT_MARKER));
    assert.deepEqual(calls[3].input, { state: 'closed', state_reason: 'not_planned' });
    for (const call of calls) assert.ok(call.args.includes('--input'), 'every write sends its payload on stdin');
  });

  it('close without comment skips the explanation', () => {
    const { calls, gh } = recorder();
    apply({ action: 'close', comment: false }, { gh, ...target });
    assert.equal(calls.some((c) => c.args[3].endsWith('/comments')), false);
    assert.deepEqual(calls.at(-1).input, { state: 'closed', state_reason: 'not_planned' });
  });

  it('close tolerates a label that already exists and fails on any other label error', () => {
    const existing = (args) => {
      if (args[3].endsWith('/labels') && !args[3].includes('/issues/')) {
        throw new Error('gh api failed (1): HTTP 422: Validation Failed {"code":"already_exists"}');
      }
      return '';
    };
    assert.equal(apply({ action: 'close', comment: true }, { gh: existing, ...target }).length, 4);
    const broken = () => { throw new Error('gh api failed (1): HTTP 403: Resource not accessible'); };
    assert.throws(() => apply({ action: 'close', comment: true }, { gh: broken, ...target }), /HTTP 403/);
  });

  it('reopen: reopens before removing the label, then says why', () => {
    const { calls, gh } = recorder();
    apply({ action: 'reopen', reason: 'attachment-present' }, { gh, ...target });
    assert.deepEqual(calls.map((c) => c.args.slice(0, 4)), [
      ['api', '--method', 'PATCH', 'repos/koala73/worldmonitor/issues/42'],
      ['api', '--method', 'DELETE', `repos/koala73/worldmonitor/issues/42/labels/${LABEL}`],
      ['api', '--method', 'POST', 'repos/koala73/worldmonitor/issues/42/comments'],
    ]);
    assert.deepEqual(calls[0].input, { state: 'open' });
    assert.match(calls[2].input.body, /Attachment detected, reopening/);
    assert.ok(calls[2].input.body.endsWith(COMMENT_MARKER));
  });

  it('reopen after a failed PATCH leaves the label on, so the next run retries', () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args[2] === 'PATCH') throw new Error('gh api failed (1): HTTP 502');
      return '';
    };
    assert.throws(() => apply({ action: 'reopen', reason: 'attachment-present' }, { gh, ...target }), /HTTP 502/);
    assert.equal(calls.some((args) => args[2] === 'DELETE'), false);
  });

  it('reopen explains a dropped UI mention without claiming an attachment', () => {
    const { calls, gh } = recorder();
    apply({ action: 'reopen', reason: 'ui-mention-removed' }, { gh, ...target });
    const body = calls.at(-1).input.body;
    assert.match(body, /no longer refers to the UI/);
    assert.doesNotMatch(body, /Attachment detected/);
  });

  it('unlabel only removes the label, and none writes nothing', () => {
    const { calls, gh } = recorder();
    apply({ action: 'unlabel' }, { gh, ...target });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], 'DELETE');
    assert.deepEqual(apply({ action: 'none' }, { gh, ...target }), []);
  });
});

describe('main', () => {
  const withEvent = (payload, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-issue-ui-evidence-'));
    try {
      const eventPath = join(dir, 'event.json');
      writeFileSync(eventPath, JSON.stringify(payload));
      return fn(eventPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const ghReading = (live) => {
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args.length === 2 && args[1] === 'repos/koala73/worldmonitor/issues/42') return JSON.stringify(live);
      return '';
    };
    return { calls, gh };
  };

  it('reads the event payload from GITHUB_EVENT_PATH, then decides from the live issue, not the snapshot', () => {
    withEvent(event(), (eventPath) => {
      const { calls, gh } = ghReading(issue());
      const decision = main({ GITHUB_EVENT_PATH: eventPath }, gh);
      assert.equal(decision.action, 'close');
      assert.deepEqual(calls[0], ['api', 'repos/koala73/worldmonitor/issues/42']);
      assert.equal(calls.at(-1)[3], 'repos/koala73/worldmonitor/issues/42');
    });
  });

  it('an edit that raced the closing run still reopens: the snapshot is open and unlabelled, the live issue is closed and labelled', () => {
    const edited = { ...event({ body: `Attached: ${PASTED_IMAGE}` }), action: 'edited' };
    withEvent(edited, (eventPath) => {
      const live = issue({ state: 'closed', labels: [{ name: LABEL }], body: `Attached: ${PASTED_IMAGE}` });
      const { calls, gh } = ghReading(live);
      const decision = main({ GITHUB_EVENT_PATH: eventPath }, gh);
      assert.deepEqual(decision, { action: 'reopen', reason: 'attachment-present' });
      assert.equal(calls.filter((args) => args[2] === 'PATCH').length, 1);
    });
  });

  it('a snapshot without evidence does not close an issue whose live body now has it', () => {
    withEvent(event(), (eventPath) => {
      const { calls, gh } = ghReading(issue({ body: PASTED_IMAGE }));
      const decision = main({ GITHUB_EVENT_PATH: eventPath }, gh);
      assert.equal(decision.action, 'none');
      assert.equal(calls.length, 1, 'only the read');
    });
  });

  it('refuses a live read that is not the requested issue', () => {
    withEvent(event(), (eventPath) => {
      assert.throws(() => main({ GITHUB_EVENT_PATH: eventPath }, () => JSON.stringify({ number: 7 })), /read back as/);
    });
  });

  it('refuses to run without an event payload', () => {
    assert.throws(() => main({}, () => ''), /GITHUB_EVENT_PATH/);
  });
});

describe('issue-ui-evidence workflow', () => {
  const job = workflow.jobs.evidence;
  const pin = (uses) => assert.match(uses, /@[0-9a-f]{40}$/i, `${uses} must be pinned to a commit SHA`);

  it('runs when an issue is opened, edited or reopened, so a screenshot reopens it and a bare manual reopen is re-closed', () => {
    assert.equal(workflow.name, 'Issue UI Evidence');
    assert.deepEqual(workflow.on.issues.types, ['opened', 'edited', 'reopened']);
    assert.deepEqual(Object.keys(workflow.on), ['issues']);
  });

  it('can write issues and nothing else, and serialises runs per issue', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read', issues: 'write' });
    assert.equal(workflow.concurrency.group, 'issue-ui-evidence-${{ github.event.issue.number }}');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
  });

  it('runs the script from the default branch with a pinned Node 24 toolchain', () => {
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const setupNode = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    pin(checkout.uses);
    pin(setupNode.uses);
    assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
    assert.equal(setupNode.with['node-version'], '24');
    const sparse = checkout.with['sparse-checkout'].split('\n').filter(Boolean);
    assert.deepEqual(sparse, ['scripts/check-issue-ui-evidence.mjs', 'scripts/lib/main-module.mjs']);
    const run = job.steps.find((step) => step.run);
    assert.equal(run.run.trim(), 'node scripts/check-issue-ui-evidence.mjs');
    assert.equal(run.env.GH_TOKEN, '${{ github.token }}');
    assert.doesNotMatch(run.run, /github\.event\.issue/, 'issue text must never be shell-interpolated');
  });
});
