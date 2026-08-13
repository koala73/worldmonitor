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
