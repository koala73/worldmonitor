# CII v15 calibration: pre-registration

Registered at 2026-11-12T19:26:40.877672+00:00 before any candidate formula is evaluated in this session. The final study will be committed after U2. No scorer implementation is authorized by this document.

## Fixed acceptance thresholds

- Must pass: P1 subject to OQ1, P2, P3a/b/c, P5a/b/c, P7a/b, P8a, P14, P15a–e and P9 on a located production fixture. All thresholds in the final U2 brief remain fixed.
- P1: score increment >=0.5 for each scored channel and country when initial score <95, with strike feed present and absent. Headline increment is measured separately pending OQ1.
- P2: range of logit score increments <=0.25, measured on unrounded latent as well as the existing rounded-score test, with strike feed present and absent.
- P5b: at most7 of31 scores in every half-open5-point interval on every committed fixture. Use the existing scorer’s integer score convention; report continuous values separately.
- P15 anchors: quiet OECD0–15, OECD riots35–55, OECD strike campaign45–65, all-country chronic civil war70–100, all-country full-scale war85–100. Use the existing scenario inputs unchanged first; report proposed per-capita scenario separately.
- P13a target: >=50% of cross-country score variance attributable to evidence under30days old on each fixture. Define B as the score after removing all evidence under30days old, L=S-B; share = Cov(L,S)/Var(S). This assigns the covariance equally to the two components and makes the baseline and live shares sum to1. Do not clip negative shares or shares above1; report zero-variance cases as undefined. This is a target requiring owner sign-off if missed, not a must-pass property. Choose50% because the stated product problem is that old/static inputs dominate cross-country variation; it is fixed before results.
- Benchmark: Spearman rank agreement with GPI risk direction >=0.75 and decrease from released v14 <=0.02. Any shortfall needs a stated construct reason; missing benchmark coverage is unverified, never a pass. Use the same country intersection for both formulas and report it.
- No floor, named-country calibration target, arbitrary prior, threshold relaxation, or new input family.

## Candidate design matrix

Compare linear evidence with a high cap and smooth saturating evidence; per-family maximum and incident deduplication plus bounded union; UCDP per-capita-only and a documented population-normalised/absolute combination. Do not select constants using country identities. Priors use z=a-b*PV with the verified pinned2025 WGI estimates. Record analytic bounds on a,b from quiet/riot/strike bands, and war bounds for lowest-prior and largest-population countries. Search a bounded disclosed grid and report empty regions honestly.

OQ1–4 remain owner decisions. Candidate exploration is throwaway; only study results and proposed exact amendments enter the docs PR. No U4 before owner rulings.
