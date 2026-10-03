# Synthetic security scoring demo

This optional local Python demo is separate from the WorldMonitor application and deployment stack. It does not scan WorldMonitor, validate vulnerabilities, or establish its security posture. All five input records are synthetic. Supplied CVSS values remain unverified.

Run `python3 security-assessment/run_assessment.py` and open `http://127.0.0.1:8050`. The server binds only to loopback, serves an explicit file allowlist, and requires a per-process action token and a matching browser origin for POST actions. It is not a public service. Do not expose it through a proxy or tunnel.

Use `--no-server` for CLI output or `--force-fail` to exercise fallback scoring. Generated results are kept in the ignored `security-assessment/output/` directory. History and failure logs retain the latest 100 entries. Writes replace individual files atomically; a run is not a transaction across files. Run one process at a time. Corrupt input or history causes an explicit error and is retained for inspection. Failure-log errors do not prevent fallback scoring.

Correlations are heuristic relationships based on category and subsystem. They are not proven attack paths. The engine produces no attack paths without validated path evidence. Correlation runs before scoring; fallback risk uses the same posture bands as primary scoring, with engine availability reported separately.

Run the isolated regression suite with:

```sh
python3 -m unittest discover -s security-assessment/tests -v
```

The target review documents record source inspection, not live exploit testing or a security certification.
