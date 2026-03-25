import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findDuplicateDraftReleaseTags,
  findReleaseStateIssues,
  findVersionMismatches,
  parseCargoLockVersion,
  parseCargoPackageMetadata,
} from '../scripts/release-doctor.mjs';

test('findVersionMismatches accepts fully synchronized release files', () => {
  const mismatches = findVersionMismatches({
    'package.json': '2.6.1',
    'package-lock.json': '2.6.1',
    'src-tauri/tauri.conf.json': '2.6.1',
    'src-tauri/Cargo.toml': '2.6.1',
    'src-tauri/Cargo.lock': '2.6.1',
  });

  assert.deepEqual(mismatches, []);
});

test('findVersionMismatches reports every drifted file against package.json', () => {
  const mismatches = findVersionMismatches({
    'package.json': '2.6.1',
    'package-lock.json': '2.6.1',
    'src-tauri/tauri.conf.json': '2.6.0',
    'src-tauri/Cargo.toml': '2.5.25',
    'src-tauri/Cargo.lock': '2.6.0',
  });

  assert.deepEqual(mismatches, [
    'src-tauri/tauri.conf.json (2.6.0 != 2.6.1)',
    'src-tauri/Cargo.toml (2.5.25 != 2.6.1)',
    'src-tauri/Cargo.lock (2.6.0 != 2.6.1)',
  ]);
});

test('findDuplicateDraftReleaseTags flags tags with multiple drafts', () => {
  const duplicates = findDuplicateDraftReleaseTags([
    { tagName: 'v2.5.25', isDraft: true },
    { tagName: 'v2.5.25', isDraft: true },
    { tagName: 'v2.5.25', isDraft: false },
    { tagName: 'v2.6.1', isDraft: true },
  ]);

  assert.deepEqual(duplicates, ['v2.5.25']);
});

test('findReleaseStateIssues rejects a target tag that already exists remotely without a release', () => {
  const issues = findReleaseStateIssues({
    targetTag: 'v2.6.1',
    remoteTags: new Set(['v2.6.1']),
    releases: [],
  });

  assert.deepEqual(issues, [
    'Remote tag already exists for target release: v2.6.1',
    'Remote tag exists without a GitHub release for target tag: v2.6.1',
  ]);
});

test('findReleaseStateIssues rejects duplicate drafts for the target tag', () => {
  const issues = findReleaseStateIssues({
    targetTag: 'v2.6.1',
    remoteTags: new Set(),
    releases: [
      { tagName: 'v2.6.1', isDraft: true },
      { tagName: 'v2.6.1', isDraft: true },
    ],
  });

  assert.deepEqual(issues, [
    'Multiple draft releases exist for tag: v2.6.1',
  ]);
});

test('findReleaseStateIssues accepts a fresh unreleased target version', () => {
  const issues = findReleaseStateIssues({
    targetTag: 'v2.6.2',
    remoteTags: new Set(['v2.6.1']),
    releases: [
      { tagName: 'v2.6.1', isDraft: false },
    ],
  });

  assert.deepEqual(issues, []);
});

test('parseCargoPackageMetadata reads the package name and version from Cargo.toml', () => {
  const metadata = parseCargoPackageMetadata(`
[package]
name = "worldmonitor-macos"
version = "2.5.25"
description = "World Monitor macOS native desktop application"
`);

  assert.deepEqual(metadata, {
    name: 'worldmonitor-macos',
    version: '2.5.25',
  });
});

test('parseCargoLockVersion resolves the matching package version by Cargo package name', () => {
  const version = parseCargoLockVersion(`
[[package]]
name = "serde"
version = "1.0.0"

[[package]]
name = "worldmonitor-macos"
version = "2.5.25"
`, 'worldmonitor-macos');

  assert.equal(version, '2.5.25');
});
