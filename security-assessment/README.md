# Security Assessment Platform — World Monitor Application

A lightweight, deterministic Security Assessment & Risk Scoring Platform built for **SIH Problem Statement 26163**.

---

## 🏛️ Architecture Overview

```
security-assessment/
├── engine/
│   ├── scoring.py              # Deterministic risk-scoring engine (0-100) & CVSS metrics validator
│   ├── correlation.py          # Evidence-based correlation & Potential Attack Path graph builder
│   ├── failsafe.py             # Backup fallback engine & failure logger
│   └── comparison.py           # Comparative delta analysis engine (14 scenarios)
├── frontend/
│   └── index.html              # Modern dark SOC security dashboard UI & Contributor view
├── tests/
│   └── test_failsafe.py        # Comprehensive unit test suite
├── data/
│   ├── findings.json           # Input evidence findings dataset
│   ├── assessment_results.json # Generated assessment output artifact
│   ├── history.json            # Assessment run execution log
│   └── comparisons.json        # Comparative assessment delta results
├── run_assessment.py           # Main launcher & HTTP web server script
├── MATH_MODEL.md               # Risk scoring mathematics and posture formulas
├── SECURITY_RECONNAISSANCE.md # Static reconnaissance and attack surface analysis
├── TARGET-001-SSRF-REVIEW.md   # Security review: RSS Proxy / SSRF Controls
├── TARGET-002-WEBHOOK-REVIEW.md# Security review: Webhook Signature Verification
├── TARGET-003-MCP-HMAC-REVIEW.md# Security review: Internal MCP HMAC Replay Cache
├── TARGET-004-TAURI-SIDECAR-REVIEW.md# Security review: Tauri Desktop Local Sidecar Binding
└── README.md
```

---

## ⚠️ Important Security Evidence Rule & Status

> [!IMPORTANT]
> **SYNTHETIC / DEMONSTRATION DATA NOTICE**
> The five findings (`SEC-001` through `SEC-005`) in `data/findings.json` are **SYNTHETIC / DEMONSTRATION DATA** used for benchmarking risk scoring algorithms, fail-safe fallbacks, and dashboard visualization. They are **NOT VERIFIED WORLD MONITOR VULNERABILITIES**.

### Current Assessment Target Status
The actual reviewed World Monitor security targets evaluated during reconnaissance have the following results:

| Target ID | Component / Surface | Status |
| :--- | :--- | :--- |
| **TARGET-001** | RSS Proxy / SSRF Controls | `SOURCE-PROTECTED` |
| **TARGET-002** | Webhook Signature Verification | `SOURCE-PROTECTED` |
| **TARGET-003** | Internal MCP HMAC Replay Cache | `SOURCE-PROTECTED` |
| **TARGET-004** | Tauri Desktop Local Sidecar Binding | `SOURCE-PROTECTED` |

---

## 🔬 Evidence-Gated Assessment Methodology

The framework strictly enforces an evidence-gated security evaluation workflow:

```
Reconnaissance ➔ Source Review ➔ Candidate Target ➔ Controlled Validation ➔ Evidence ➔ Risk/CVSS ➔ Remediation ➔ Re-test
```

1. **Reconnaissance**: Static code analysis and attack surface mapping (`SECURITY_RECONNAISSANCE.md`).
2. **Source Review**: Inspecting handler implementations and security boundary code.
3. **Candidate Target Identification**: Documenting potential targets requiring verification.
4. **Controlled Validation**: Non-destructive, evidence-focused verification.
5. **Evidence Collection**: Extracting exact file paths, line numbers, and proof snippet code.
6. **Risk/CVSS Scoring**: CVSS v4.0 scores are assigned **only** when verified evidence exists; otherwise marked `REQUIRES VALIDATION`.
7. **Remediation**: Recommending actionable fix paths.
8. **Re-test**: Validating posture improvements via comparative analysis.

---

## ⚡ Quick Start & Execution

### 1. Run Assessment Server (Interactive UI)
```bash
python security-assessment/run_assessment.py
```
Access the dashboard at `http://localhost:8050`.

### 2. Run CLI Mode Only
```bash
python security-assessment/run_assessment.py --no-server
```

### 3. Run Unit Tests
```bash
python -m unittest discover -s security-assessment/tests -v
```

---

## 👥 Contributors & Credits

<p align="left">
  <a href="https://github.com/varunsai20-a11y" target="_blank">
    <img src="https://github.com/varunsai20-a11y.png" alt="Varun" width="80" height="80" style="border-radius: 50%;" />
  </a>
</p>

- **Contributor**: **[Varun](https://github.com/varunsai20-a11y)** (`varunsai20-a11y`)
- **Role**: Security Assessment Contributor
- **Contribution**: Security assessment framework and security research for World Monitor, including source reconnaissance, security target reviews, evidence-gated finding analysis, risk scoring, fail-safe assessment, comparison analysis, and controlled remediation workflow.
