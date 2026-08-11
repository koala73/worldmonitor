# Phase 0 Closure Evidence

**Recorded:** 2026-08-11T16:47:20+08:00
**Scope:** safety inventory, Git isolation, source provenance, legacy backup recovery audit, and documentation receipt. This is not a product-functionality test.

## Command log and exit codes

| Command / action | Exit | Result |
|---|---:|---|
| `GIT_INDEX_FILE=.git/index.phase0 git status --short --branch` | 0 | Clean source worktree on `integration/phase0-safety-inventory`; branch ahead 1 of `origin/main` |
| `git rev-parse HEAD` with the isolated index | 0 | `81369e41cfd0e3dd454dbd37ae3739b5aa53b056` |
| `git branch -vv` with the isolated index | 0 | `main` and `backup/pre-worldmonitor-mother-20260811-162026` at `0fca203...`; Phase 0 branch isolated |
| `git remote -v` with the isolated index | 0 | `origin=daking32168-byte/worldmonitor`, `upstream=koala73/worldmonitor` |
| `git diff --cached --check` with the isolated index | 0 | No staged whitespace or staged content before backfill |
| `git diff --name-only origin/main...HEAD` | 0 | Only the seven `docs/integration` Phase 0 documents changed; no SQLite or large binary was introduced by Phase 0 |
| Connected GitHub app recent-commit lookup | 0 | Fork `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; upstream `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`; PokieTicker `c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` |
| Targeted secret-pattern scan | 0 | No AWS, GitHub, OpenAI-style, Google, or Slack credential pattern found in the workspace |
| Backup sample and restoration-readability probe | 0 | 20 deterministic SHA-256 sample records and three source/destination match records below |

The normal `.git/index` remains absent while `.git/index.lock` exists and the host refuses its removal. The checkout has not been reset, repaired by deletion, or force-updated. The Git-native isolated index is the authoritative Phase 0 verification path.

## Deterministic backup integrity sample

Selection population: 5,876 non-sensitive, non-`node_modules` files at or below 2 MiB. Fixed selection seed: `20260811`.

```text
SAMPLE|third_party\worldmonitor-upstream\tests\app-destroy-lifecycle.test.mjs|10735|B1CD338E4889C66CB7A752F0619B49028D1B248D167C02A19EC37A5D9C0C49F8
SAMPLE|third_party\worldmonitor-upstream\src\config\variant-meta.ts|7925|82746033525D3BFC450895EC4DEAEF1B7F8408E0BFC9BE9EB982A6DFEA0A410D
SAMPLE|third_party\worldmonitor-upstream\shared\stablecoins.json|385|F674092238EE293B8B531FF7921B506586CB3476C18D27B441D2BE71E16873B2
SAMPLE|third_party\worldmonitor-upstream\src\components\map-cluster-gl.ts|1992|7A40065FBF984A3D4DC0AD270A2197AF6402BD53F58A7F4EBE2920D3431C743F
SAMPLE|third_party\worldmonitor-upstream\server\worldmonitor\infrastructure\v1\handler.ts|1144|7DCC579034E1E7FB6A8A0D852B000FB922A1BA05DCE0CD788561A8D675BDBDD4
SAMPLE|third_party\worldmonitor-upstream\blog-site\public\images\blog\supply-chain-early-warning-dashboard-worldmonitor-api-640.webp|28032|5A059639D7ED9A0A0C4884BFDB7ADFBEA09CEA838CDA94F0C2F9EDCB246DCEA2
SAMPLE|third_party\worldmonitor-upstream\src\shared\storage-facility-registry-store.ts|3426|CDAB989D36CA7EE7047A070BA24C3D270071E0F2B130BEBC3661A7FE914F222B
SAMPLE|third_party\worldmonitor-upstream\server\worldmonitor\economic\v1\get-nat-gas-storage.ts|1178|EF0469E9A1460C11B4526A52F15C45161B9C0325AB93B2FDE2EB10BCA868562A
SAMPLE|third_party\worldmonitor-upstream\blog-site\src\data\glossary.ts|25859|7716B23C131FF143F07AADB66EA9696CCE9F97B0E7467E310FA0D579CD3A7895
SAMPLE|backend\src\collector\x.ts|2173|D7987D8999BC5E73A37C20127A83A33BA0B276CEC58695DAF19C05FBC7E15407
SAMPLE|third_party\worldmonitor-upstream\src\components\deduction-probability.ts|3457|F26DB4C8CE73599135B2DA54A2A0F23CE1D531531B198A1E380940589FAA5F25
SAMPLE|third_party\worldmonitor-upstream\blog-site\src\content\blog\track-refugee-displacement-flows-unhcr-worldmonitor.md|5366|6EE5D27998F306E734FB4886DC91DEE8381398F6BDA8F701FC1C510DF805755E
SAMPLE|third_party\worldmonitor-upstream\tests\resilience-net-imports-denominator.test.mts|6957|9585E9315AA3D7F355293C2B662127AA2C501CAE27D7856145A4FBF8E4AE2FF2
SAMPLE|third_party\worldmonitor-upstream\convex\payments\subscriptionHelpers.ts|80443|D1968D4E7CF7B1E2EC438A9B87169E1CD61C3E86A7C72761A7C2D3E1BE3FA94B
SAMPLE|third_party\worldmonitor-upstream\blog-site\public\images\blog\live-webcams-from-geopolitical-hotspots-640.webp|34454|57A416C4313AF14A65DE273B37C4EA316047BD062938E2B526292360A6432990
SAMPLE|third_party\worldmonitor-upstream\server\worldmonitor\intelligence\v1\_relay.ts|76|CA7D7EEB13AAC497A848E7B2F0BE80871382C869A74E0116A6969E991A5217E4
SAMPLE|third_party\worldmonitor-upstream\consumer-prices-core\configs\retailers\sainsburys_gb.yaml|554|EBAE1922098FBCF4D274949B8CB1C7C4F9902AC2E917E16681004FF5A11530BC
SAMPLE|third_party\worldmonitor-upstream\src\components\map\input-delay-interactions.ts|1794|0103B9BDED0CB19A3527584203A3D7049C3D986F3BD1AB46CAC39D717A8F19BD
SAMPLE|third_party\worldmonitor-upstream\tests\map-harness.html|319|4A323D74EC0776F3C105D9D81042ACD199E701B131EC3B8D8B7509118E743D0E
SAMPLE|third_party\worldmonitor-upstream\blog-site\public\images\blog\energy-shock-monitoring-chokepoints-worldmonitor.webp|85646|EA7EBC68FE6FC1BE11210D7EDAE3B92FF7841A314F74C468C99471E0E265EB78
```

## Read-only restoration probe

The following files were copied from the backup to `D:\使用AI专属文件夹\global-intelligence-earth\_codex_phase0_restore_probe_20260811_1640` and read back. Each source/destination hash is identical.

```text
RESTORE_MATCH|README.md|15078|159D3323B38DD6DA9B3E4D28AE4F95501B7824460E5B3C649F43E23A1F0A3BB6|159D3323B38DD6DA9B3E4D28AE4F95501B7824460E5B3C649F43E23A1F0A3BB6|True
RESTORE_MATCH|frontend\package.json|944|C2779FA8B98441072CCAE9DB59489094892F2E4F9916BB7948E9EF2209E49BEB|C2779FA8B98441072CCAE9DB59489094892F2E4F9916BB7948E9EF2209E49BEB|True
RESTORE_MATCH|backend\package.json|935|857B53D7FE20F0D76A73D6ACA52411ADDBED8A924F47D4E219759CD835D5BEB0|857B53D7FE20F0D76A73D6ACA52411ADDBED8A924F47D4E219759CD835D5BEB0|True
```

The host rejected the one explicitly scoped `Remove-Item -LiteralPath` cleanup attempt. No alternative destructive mechanism was used. The temporary probe contains only the three copies above and is outside both project roots.
