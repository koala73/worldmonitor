# Risk Mathematics & Scoring Architecture

This document describes the dual-layer risk scoring architecture used in the **World Monitor Security Assessment Platform (SIH PS 26163)**.

---

## 1. Technical Severity vs. Contextual Risk Priority

The platform distinguishes between two metrics:

| Metric | Scale | Purpose | Scope |
| :--- | :--- | :--- | :--- |
| **CVSS v4.0** | `0.0 – 10.0` | Standardized technical vulnerability severity | Global industry standard |
| **Contextual Risk Priority** | `0.0 – 100.0` | World Monitor project-specific remediation priority | Target-specific assessment |

---

## 2. CVSS v4.0 Representation

CVSS v4.0 provides a standardized metric for technical severity:
- **0.0**: None
- **0.1 – 3.9**: Low
- **4.0 – 6.9**: Medium
- **7.0 – 8.9**: High
- **9.0 – 10.0**: Critical

### Verification Constraint
If a finding lacks full source verification metrics required to calculate a valid CVSS v4.0 vector, the platform marks the CVSS status as `REQUIRES VALIDATION` to avoid fabricating unverified CVSS vector strings.

---

## 3. Contextual Risk Priority Formula (0–100)

The Contextual Risk Priority represents how urgently a finding should be prioritized within the specific World Monitor architecture:

$$\text{BaseImpact} = 0.30 \cdot S + 0.25 \cdot E + 0.20 \cdot X + 0.15 \cdot K + 0.10 \cdot A$$

$$\text{ContextualRiskPriority} = \text{round}\Big(\min\big(100.0, \, 100 \cdot \text{BaseImpact} \cdot C\big), \, 1\Big)$$

Where:
- $S$: **Severity Weight** ($1.0$ Critical, $0.75$ High, $0.50$ Medium, $0.25$ Low)
- $E$: **Exploitability Factor** ($0.0 – 1.0$)
- $X$: **Exposure Factor** ($0.0 – 1.0$)
- $K$: **Component Criticality** ($0.0 – 1.0$)
- $A$: **Attack Path Impact** ($0.85$ if linked to a correlated path, else $0.20$)
- $C$: **Evidence Confidence Factor** ($0.0 – 1.0$)

---

## 4. Evidence Confidence

**Confidence represents evidence quality**, NOT vulnerability severity:
- Higher confidence ($95\%$) indicates strong evidence backing the observation.
- Confidence acts as a scaling multiplier $C$ on the contextual impact, ensuring low-confidence observations receive appropriate investigation priority.

---

## 5. Security Posture Score (0–100)

$$\text{PostureScore} = \text{round}\Big(\max\big(0.0, \, 100.0 - (0.6 \cdot \text{MaxPriority} + 0.4 \cdot \text{AveragePriority})\big), \, 1\Big)$$

- **80 – 100**: STRONG (Low Risk)
- **60 – 79**: MODERATE (Medium Risk)
- **40 – 59**: DEGRADED (High Risk)
- **0 – 39**: CRITICAL RISK

---

## 6. Limitations & Disclaimer

- Findings are based on static code observations and configuration patterns.
- Observations requiring deeper runtime validation must be marked `REQUIRES VALIDATION` and must not be treated as confirmed exploits.
