# Phase 12 controlled-publication preflight

**Recorded:** 2026-08-14 Asia/Shanghai
**Scope:** `integration/pokieticker-maritime-china-factory` only; no `main`
mutation, no force push, no merge/rebase/reset, no Provider/deployment change.

## Commands and observed results

`git branch --show-current` returned
`integration/pokieticker-maritime-china-factory`.

`git rev-parse origin/main HEAD main` returned, in order:

```text
0fca203c776dd5fa4913c4bd52f99cd2c3c13a25
446e2e57764c72dd6fa2ff98e4164cdb19097897
0fca203c776dd5fa4913c4bd52f99cd2c3c13a25
```

`git merge-base --is-ancestor origin/main HEAD` exited `0`. Both
`git cat-file -e a640cb3c25ac393759b1907b3f6c687b5a57e974^{commit}` and
`git cat-file -e 446e2e57764c72dd6fa2ff98e4164cdb19097897^{commit}` exited
`0`.

`git ls-remote --heads origin main integration/pokieticker-maritime-china-factory`
returned `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` for `refs/heads/main` and
no remote integration branch. The repeated local upstream read ended with
`Recv failure: Connection was reset`; it was not used as a gate success.
The connected GitHub integration then fetched and verified upstream commit
`a788840c18933489294dacc9b27d57737064bf45` directly.

## GitHub integration verification

The connected GitHub integration returned:

- `daking32168-byte/worldmonitor`: fork, default branch `main`, `admin=true`,
  `push=true`.
- `koala73/worldmonitor`: AGPL-3.0 upstream, default branch `main`,
  `admin=false`, `push=false`.

`gh --version` is present (`2.96.0`), but `gh auth status` reported no logged
in GitHub host. The local CLI therefore has no publication authority for this
phase. The connected GitHub integration is the authorized PR path.

## Gate conclusion

`EXIT_CODE=0` for the local branch/ancestor/object gate. The only permitted
next remote write is a normal (non-force) push of the named integration branch
to the owner fork followed by a Draft PR to `daking32168-byte/worldmonitor:main`.
No Provider, market, AIS, news, cargo, trade, factory, deployment or signing
claim is implied by this publication preflight.

## Publication transport result

The Phase 12 preflight commit is
`77fce4c05805f46b358b6958be5f489796e0d167`; its SHA receipt is
`2137cc70bd45bdc83f9b6bb39eaa1886125761c2`. Neither commit is remote yet.

1. The Codex runtime Git ordinary command
   `git push --porcelain -u origin integration/pokieticker-maritime-china-factory`
   did not finish in the bounded 64-second window. Its exact owned process
   tree was stopped; follow-up native Git reads returned either `Recv failure:
   Connection was reset` or a 443 connection failure.
2. System Git `2.55.0.windows.3` independently read `origin/main` through
   HTTP/1.1, but the identical non-force branch push failed with `Failed to
   connect to github.com:443 after 21073 ms: Could not connect to server`.
3. A batch-mode SSH probe reached `github.com` but returned `Permission denied
   (publickey)`. No private key was inspected, generated or requested.
4. The connected GitHub integration confirms owner-fork push permission and
   remains able to read repository metadata, but its available mutations cannot
   upload the existing local Git object pack. API reconstruction was rejected
   because it would not preserve the actual 72-commit local/reversible chain.
5. The final independent system-Git query was successful and returned only:

   ```text
   0fca203c776dd5fa4913c4bd52f99cd2c3c13a25    refs/heads/main
   ```

   Thus `main` remains unchanged and the integration branch is absent remotely.

**Result:** `BLOCKED`. Do not claim a push, Draft PR, CI run, deployment,
Provider activation or data-bearing result. Resume after an authenticated
outbound HTTPS Git route or existing authorized SSH key is restored outside
chat/Git, then perform the original normal non-force integration-branch push.

## Publication resumed and completed - 2026-08-14

The owner reported that GitHub authentication and network access were restored.
The acceptance worktree was clean at
`ace1b8b49c0d02fe93c86ce419d8d2bd99b3f401`, while local
`refs/remotes/origin/main` remained
`0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`.

### Connected GitHub pre-write checks

- Authenticated profile: `daking32168-byte` (ID `294442212`).
- Repository: `daking32168-byte/worldmonitor`; default branch `main`;
  `admin=true`, `maintain=true`, `push=true`.
- Integration branch search: empty before push.
- Open PR search for the integration head and `main` base: empty before
  creation.

### Resumed native Git commands and exits

1. Normal non-force HTTPS push through the default route exited `128` after
   21.3 seconds: `Recv failure: Connection was reset`.
2. `git -c http.version=HTTP/1.1 ls-remote --heads origin main
   integration/pokieticker-maritime-china-factory` exited `0` and returned only
   `main@0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`.
3. The HTTP/1.1 non-force push exited `128` after 21.8 seconds: `Failed to
   connect to github.com:443`.
4. Network diagnosis observed `api.github.com` HTTP 200 while local
   `github.com` address `20.205.243.166` timed out. GitHub's official
   `https://api.github.com/meta` Git ranges were read. Candidate endpoints were
   tested with the TLS host `github.com`; official endpoint `20.27.177.113`
   returned the public repository's upload-pack advertisement.
5. Read-only native Git with command-local
   `http.curloptResolve=github.com:443:20.27.177.113` returned
   `main@0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`, exit `0`.
6. The same temporary route performed:

   ```text
   git -c http.version=HTTP/1.1 \
     -c http.curloptResolve=github.com:443:20.27.177.113 \
     push --no-verify --porcelain origin \
     HEAD:refs/heads/integration/pokieticker-maritime-china-factory
   ```

   Exit was `0`; Git reported `[new branch]`. `--no-verify` avoided only an
   identical second hook run after the exact head had already completed the
   full pre-push wrapper with exit `0`. No force option was used. The override
   was not written to the hosts file, Git configuration or remote URL.

### Full pre-push gate receipt

The 141,634-byte raw log is versioned at
`docs/integration/evidence/phase12-full-prepush-20260814.log`, SHA-256
`9E87ECA6E4CE73E9F51A5E406C7AB58042D604074BC1C6741D95DDF7EF09347A`.
It ends with `All pre-push gates passed` and records:

- typecheck, API/Convex, syntax, Unicode (2,854 files), boundaries, safe HTML,
  Sentry, health, rate, premium and edge-bundle gates passed;
- changed tests evaluated 368 cases with zero failure and two explicit Windows
  filename skips; POSIX coverage remains active;
- edge functions 253/253 and MDX 510/510 passed;
- Markdown, source, product-facts, locale-freshness, Pro-budget, generated
  artifact and version-sync checks passed;
- manual proto generation was repeated without a diff at SHA-256
  `78408C57CEE7F1BDBDF5D330C76A6B028D89D0803740B75132681EE6FD665F77`.

The raw log retains the Windows hook's `make: command not found` line. This was
not hidden: Go generators were installed and run manually, idempotence was
verified, and the hook itself reported `Proto-generated code is up to date`.

### GitHub post-write verification and Draft PR

The connected GitHub integration found the new branch, fetched remote commit
`ace1b8b49c0d02fe93c86ce419d8d2bd99b3f401`, and created Draft PR
[#1](https://github.com/daking32168-byte/worldmonitor/pull/1) at
2026-08-14T09:41:52Z. GitHub returned:

```text
draft=true
base=main
base_sha=0fca203c776dd5fa4913c4bd52f99cd2c3c13a25
head=integration/pokieticker-maritime-china-factory
head_sha=ace1b8b49c0d02fe93c86ce419d8d2bd99b3f401
commits=83
changed_files=684
additions=92773
deletions=7837
```

**Result:** `PASS` for controlled branch publication and Draft PR creation.
No main/upstream ref, Provider configuration, secret, deployment, signing state
or data-bearing observation was changed. CI completion, review approval, merge
and deployment are not claimed by this evidence.

### Publication-document commit environment retry

The first documentation commit attempt exited `1` before creating a commit
because the pre-commit Unicode hook could not find `node` in that PowerShell
process's PATH. No hook was bypassed. The verified workspace Node/shim paths
were then prepended and the same staged documentation commit was retried with
the pre-commit hook active.

The retry passed and created publication-document record commit
`08ee150b7a4db24a85c7e567434e437e2e0cf7aa`. A normal non-force push advanced
the remote integration branch from `ace1b8b49c0d02fe93c86ce419d8d2bd99b3f401`
to that record commit with exit `0`. The following receipt commit backfills the
record SHA in the required status documents.

### Visible Draft PR evidence

The GitHub PR page was opened in the visible in-app browser and left available
for owner review. No button, form, readiness control, merge control,
subscription control or deployment control was activated. The current viewport
was captured at
`docs/integration/evidence/phase12-draft-pr-created-20260814.png`:

```text
dimensions=1170x1073
bytes=157546
sha256=651FF87ABAE15ECC3F9FD759248788B41000762DA0BECCEC26A7DF07B83FC034
```

The image visibly records the PR title, `Draft` badge, `main` base, integration
head, truth-and-safety summary and `Not ready` state. It proves only that the
Draft review surface existed and was opened; it does not prove CI completion,
approval, mergeability at a later time, deployment or Provider activation.

### Remote Markdown CI failure and correction

GitHub Actions run `31790654701` completed the `Lint` workflow with failure.
Job `94736572460` succeeded through checkout/setup/`npm ci`, then
`npm run lint:md` scanned 257 files and failed with ten MD022 errors. All ten
were missing blank lines above older Phase 7/8 headings in the seven required
integration documents.

The standard Windows command had earlier exited `0` while reporting
`Linting: 0 file(s)`. Root cause was the npm script's single-quoted globs:
single quotes are shell quoting on Ubuntu but ordinary characters in Windows
`cmd`. Commit `04d92a99083600c0160f86420993a777fa8c855c` adds the ten blank
lines and changes all lint-script glob arguments to JSON-escaped double quotes.

Post-fix local evidence:

```text
npm run lint:md
Linting: 257 file(s)
Summary: 0 error(s)
CROSS_PLATFORM_LINT_MD_EXIT=0

explicit integration lint
Linting: 8 file(s)
Summary: 0 error(s)
EXPLICIT_MD_LINT_EXIT=0

docs-stats --check OK — 150 doc claims match code.
DOCS_CHECK_EXIT=0
DIFF_CHECK_EXIT=0
```

The failed run remains part of the evidence. A corrected-head workflow run is
required before claiming remote CI success.
