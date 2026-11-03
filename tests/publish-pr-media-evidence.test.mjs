import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  assertSupportedGhVersion,
  buildCommentArgs,
  commentsWithMarker,
  markerForEvidence,
  parseArgs,
  publishPrMediaEvidence,
  validateAttachments,
  validateProvenance,
} from '../scripts/publish-pr-media-evidence.mjs';

const SHA = 'a'.repeat(40);
const REPOSITORY = 'koala73/worldmonitor';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function provenanceFixture(overrides = {}) {
  const fixture = {
    artifacts: {
      artifacts: [{ id: 501, name: 'playwright-gallery-1234-2', expired: false }],
    },
    jobs: { jobs: [{ id: 91, name: 'chrome-gallery', conclusion: 'success' }] },
    pr: {
      number: 42,
      state: 'open',
      base: { repo: { full_name: REPOSITORY } },
      head: { repo: { full_name: REPOSITORY }, sha: SHA },
    },
    prNumber: 42,
    repository: REPOSITORY,
    run: {
      id: 1234,
      workflow_id: 77,
      event: 'pull_request',
      conclusion: 'success',
      head_repository: { full_name: REPOSITORY },
      head_sha: SHA,
      html_url: 'https://github.com/koala73/worldmonitor/actions/runs/1234',
      pull_requests: [{ number: 42 }],
      run_attempt: 2,
    },
    runId: 1234,
    workflow: { id: 77, path: '.github/workflows/e2e-visual.yml' },
  };
  return { ...fixture, ...overrides };
}

async function makeGallery(parentPrefix = 'worldmonitor-pr-media-test-') {
  const root = await mkdtemp(path.join(tmpdir(), parentPrefix));
  await mkdir(path.join(root, 'screenshots', 'images'), { recursive: true });
  return root;
}

async function writePng(root, filename, suffix = Buffer.alloc(0)) {
  await writeFile(path.join(root, 'screenshots', 'images', filename), Buffer.concat([PNG_SIGNATURE, suffix]));
}

describe('PR media command arguments and GitHub CLI gate', () => {
  it('parses only positive integer PR and run ids', () => {
    assert.deepEqual(parseArgs(['--pr', '42', '--run-id=1234']), { prNumber: 42, runId: 1234 });
    assert.throws(() => parseArgs(['--pr', '0', '--run-id', '1']), /positive integer/);
    assert.throws(() => parseArgs(['--pr', '1']), /--run-id is required/);
    assert.throws(() => parseArgs(['--pr', '1', '--run-id', '2', '--repo', 'other/repo']), /Unknown argument/);
  });

  it('requires GitHub CLI 2.99.0 or newer', () => {
    assert.deepEqual(assertSupportedGhVersion('gh version 2.99.0 (2026-01-01)'), [2, 99, 0]);
    assert.deepEqual(assertSupportedGhVersion('gh version 3.0.0'), [3, 0, 0]);
    assert.throws(() => assertSupportedGhVersion('gh version 2.98.9'), /2\.99\.0 or newer/);
    assert.throws(() => assertSupportedGhVersion('gh version 2.99.0-rc.1'), /2\.99\.0 or newer/);
    assert.throws(() => assertSupportedGhVersion('not gh'), /Could not parse/);
  });
});

describe('trusted Actions provenance', () => {
  it('accepts the exact workflow, same-repository PR head, successful gallery job, and one artifact', () => {
    const result = validateProvenance(provenanceFixture());
    assert.equal(result.testedHeadSha, SHA);
    assert.deepEqual(result.run, {
      id: 1234,
      attempt: 2,
      url: 'https://github.com/koala73/worldmonitor/actions/runs/1234',
    });
    assert.equal(result.artifact.id, 501);
  });

  it('rejects the wrong workflow, fork, closed PR, stale head, and failed chrome job', () => {
    const wrongWorkflow = provenanceFixture();
    wrongWorkflow.run.workflow_id = 78;
    assert.throws(() => validateProvenance(wrongWorkflow), /different workflow/);

    const fork = provenanceFixture();
    fork.run.head_repository.full_name = 'contributor/worldmonitor';
    assert.throws(() => validateProvenance(fork), /fork/);

    const forkPr = provenanceFixture();
    forkPr.pr.head.repo.full_name = 'contributor/worldmonitor';
    assert.throws(() => validateProvenance(forkPr), /Fork pull requests/);

    const closed = provenanceFixture();
    closed.pr.state = 'closed';
    assert.throws(() => validateProvenance(closed), /not open/);

    const stale = provenanceFixture();
    stale.pr.head.sha = 'b'.repeat(40);
    assert.throws(() => validateProvenance(stale), /head changed/);

    const failedJob = provenanceFixture();
    failedJob.jobs.jobs[0].conclusion = 'failure';
    assert.throws(() => validateProvenance(failedJob), /did not finish successfully/);
  });

  it('rejects expired and ambiguous gallery artifacts', () => {
    const expired = provenanceFixture();
    expired.artifacts.artifacts[0].expired = true;
    assert.throws(() => validateProvenance(expired), /found 0/);

    const ambiguous = provenanceFixture();
    ambiguous.artifacts.artifacts.push({
      id: 502,
      name: 'playwright-gallery-1234-2',
      expired: false,
    });
    assert.throws(() => validateProvenance(ambiguous), /found 2/);
  });
});

describe('PNG attachment boundary', () => {
  it('sorts valid PNGs and derives stable explicit alt text', async () => {
    const root = await makeGallery('worldmonitor media with spaces-');
    try {
      await writePng(root, '010-second_view.png');
      await writePng(root, '002-first-view.png');
      const attachments = await validateAttachments(root);
      assert.deepEqual(
        attachments.map(({ filename, alt, byteSize }) => ({ filename, alt, byteSize })),
        [
          {
            filename: '002-first-view.png',
            alt: 'WorldMonitor E2E visual evidence: first view',
            byteSize: 8,
          },
          {
            filename: '010-second_view.png',
            alt: 'WorldMonitor E2E visual evidence: second view',
            byteSize: 8,
          },
        ],
      );
      assert.ok(attachments.every((attachment) => path.isAbsolute(attachment.path)));

      const evidence = {
        repository: REPOSITORY,
        prNumber: 42,
        testedHeadSha: SHA,
        run: { id: 1234, attempt: 2, url: 'https://example.test/run' },
        attachments,
      };
      const bodyFile = path.join(root, 'comment body.md');
      const args = buildCommentArgs(evidence, bodyFile);
      assert.deepEqual(args.slice(0, 8), [
        'pr',
        'comment',
        '42',
        '--repo',
        REPOSITORY,
        '--body-file',
        bodyFile,
        '--attach',
      ]);
      assert.equal(args[8], `${attachments[0].path}#${attachments[0].alt}`);
      assert.equal(args[9], '--attach');
      assert.equal(args[10], `${attachments[1].path}#${attachments[1].alt}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects bad PNG magic and zero-byte files', async () => {
    const root = await makeGallery();
    try {
      await writeFile(path.join(root, 'screenshots', 'images', 'bad.png'), Buffer.from('not-png!'));
      await assert.rejects(validateAttachments(root), /invalid PNG signature/);
      await writeFile(path.join(root, 'screenshots', 'images', 'bad.png'), Buffer.alloc(0));
      await assert.rejects(validateAttachments(root), /size is outside/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects 51 entries, symlinks, oversized files, and bad filenames', async () => {
    const tooMany = await makeGallery();
    try {
      await Promise.all(Array.from({ length: 51 }, (_, index) => writePng(tooMany, `${index}.png`)));
      await assert.rejects(validateAttachments(tooMany), /found 51/);
    } finally {
      await rm(tooMany, { recursive: true, force: true });
    }

    const linked = await makeGallery();
    try {
      await writePng(linked, 'target.png');
      await symlink('target.png', path.join(linked, 'screenshots', 'images', 'linked.png'));
      await assert.rejects(validateAttachments(linked), /Symlinked screenshot/);
    } finally {
      await rm(linked, { recursive: true, force: true });
    }

    const oversized = await makeGallery();
    try {
      const handle = await open(path.join(oversized, 'screenshots', 'images', 'large.png'), 'w');
      await handle.write(PNG_SIGNATURE, 0, PNG_SIGNATURE.length, 0);
      await handle.truncate(10 * 1024 * 1024 + 1);
      await handle.close();
      await assert.rejects(validateAttachments(oversized), /size is outside/);
    } finally {
      await rm(oversized, { recursive: true, force: true });
    }

    const badName = await makeGallery();
    try {
      await writePng(badName, 'bad name.png');
      await assert.rejects(validateAttachments(badName), /Invalid screenshot filename/);
    } finally {
      await rm(badName, { recursive: true, force: true });
    }
  });

  it('rejects symlinked directory components', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldmonitor-pr-media-link-'));
    const target = await mkdtemp(path.join(tmpdir(), 'worldmonitor-pr-media-target-'));
    try {
      await mkdir(path.join(target, 'images'));
      await writeFile(path.join(target, 'images', 'shot.png'), PNG_SIGNATURE);
      await symlink(target, path.join(root, 'screenshots'));
      await assert.rejects(validateAttachments(root), /path component is not a real directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });
});

describe('author-scoped idempotence and write race handling', () => {
  const marker = markerForEvidence({ repository: REPOSITORY, prNumber: 42, testedHeadSha: SHA });

  it('matches only exact LF or CRLF marker lines from the authenticated author', () => {
    const comments = [
      { id: 1, user: { login: 'publisher' }, body: `text\n${marker}` },
      { id: 2, user: { login: 'publisher' }, body: `text\r\n${marker}\r\nmore` },
      { id: 3, user: { login: 'other' }, body: marker },
      { id: 4, user: { login: 'publisher' }, body: marker.replace(SHA, 'b'.repeat(40)) },
      { id: 5, user: { login: 'publisher' }, body: `embedded ${marker} in prose` },
    ];
    assert.deepEqual(commentsWithMarker(comments, { login: 'publisher', marker }).map(({ id }) => id), [1, 2]);
  });

  it('returns a retry no-op before download or comment creation', async () => {
    const calls = [];
    const runGh = createFakeGh({
      calls,
      initialComments: [{ id: 44, user: { login: 'publisher' }, body: marker }],
    });
    const result = await publishPrMediaEvidence({ prNumber: 42, runId: 1234 }, { repository: REPOSITORY, runGh });
    assert.equal(result.status, 'already-published');
    assert.equal(result.commentId, 44);
    assert.ok(!calls.some((args) => args[0] === 'run'));
    assert.ok(!calls.some((args) => args[0] === 'pr'));
    assert.ok(!calls.some((args) => String(args.at(-1)).endsWith('/artifacts?per_page=100')));
  });

  it('reconciles existing own duplicates without downloading or creating a comment', async () => {
    const calls = [];
    const runGh = createFakeGh({
      calls,
      initialComments: [
        { id: 40, user: { login: 'publisher' }, body: marker },
        { id: 10, user: { login: 'publisher' }, body: `context\r\n${marker}\r\n` },
        { id: 1, user: { login: 'other' }, body: marker },
      ],
    });
    const result = await publishPrMediaEvidence({ prNumber: 42, runId: 1234 }, { repository: REPOSITORY, runGh });
    assert.equal(result.status, 'already-published');
    assert.equal(result.commentId, 10);
    assert.deepEqual(result.deletedDuplicateIds, [40]);
    assert.deepEqual(
      calls.filter((args) => args[0] === 'api' && args[1] === '--method'),
      [['api', '--method', 'DELETE', `repos/${REPOSITORY}/issues/comments/40`]],
    );
    assert.ok(!calls.some((args) => args[0] === 'run'));
    assert.ok(!calls.some((args) => args[0] === 'pr'));
    assert.ok(!calls.some((args) => String(args.at(-1)).endsWith('/artifacts?per_page=100')));
  });

  it('rechecks the live head immediately before the write', async () => {
    const calls = [];
    const runGh = createFakeGh({ calls, staleOnSecondPrRead: true });
    await assert.rejects(
      publishPrMediaEvidence({ prNumber: 42, runId: 1234 }, { repository: REPOSITORY, runGh }),
      /head changed/,
    );
    assert.equal(calls.filter((args) => args[0] === 'api' && args.at(-1).endsWith('/pulls/42')).length, 2);
    assert.ok(!calls.some((args) => args[0] === 'pr'));
  });

  it('keeps the lowest own marker comment and deletes only higher own duplicates', async () => {
    const calls = [];
    const postComments = [
      { id: 20, user: { login: 'publisher' }, body: marker },
      { id: 1, user: { login: 'other' }, body: marker },
      { id: 10, user: { login: 'publisher' }, body: `created\n${marker}` },
      { id: 30, user: { login: 'publisher' }, body: 'unrelated comment' },
    ];
    const runGh = createFakeGh({ calls, postComments });
    const result = await publishPrMediaEvidence({ prNumber: 42, runId: 1234 }, { repository: REPOSITORY, runGh });
    assert.equal(result.status, 'published');
    assert.equal(result.commentId, 10);
    assert.deepEqual(result.deletedDuplicateIds, [20]);
    assert.deepEqual(
      calls.filter((args) => args[0] === 'api' && args[1] === '--method'),
      [['api', '--method', 'DELETE', `repos/${REPOSITORY}/issues/comments/20`]],
    );

    const commentIndex = calls.findIndex((args) => args[0] === 'pr');
    const precedingRemoteCall = calls.slice(0, commentIndex).findLast((args) => args[0] === 'api');
    assert.equal(precedingRemoteCall.at(-1), `repos/${REPOSITORY}/pulls/42`);
    const commentArgs = calls[commentIndex];
    assert.equal(commentArgs[0], 'pr');
    assert.ok(commentArgs.includes('--body-file'));
    assert.ok(commentArgs.includes('--attach'));
  });
});

function createFakeGh({ calls, initialComments = [], postComments = [], staleOnSecondPrRead = false }) {
  let commentsReads = 0;
  let prReads = 0;
  return async (args) => {
    calls.push(args);
    if (args[0] === '--version') return 'gh version 2.99.0 (test)';
    if (args[0] === 'run') {
      const outputDirectory = args[args.indexOf('--dir') + 1];
      await mkdir(path.join(outputDirectory, 'screenshots', 'images'), { recursive: true });
      await writeFile(path.join(outputDirectory, 'screenshots', 'images', '001-dashboard.png'), PNG_SIGNATURE);
      return '';
    }
    if (args[0] === 'pr') return 'https://github.com/koala73/worldmonitor/pull/42#issuecomment-10';
    if (args[0] !== 'api') throw new Error(`Unexpected command: ${args.join(' ')}`);
    if (args[1] === '--method') return '';

    const endpoint = args.at(-1);
    if (endpoint === 'user') return JSON.stringify({ login: 'publisher' });
    if (endpoint.endsWith('/actions/workflows/e2e-visual.yml')) return JSON.stringify({ id: 77 });
    if (endpoint.endsWith('/actions/runs/1234')) return JSON.stringify(provenanceFixture().run);
    if (endpoint.endsWith('/jobs?per_page=100')) return JSON.stringify(provenanceFixture().jobs);
    if (endpoint.endsWith('/pulls/42')) {
      prReads += 1;
      const pr = provenanceFixture().pr;
      if (staleOnSecondPrRead && prReads === 2) pr.head.sha = 'b'.repeat(40);
      return JSON.stringify(pr);
    }
    if (endpoint.endsWith('/artifacts?per_page=100')) return JSON.stringify(provenanceFixture().artifacts);
    if (endpoint.endsWith('/comments?per_page=100')) {
      commentsReads += 1;
      return JSON.stringify([commentsReads === 1 ? initialComments : postComments]);
    }
    throw new Error(`Unexpected API endpoint: ${endpoint}`);
  };
}
