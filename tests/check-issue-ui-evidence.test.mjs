// UI reports need a picture. The bug report form refuses an empty screenshot
// field but cannot check that the field holds an image, so the Issue UI
// Evidence workflow labels a UI report that has none and asks for one, then
// clears the label once it is attached. It never changes the issue state.
// These tests pin the decision, the GitHub writes it performs, the workflow
// wiring, and the form's required field.

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
  hasNudgeComment,
  main,
  nudgeComment,
  mentionsUi,
} from '../scripts/check-issue-ui-evidence.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows/issue-ui-evidence.yml'), 'utf8'));
const bugForm = YAML.parse(readFileSync(resolve(repoRoot, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8'));

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
      '![Shot][IMAGE]\n\n  [image]: https://example.com/shot.png "title"',
      '![shot][image]\n\n[image]:\nhttps://example.com/shot.png',
      '<img width="800" alt="panel" src="https://example.com/shot.png" />',
    ];
    for (const text of forms) assert.equal(hasAttachment(text), true, text);
  });

  it('does not count a plain link, a mention of the word, or an empty body', () => {
    for (const text of ['see https://www.worldmonitor.app/dashboard', 'screenshot: none', '[link](https://x.y)', '![alt]()', '![alt]', '', undefined]) {
      assert.equal(hasAttachment(text), false, String(text));
    }
  });

  // The budget is a regression net, not a benchmark: linear shapes take tens
  // of milliseconds locally and about 250 ms on a loaded CI runner, while the
  // pre-fix pattern was quadratic and would take many seconds at the cap. A
  // tight host-tuned bound failed CI at 253 ms; 2 s keeps every runner green
  // and still fails a quadratic regression by an order of magnitude.
  it('stays linear on a hostile body at the GitHub size cap (CWE-1333)', () => {
    const cap = 65_536;
    const fill = (unit) => unit.repeat(Math.ceil(cap / unit.length)).slice(0, cap);
    const bodies = [
      `![a](${'x'.repeat(cap)}`,
      `![a]( ${' x'.repeat(cap / 2)}`,
      `![${'a'.repeat(cap)}`,
      `![a][${'b'.repeat(cap)}`,
      `![a][b]\n[b]:${' '.repeat(cap)}`,
      fill('![x]('),
      fill('![x]( '),
      fill('![x][y]'),
      fill('![x][]\n'),
      fill('[x]:\n'),
      fill('<img '),
      fill('<img src'),
      `${fill('![a][b]')}\n[c]: https://example.com/shot.png`,
    ];
    for (const body of bodies) {
      const started = performance.now();
      assert.equal(hasAttachment(body), false);
      const took = performance.now() - started;
      assert.ok(took < 2_000, `${JSON.stringify(body.slice(0, 12))}... took ${Math.round(took)}ms`);
    }
  });

  it('treats an alt text, label or img tag beyond the bound as not an attachment', () => {
    assert.equal(hasAttachment(`![${'a'.repeat(301)}](https://example.com/shot.png)`), false);
    assert.equal(hasAttachment(`![${'a'.repeat(300)}](https://example.com/shot.png)`), true);
    assert.equal(hasAttachment(`<img ${'x'.repeat(2049)} src="https://example.com/shot.png">`), false);
  });

  it('does not count a reference image whose definition is missing, empty, or for another label', () => {
    const unresolved = [
      '![shot][image]',
      '![shot][]',
      '![shot][image]\n\n[image]:',
      '![shot][image]\n\n[other]: https://example.com/shot.png',
      '![shot][]\n\n[image]: https://example.com/shot.png',
      '![shot][image]\n\n[image]:\n\nhttps://example.com/shot.png',
      '![][]',
    ];
    for (const text of unresolved) assert.equal(hasAttachment(text), false, text);
  });
});

const BOT = { login: 'github-actions[bot]', type: 'Bot' };

describe('hasNudgeComment', () => {
  it('finds the marker only in a comment posted by a Bot account', () => {
    assert.equal(hasNudgeComment([{ body: 'thanks', user: { login: 'reporter', type: 'User' } }, { body: nudgeComment(), user: BOT }]), true);
    assert.equal(hasNudgeComment([{ body: nudgeComment(), user: { login: 'reporter', type: 'User' } }]), false, 'a reporter pasting the marker is not the workflow');
    assert.equal(hasNudgeComment([{ body: nudgeComment() }]), false, 'no author is not the workflow');
    assert.equal(hasNudgeComment([{ body: 'thanks', user: BOT }, { body: null, user: BOT }]), false);
    assert.equal(hasNudgeComment([]), false);
    assert.equal(hasNudgeComment(undefined), false);
  });
});

describe('decide', () => {
  it('nudges a UI report with no attachment: label and comment', () => {
    assert.deepEqual(decide(event()), { action: 'nudge', reason: 'missing-attachment', label: true, comment: true });
  });

  it('nudges once: a labelled and commented report that still lacks evidence is left alone on later edits', () => {
    assert.deepEqual(decide(event({ labels: [{ name: LABEL }] }), { nudged: true }), { action: 'none', reason: 'already-nudged' });
  });

  it('retries only the comment when the label landed but the comment did not', () => {
    assert.deepEqual(decide(event({ labels: [{ name: LABEL }] }), { nudged: false }), {
      action: 'nudge',
      reason: 'missing-attachment',
      label: false,
      comment: true,
    });
  });

  it('re-applies only the label when an image was attached, the label cleared, and the image removed again', () => {
    assert.deepEqual(decide(event(), { nudged: true }), { action: 'nudge', reason: 'missing-attachment', label: true, comment: false });
  });

  it('reads the word from the title alone and from the body alone', () => {
    assert.equal(decide(event({ title: 'Panel overflow', body: 'The UI clips the header count.' })).action, 'nudge');
    assert.equal(decide(event({ title: 'UI: header count clipped', body: '' })).action, 'nudge');
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

  it('clears the label once the edit adds an attachment or drops the UI mention', () => {
    assert.deepEqual(decide({ ...event({ labels: [{ name: LABEL }], body: `Attached: ${PASTED_IMAGE}` }), action: 'edited' }), {
      action: 'clear',
      reason: 'attachment-present',
    });
    assert.deepEqual(decide(event({ labels: [LABEL], title: 'feed(rss): 403', body: 'Polls fail.' })), {
      action: 'clear',
      reason: 'ui-mention-removed',
    });
  });

  it('never depends on the issue state: a closed report is judged the same way', () => {
    assert.equal(decide(event({ state: 'closed' })).action, 'nudge');
    assert.equal(decide(event({ state: 'closed', labels: [{ name: LABEL }], body: PASTED_IMAGE })).action, 'clear');
  });

  it('exempts maintainers, bots and pull requests', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      assert.deepEqual(decide(event({ author_association: association })), { action: 'none', reason: 'trusted-author' }, association);
    }
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']) {
      assert.equal(decide(event({ author_association: association })).action, 'nudge', association);
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

  it('nudge: ensures the label exists, applies it, and comments; the issue state is never written', () => {
    const { calls, gh } = recorder();
    apply({ action: 'nudge', label: true, comment: true }, { gh, ...target });
    assert.deepEqual(calls.map((c) => c.args.slice(0, 4)), [
      ['api', '--method', 'POST', 'repos/koala73/worldmonitor/labels'],
      ['api', '--method', 'POST', 'repos/koala73/worldmonitor/issues/42/labels'],
      ['api', '--method', 'POST', 'repos/koala73/worldmonitor/issues/42/comments'],
    ]);
    assert.equal(calls[0].input.name, LABEL);
    assert.deepEqual(calls[1].input, { labels: [LABEL] });
    assert.match(calls[2].input.body, /paste or drag in a screenshot/);
    assert.ok(calls[2].input.body.endsWith(COMMENT_MARKER));
    for (const call of calls) {
      assert.ok(call.args.includes('--input'), 'every write sends its payload on stdin');
      assert.notEqual(call.args[2], 'PATCH', 'the issue itself is never patched');
      assert.equal(call.input.state, undefined);
    }
  });

  it('nudge writes only the missing half', () => {
    const commentOnly = recorder();
    apply({ action: 'nudge', label: false, comment: true }, { gh: commentOnly.gh, ...target });
    assert.deepEqual(commentOnly.calls.map((c) => c.args[3]), ['repos/koala73/worldmonitor/issues/42/comments']);
    const labelOnly = recorder();
    apply({ action: 'nudge', label: true, comment: false }, { gh: labelOnly.gh, ...target });
    assert.deepEqual(labelOnly.calls.map((c) => c.args[3]), ['repos/koala73/worldmonitor/labels', 'repos/koala73/worldmonitor/issues/42/labels']);
  });

  it('nudge tolerates a label that already exists and fails on any other label error', () => {
    const existing = (args) => {
      if (args[3].endsWith('/labels') && !args[3].includes('/issues/')) {
        throw new Error('gh api failed (1): HTTP 422: Validation Failed {"code":"already_exists"}');
      }
      return '';
    };
    assert.equal(apply({ action: 'nudge' }, { gh: existing, ...target }).length, 3);
    const broken = () => { throw new Error('gh api failed (1): HTTP 403: Resource not accessible'); };
    assert.throws(() => apply({ action: 'nudge' }, { gh: broken, ...target }), /HTTP 403/);
  });

  it('clear only removes the label, and none writes nothing', () => {
    const { calls, gh } = recorder();
    apply({ action: 'clear' }, { gh, ...target });
    assert.deepEqual(calls.map((c) => c.args), [
      ['api', '--method', 'DELETE', `repos/koala73/worldmonitor/issues/42/labels/${LABEL}`],
    ]);
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
  const ghReading = (live, commentPages = [[]]) => {
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args.length === 2 && args[1] === 'repos/koala73/worldmonitor/issues/42') return JSON.stringify(live);
      if (args.includes('--paginate') && args.at(-1) === 'repos/koala73/worldmonitor/issues/42/comments') return JSON.stringify(commentPages);
      return '';
    };
    return { calls, gh };
  };

  it('reads the event payload from GITHUB_EVENT_PATH, then decides from the live issue and its comments, not the snapshot', () => {
    withEvent(event(), (eventPath) => {
      const { calls, gh } = ghReading(issue());
      const decision = main({ GITHUB_EVENT_PATH: eventPath }, gh);
      assert.deepEqual(decision, { action: 'nudge', reason: 'missing-attachment', label: true, comment: true });
      assert.deepEqual(calls[0], ['api', 'repos/koala73/worldmonitor/issues/42']);
      assert.deepEqual(calls[1], ['api', '--paginate', '--slurp', 'repos/koala73/worldmonitor/issues/42/comments']);
      assert.equal(calls.at(-1)[3], 'repos/koala73/worldmonitor/issues/42/comments');
    });
  });

  it('sees the marker comment on any page, so a labelled issue with the comment is not nudged again', () => {
    withEvent(event(), (eventPath) => {
      const pages = [[{ body: 'first', user: { login: 'reporter', type: 'User' } }], [{ body: nudgeComment(), user: BOT }]];
      const { calls, gh } = ghReading(issue({ labels: [{ name: LABEL }] }), pages);
      const decision = main({ GITHUB_EVENT_PATH: eventPath }, gh);
      assert.deepEqual(decision, { action: 'none', reason: 'already-nudged' });
      assert.equal(calls.length, 2, 'only the two reads');
    });
  });

  it('an edit that raced the labelling run still clears: the snapshot is unlabelled, the live issue is labelled with evidence', () => {
    const edited = { ...event({ body: `Attached: ${PASTED_IMAGE}` }), action: 'edited' };
    withEvent(edited, (eventPath) => {
      const { calls, gh } = ghReading(issue({ labels: [{ name: LABEL }], body: `Attached: ${PASTED_IMAGE}` }));
      const decision = main({ GITHUB_EVENT_PATH: eventPath }, gh);
      assert.deepEqual(decision, { action: 'clear', reason: 'attachment-present' });
      assert.equal(calls.filter((args) => args[2] === 'DELETE').length, 1);
    });
  });

  it('a snapshot without evidence does not nudge an issue whose live body now has it', () => {
    withEvent(event(), (eventPath) => {
      const { calls, gh } = ghReading(issue({ body: PASTED_IMAGE }));
      const decision = main({ GITHUB_EVENT_PATH: eventPath }, gh);
      assert.equal(decision.action, 'none');
      assert.equal(calls.length, 2, 'only the two reads');
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

describe('bug report form', () => {
  it('refuses submission without the screenshot field, which is the only pre-creation error GitHub can show', () => {
    const field = bugForm.body.find((entry) => entry.id === 'screenshots');
    assert.ok(field, 'the form must keep its screenshots field');
    assert.equal(field.type, 'textarea');
    assert.equal(field.validations?.required, true);
    assert.match(field.attributes.description, /screenshot/i);
  });
});

describe('issue-ui-evidence workflow', () => {
  const job = workflow.jobs.evidence;
  const pin = (uses) => assert.match(uses, /@[0-9a-f]{40}$/i, `${uses} must be pinned to a commit SHA`);

  it('runs when an issue is opened or edited, so an attached screenshot clears the label', () => {
    assert.equal(workflow.name, 'Issue UI Evidence');
    assert.deepEqual(workflow.on.issues.types, ['opened', 'edited']);
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
