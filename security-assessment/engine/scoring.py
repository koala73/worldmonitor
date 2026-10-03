"""
Risk Scoring Engine for World Monitor Security Assessment
Implements CVSS v4.0 technical severity tracking, Contextual Risk Priority (0-100),
Evidence Confidence scaling, and Security Posture calculation.
"""

import json
from typing import Dict, List, Any, Tuple

SEVERITY_WEIGHTS = {
    "CRITICAL": 1.0,
    "HIGH": 0.75,
    "MEDIUM": 0.50,
    "LOW": 0.25
}

CATEGORY_VECTORS = {
    "Authentication": {"exploitability": 0.90, "exposure": 0.95, "criticality": 0.95},
    "Access Control": {"exploitability": 0.85, "exposure": 0.80, "criticality": 0.90},
    "Input Handling": {"exploitability": 0.95, "exposure": 0.85, "criticality": 0.95},
    "API Security": {"exploitability": 0.70, "exposure": 0.90, "criticality": 0.80},
    "Data Exposure": {"exploitability": 0.50, "exposure": 0.65, "criticality": 0.70},
    "Cryptography": {"exploitability": 0.75, "exposure": 0.60, "criticality": 0.85}
}

REQUIRED_FINDING_FIELDS = ["id", "title", "category", "severity", "confidence", "file", "evidence", "description", "remediation"]

def validate_finding(finding: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Validate schema completeness and constraints of a finding item."""
    errors = []
    for field in REQUIRED_FINDING_FIELDS:
        if field not in finding or finding[field] is None:
            errors.append(f"Missing required field '{field}'")
            
    conf = finding.get("confidence", 0)
    if not isinstance(conf, (int, float)) or conf < 0 or conf > 100:
        errors.append(f"Confidence value '{conf}' must be a number between 0 and 100")
        
    sev = str(finding.get("severity", "")).upper()
    if sev not in SEVERITY_WEIGHTS:
        errors.append(f"Invalid severity level '{sev}'")
        
    return (len(errors) == 0, errors)

def parse_cvss_v4(finding: Dict[str, Any]) -> Dict[str, Any]:
    """
    Parses CVSS v4.0 data if provided; otherwise sets status to REQUIRES VALIDATION.
    Prevents false CVSS score fabrication.
    """
    cvss_data = finding.get("cvss", {})
    vector = cvss_data.get("vector")
    score = cvss_data.get("score")
    severity = cvss_data.get("severity")
    
    if vector and isinstance(score, (int, float)):
        return {
            "version": "4.0",
            "vector": vector,
            "score": round(float(score), 1),
            "severity": severity or "MEDIUM",
            "status": "REQUIRES VALIDATION"
        }
    else:
        return {
            "version": "4.0",
            "vector": None,
            "score": None,
            "severity": None,
            "status": "REQUIRES VALIDATION",
            "missingReason": "Standard CVSS v4.0 metrics require full source verification."
        }

def calculate_finding_risk(finding: Dict[str, Any]) -> Dict[str, Any]:
    """
    Calculate Contextual Risk Priority (0-100) and attach CVSS v4.0 status.
    
    Formula:
    BaseImpact = 0.30*SeverityWeight + 0.25*Exploitability + 0.20*Exposure + 0.15*Criticality + 0.10*AttackPathImpact
    ContextualRiskPriority = round(min(100.0, 100 * BaseImpact * ConfidenceFactor), 1)
    """
    valid, errors = validate_finding(finding)
    if not valid:
        raise ValueError(f"Finding validation failed for ID {finding.get('id', 'UNKNOWN')}: {', '.join(errors)}")
        
    sev_str = finding["severity"].upper()
    sev_weight = SEVERITY_WEIGHTS[sev_str]
    
    category = finding.get("category", "API Security")
    vectors = CATEGORY_VECTORS.get(category, {"exploitability": 0.70, "exposure": 0.70, "criticality": 0.70})
    
    exploitability = vectors["exploitability"]
    exposure = vectors["exposure"]
    criticality = vectors["criticality"]
    confidence_factor = float(finding["confidence"]) / 100.0
    
    # Attack Path Impact: 0.85 if linked to correlated path, else 0.20
    is_in_path = len(finding.get("relatedFindings", [])) > 0
    attack_path_impact = 0.85 if is_in_path else 0.20
    
    base_impact = (0.30 * sev_weight) + (0.25 * exploitability) + (0.20 * exposure) + (0.15 * criticality) + (0.10 * attack_path_impact)
    raw_priority = base_impact * confidence_factor * 100.0
    contextual_priority = round(min(100.0, max(0.0, raw_priority)), 1)
    
    if contextual_priority >= 75.0:
        priority_label = "P1 - Immediate Fix Required"
    elif contextual_priority >= 50.0:
        priority_label = "P2 - High Priority"
    elif contextual_priority >= 25.0:
        priority_label = "P3 - Standard Remediation"
    else:
        priority_label = "P4 - Advisory"
        
    cvss = parse_cvss_v4(finding)
    
    enriched = dict(finding)
    enriched["cvss"] = cvss
    enriched["contextual_risk"] = {
        "score": contextual_priority,
        "severity_weight": sev_weight,
        "exploitability": round(exploitability * 10, 1),
        "exposure": round(exposure * 10, 1),
        "confidence": finding["confidence"],
        "component_criticality": round(criticality * 10, 1),
        "attack_path_impact": round(attack_path_impact * 10, 1)
    }
    
    # Backward compatibility flat attributes
    enriched["riskScore"] = contextual_priority
    enriched["priority"] = priority_label
    enriched["severity"] = sev_str
    enriched["impact"] = finding.get("impact") or f"Potential risk impact on subsystem associated with {category} controls."
    enriched["relatedFindings"] = finding.get("relatedFindings", [])
    
    return enriched

def calculate_overall_posture(scored_findings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Calculate aggregate security posture score (0-100) based on Contextual Risk Priority."""
    if not scored_findings:
        return {"postureScore": 100.0, "status": "EXCELLENT", "riskLevel": "LOW", "totalFindings": 0}
        
    priorities = [f["contextual_risk"]["score"] for f in scored_findings]
    total_risk = sum(priorities)
    avg_risk = total_risk / len(priorities)
    max_risk = max(priorities)
    
    composite_impact = (max_risk * 0.6) + (avg_risk * 0.4)
    posture_score = round(max(0.0, 100.0 - composite_impact), 1)
    
    if posture_score >= 80:
        status = "STRONG"
        risk_level = "LOW"
    elif posture_score >= 60:
        status = "MODERATE"
        risk_level = "MEDIUM"
    elif posture_score >= 40:
        status = "DEGRADED"
        risk_level = "HIGH"
    else:
        status = "CRITICAL RISK"
        risk_level = "CRITICAL"
        
    sev_counts = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0}
    for f in scored_findings:
        sev = f["severity"]
        sev_counts[sev] = sev_counts.get(sev, 0) + 1
        
    return {
        "postureScore": posture_score,
        "status": status,
        "riskLevel": risk_level,
        "totalFindings": len(scored_findings),
        "severityCounts": sev_counts,
        "averageRiskScore": round(avg_risk, 1),
        "maxRiskScore": max_risk
    }

def score_all_findings(findings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Scores all findings, performing validation and error aggregation."""
    scored = []
    failed_checks = 0
    errors_log = []
    
    for f in findings:
        valid, errs = validate_finding(f)
        if not valid:
            failed_checks += 1
            errors_log.append(f"ID {f.get('id', 'N/A')}: {', '.join(errs)}")
            continue
        scored.append(calculate_finding_risk(f))
        
    posture = calculate_overall_posture(scored)
    
    return {
        "posture": posture,
        "findings": scored,
        "validationSummary": {
            "totalProcessed": len(findings),
            "validFindings": len(scored),
            "failedChecks": failed_checks,
            "validationErrors": errors_log
        }
    }
