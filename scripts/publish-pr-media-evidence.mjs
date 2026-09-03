#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { titleFromFileName } from './playwright-screenshot-gallery.mjs';

const execFileAsync = promisify(execFile);
const MIN_GH_VERSION = [2, 99, 0];
const MAX_ATTACHMENTS = 50;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Validated evidence that is safe to publish to one pull request.
 *
 * @typedef {object} PrMediaEvidence
 * @property {string} repository
 * @property {number} prNumber
 * @property {string} testedHeadSha
 * @property {{id: number, attempt: number, url: string}} run
 * @property {Array<{path: string, filename: string, byteSize: number, alt: string}>} attachments
 */

export function parseArgs(argv = []) {
  const result = { prNumber: null, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === '--pr') result.prNumber = parsePositiveInteger(readValue(), '--pr');
    else if (arg.startsWith('--pr=')) result.prNumber = parsePositiveInteger(arg.slice(5), '--pr');
    else if (arg === '--run-id') result.runId = parsePositiveInteger(readValue(), '--run-id');
    else if (arg.startsWith('--run-id=')) result.runId = parsePositiveInteger(arg.slice(9), '--run-id');
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (result.prNumber === null) throw new Error('--pr is required');
  if (result.runId === null) throw new Error('--run-id is required');
  return result;
}

function parsePositiveInteger(value, flag) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a safe positive integer`);
  return parsed;
}

function matchGhVersion(output) {
  const match = String(output).match(/\bgh version (\d+)\.(\d+)\.(\d+)(-([^+\s]+))?(?:\+[^\s]+)?\b/i);
  if (!match) throw new Error('Could not parse the GitHub CLI version');
  return match;
}

export function assertSupportedGhVersion(output) {
  const match = matchGhVersion(output);
  const version = match.slice(1, 4).map(Number);
  for (let index = 0; index < MIN_GH_VERSION.length; index += 1) {
    if (version[index] > MIN_GH_VERSION[index]) return version;
    if (version[index] < MIN_GH_VERSION[index]) {
      throw new Error('GitHub CLI 2.99.0 or newer is required for media attachments');
    }
  }
  if (match[5]) throw new Error('GitHub CLI 2.99.0 or newer is required for media attachments');
  return version;
}

export function validateRepository(value) {
  const repository = String(value).trim();
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`Invalid repository ${JSON.stringify(repository)}; expected owner/name`);
  }
  return repository;
}

export function validateCurrentPr(pr, { repository, prNumber, testedHeadSha }) {
  if (!pr || pr.number !== prNumber) throw new Error(`Pull request #${prNumber} was not returned`);
  if (pr.state !== 'open') throw new Error(`Pull request #${prNumber} is not open`);
  if (pr.base?.repo?.full_name !== repository) throw new Error('Pull request base repository does not match');
  if (pr.head?.repo?.full_name !== repository) throw new Error('Fork pull requests cannot receive trusted media evidence');
  if (!SHA_PATTERN.test(String(pr.head?.sha ?? ''))) throw new Error('Pull request head SHA is invalid');
  if (pr.head.sha !== testedHeadSha) throw new Error('Pull request head changed after the visual run');
  return pr;
}

export function selectArtifact(artifactsResponse, { runId, runAttempt }) {
  const expectedName = `playwright-gallery-${runId}-${runAttempt}`;
  const artifacts = Array.isArray(artifactsResponse?.artifacts) ? artifactsResponse.artifacts : [];
  const matches = artifacts.filter((artifact) => artifact?.name === expectedName && artifact.expired === false);
  if (matches.length !== 1) {
    throw new Error(`Expected one non-expired artifact named ${expectedName}; found ${matches.length}`);
  }
  return matches[0];
}

export function validateRunProvenance({ repository, prNumber, runId, workflow, run, jobs, pr }) {
  validateRepository(repository);
  if (!Number.isSafeInteger(workflow?.id) || workflow.id <= 0) throw new Error('E2E Visual workflow identity is invalid');
  if (run?.id !== runId) throw new Error('Actions run id does not match the requested run');
  if (run.workflow_id !== workflow.id) throw new Error('Actions run belongs to a different workflow');
  if (run.event !== 'pull_request') throw new Error('Actions run was not triggered by a pull request');
  if (run.conclusion === 'cancelled') throw new Error('Cancelled Actions runs cannot be published');
  if (run.head_repository?.full_name !== repository) throw new Error('Actions run came from a fork');
  if (!Array.isArray(run.pull_requests) || !run.pull_requests.some((candidate) => candidate?.number === prNumber)) {
    throw new Error(`Actions run is not associated with pull request #${prNumber}`);
  }
  if (!SHA_PATTERN.test(String(run.head_sha ?? ''))) throw new Error('Actions run head SHA is invalid');
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) throw new Error('Actions run attempt is invalid');
  if (!isHttpsUrl(run.html_url)) throw new Error('Actions run URL must use HTTPS');

  const jobList = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
  if (!jobList.some((job) => job?.name === 'chrome-gallery' && job.conclusion === 'success')) {
    throw new Error('The chrome-gallery job did not finish successfully');
  }

  validateCurrentPr(pr, { repository, prNumber, testedHeadSha: run.head_sha });
  return {
    run: { id: runId, attempt: run.run_attempt, url: run.html_url },
    testedHeadSha: run.head_sha,
  };
}

export function validateProvenance(input) {
  const provenance = validateRunProvenance(input);
  return {
    ...provenance,
    artifact: selectArtifact(input.artifacts, {
      runId: input.runId,
      runAttempt: provenance.run.attempt,
    }),
  };
}

function isHttpsUrl(value) {
  return typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:';
}

export function markerForEvidence({ repository, prNumber, testedHeadSha }) {
  validateRepository(repository);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error('Invalid pull request number');
  if (!SHA_PATTERN.test(testedHeadSha)) throw new Error('Invalid tested head SHA');
  return `<!-- worldmonitor-pr-media-evidence:v1 repository=${repository} pr=${prNumber} head=${testedHeadSha} -->`;
}

export function commentsWithMarker(comments, { login, marker }) {
  return comments.filter(
    (comment) =>
      comment?.user?.login === login &&
      typeof comment.body === 'string' &&
      comment.body.split(/\r?\n/).includes(marker),
  );
}

export function buildCommentBody(evidence) {
  const marker = markerForEvidence(evidence);
  return `${marker}\nWorldMonitor E2E visual evidence for tested head \`${evidence.testedHeadSha}\`.\n\nRun: [${evidence.run.id}, attempt ${evidence.run.attempt}](${evidence.run.url})\n\nAttached ${evidence.attachments.length} validated PNG ${evidence.attachments.length === 1 ? 'capture' : 'captures'}.\n`;
}

export function buildCommentArgs(evidence, bodyFile) {
  const args = ['pr', 'comment', String(evidence.prNumber), '--repo', evidence.repository, '--body-file', bodyFile];
  for (const attachment of evidence.attachments) {
    args.push('--attach', `${attachment.path}#${attachment.alt}`);
  }
  return args;
}

export async function validateAttachments(tempDirectory, fs = { lstat, open, readdir }) {
  const screenshotsDirectory = path.join(tempDirectory, 'screenshots');
  const imagesDirectory = path.join(screenshotsDirectory, 'images');
  for (const directory of [tempDirectory, screenshotsDirectory, imagesDirectory]) {
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Attachment path component is not a real directory: ${directory}`);
    }
  }

  const entries = await fs.readdir(imagesDirectory, { withFileTypes: true });
  if (entries.length < 1 || entries.length > MAX_ATTACHMENTS) {
    throw new Error(`Expected 1..${MAX_ATTACHMENTS} screenshot entries; found ${entries.length}`);
  }

  const attachments = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Symlinked screenshot is not allowed: ${entry.name}`);
    if (entry.isDirectory()) throw new Error(`Nested screenshot directory is not allowed: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Screenshot entry is not a regular file: ${entry.name}`);
    if (entry.name.includes('#')) throw new Error(`Screenshot filename cannot contain #: ${entry.name}`);
    if (!FILE_NAME_PATTERN.test(entry.name)) throw new Error(`Invalid screenshot filename: ${entry.name}`);
    if (!entry.name.endsWith('.png')) throw new Error(`Screenshot must use the lowercase .png extension: ${entry.name}`);

    const absolutePath = path.resolve(imagesDirectory, entry.name);
    const entryStats = await fs.lstat(absolutePath);
    if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
      throw new Error(`Screenshot is not a regular file: ${entry.name}`);
    }

    let handle;
    try {
      handle = await fs.open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const fileStats = await handle.stat();
      if (!fileStats.isFile()) throw new Error(`Screenshot is not a regular file: ${entry.name}`);
      if (fileStats.size < 1 || fileStats.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`Screenshot size is outside 1 byte..10 MiB: ${entry.name}`);
      }
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      if (bytesRead !== PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) {
        throw new Error(`Screenshot has an invalid PNG signature: ${entry.name}`);
      }
      attachments.push({
        alt: `WorldMonitor E2E visual evidence: ${titleFromFileName(entry.name)}`,
        byteSize: fileStats.size,
        filename: entry.name,
        path: absolutePath,
      });
    } finally {
      await handle?.close();
    }
  }

  return attachments.sort((left, right) => left.filename.localeCompare(right.filename));
}

export function flattenSlurpedPages(value) {
  if (!Array.isArray(value)) throw new Error('Expected a paginated GitHub response');
  return value.flatMap((page) => {
    if (!Array.isArray(page)) throw new Error('Expected each GitHub response page to be an array');
    return page;
  });
}

function commentIdOrder(left, right) {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export async function publishPrMediaEvidence(options, dependencies = {}) {
  const runGh = dependencies.runGh ?? createGhRunner(dependencies.ghBin);
  const makeTempDirectory = dependencies.mkdtemp ?? mkdtemp;
  const removeTempDirectory = dependencies.rm ?? rm;
  const writeTextFile = dependencies.writeFile ?? writeFile;
  const tempBase = dependencies.tmpdir?.() ?? tmpdir();

  assertSupportedGhVersion(await runGh(['--version']));
  const repository = validateRepository(
    dependencies.repository ?? (await runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])),
  );
  const loginResponse = await ghApiJson(runGh, 'user');
  const login = String(loginResponse?.login ?? '');
  if (!login) throw new Error('Could not resolve the authenticated GitHub login');

  const workflow = await ghApiJson(runGh, `repos/${repository}/actions/workflows/e2e-visual.yml`);
  const run = await ghApiJson(runGh, `repos/${repository}/actions/runs/${options.runId}`);
  const jobs = await ghApiJson(runGh, `repos/${repository}/actions/runs/${options.runId}/jobs?per_page=100`);
  const prEndpoint = `repos/${repository}/pulls/${options.prNumber}`;
  const pr = await ghApiJson(runGh, prEndpoint);
  const provenance = validateRunProvenance({
    jobs,
    pr,
    prNumber: options.prNumber,
    repository,
    run,
    runId: options.runId,
    workflow,
  });

  const marker = markerForEvidence({
    prNumber: options.prNumber,
    repository,
    testedHeadSha: provenance.testedHeadSha,
  });
  const existing = commentsWithMarker(await listComments(runGh, repository, options.prNumber), { login, marker });
  if (existing.length > 0) {
    const sorted = [...existing].sort(commentIdOrder);
    const retained = sorted[0];
    const deletedDuplicateIds = [];
    for (const duplicate of sorted.slice(1)) {
      await runGh(['api', '--method', 'DELETE', `repos/${repository}/issues/comments/${duplicate.id}`]);
      deletedDuplicateIds.push(duplicate.id);
    }
    return {
      status: 'already-published',
      repository,
      prNumber: options.prNumber,
      testedHeadSha: provenance.testedHeadSha,
      runId: options.runId,
      commentId: retained.id,
      deletedDuplicateIds,
    };
  }

  const artifacts = await ghApiJson(
    runGh,
    `repos/${repository}/actions/runs/${options.runId}/artifacts?per_page=100`,
  );
  const artifact = selectArtifact(artifacts, {
    runAttempt: provenance.run.attempt,
    runId: options.runId,
  });

  const tempDirectory = await makeTempDirectory(path.join(tempBase, 'worldmonitor-pr-media-'));
  try {
    await runGh([
      'run',
      'download',
      String(options.runId),
      '--repo',
      repository,
      '--name',
      artifact.name,
      '--dir',
      tempDirectory,
    ]);
    let attachments = await validateAttachments(tempDirectory, dependencies.fs);
    /** @type {PrMediaEvidence} */
    const evidence = {
      attachments,
      prNumber: options.prNumber,
      repository,
      run: provenance.run,
      testedHeadSha: provenance.testedHeadSha,
    };
    const bodyFile = path.join(tempDirectory, 'pr-comment.md');
    await writeTextFile(bodyFile, buildCommentBody(evidence), { encoding: 'utf8', flag: 'wx' });

    attachments = await validateAttachments(tempDirectory, dependencies.fs);
    evidence.attachments = attachments;
    validateCurrentPr(await ghApiJson(runGh, prEndpoint), {
      prNumber: options.prNumber,
      repository,
      testedHeadSha: evidence.testedHeadSha,
    });
    await runGh(buildCommentArgs(evidence, bodyFile));

    const matches = commentsWithMarker(await listComments(runGh, repository, options.prNumber), { login, marker })
      .sort(commentIdOrder);
    if (matches.length === 0) throw new Error('Created comment could not be confirmed');
    const retained = matches[0];
    const deletedDuplicateIds = [];
    for (const duplicate of matches.slice(1)) {
      await runGh(['api', '--method', 'DELETE', `repos/${repository}/issues/comments/${duplicate.id}`]);
      deletedDuplicateIds.push(duplicate.id);
    }

    return {
      status: 'published',
      repository,
      prNumber: options.prNumber,
      testedHeadSha: evidence.testedHeadSha,
      runId: options.runId,
      commentId: retained.id,
      attachmentCount: evidence.attachments.length,
      deletedDuplicateIds,
    };
  } finally {
    await removeTempDirectory(tempDirectory, { recursive: true, force: true });
  }
}

export function createGhRunner(ghBin = 'gh') {
  return async (args) => {
    const { stdout } = await execFileAsync(ghBin, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    return stdout;
  };
}

async function ghApiJson(runGh, endpoint) {
  const raw = await runGh(['api', endpoint]);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`GitHub API returned invalid JSON for ${endpoint}`);
  }
}

async function listComments(runGh, repository, prNumber) {
  const endpoint = `repos/${repository}/issues/${prNumber}/comments?per_page=100`;
  const raw = await runGh(['api', '--paginate', '--slurp', endpoint]);
  try {
    return flattenSlurpedPages(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`GitHub API returned invalid JSON for ${endpoint}`);
    throw error;
  }
}

async function main() {
  const result = await publishPrMediaEvidence(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Terminal success marker. Emitted from .then() so it can ONLY print after main() has fully
  // resolved — a throw anywhere inside, including a late publish step, skips it. Any marker
  // written INSIDE main() would print before later work and could vouch for a run that then
  // died (exactly how #6092 stayed invisible). Format mirrors runSeed() so the crash
  // diagnostic recognises it; without it a clean run is indistinguishable from a silent death.
  const __runStartedAt = Date.now();
  main()
    .then(() => console.log(`\n=== Done (${Date.now() - __runStartedAt}ms) ===`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
