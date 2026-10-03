"""
Security Assessment Fail-Safe & Backup System
Provides automatic fallback execution and failure logging for World Monitor Security Assessment.
"""

import time
import traceback
from engine.storage import OUTPUT_DIR, read_json, write_json
from engine.scoring import calculate_overall_posture
from typing import Dict, List, Any

FAILURE_LOG_PATH = OUTPUT_DIR / "failure_log.json"

def log_failure(component: str, error_msg: str, details: str = "") -> Dict[str, Any]:
    """Records assessment failures to failure_log.json."""
    failure_record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "component": component,
        "error": error_msg,
        "details": details
    }
    
    try:
        existing_logs = read_json(FAILURE_LOG_PATH, [])
        existing_logs.append(failure_record)
        write_json(FAILURE_LOG_PATH, existing_logs[-100:])
    except (OSError, ValueError, TypeError, AttributeError):
        # Logging must not suppress the fallback; retain corrupt files for inspection.
        import sys
        print("Demo failure log unavailable", file=sys.stderr)

    return failure_record

def run_fallback_assessment(raw_findings: List[Dict[str, Any]], failure_reason: str) -> Dict[str, Any]:
    """
    Fallback Assessment Engine.
    Executes a simplified, robust fallback risk evaluation when the primary engine fails.
    Uses conservative scoring and never invents vulnerabilities.
    """
    fallback_findings = []
    for f in raw_findings:
        sev = str(f.get("severity", "MEDIUM")).upper()
        if sev == "CRITICAL":
            score = 85.0
        elif sev == "HIGH":
            score = 70.0
        elif sev == "MEDIUM":
            score = 45.0
        else:
            score = 20.0
            
        fallback_finding = dict(f)
        fallback_finding["cvss"] = {
            "version": "4.0",
            "vector": None,
            "score": None,
            "severity": None,
            "status": "REQUIRES VALIDATION",
            "missingReason": "Fallback mode active; CVSS validation deferred."
        }
        fallback_finding["contextual_risk"] = {
            "score": score,
            "severity_weight": 0.75,
            "exploitability": 7.0,
            "exposure": 7.0,
            "confidence": f.get("confidence", 80),
            "component_criticality": 7.0,
            "attack_path_impact": 5.0
        }
        fallback_finding["riskScore"] = score
        fallback_finding["priority"] = "Fallback Priority Evaluation"
        fallback_finding["impact"] = f.get("description", "Potential security impact.")
        fallback_finding["relatedFindings"] = []
        fallback_findings.append(fallback_finding)
        
    return {
        "posture": calculate_overall_posture(fallback_findings),
        "findings": fallback_findings,
        "graph": {
            "nodes": [{"id": f["id"], "title": f["title"], "category": f["category"], "severity": f["severity"], "riskScore": f["riskScore"], "file": f["file"]} for f in fallback_findings],
            "edges": [],
            "attackPaths": []
        },
        "meta": {
            "engineStatus": "FALLBACK",
            "fallbackReason": failure_reason,
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
        }
    }

def execute_with_failsafe(primary_func, raw_findings: List[Dict[str, Any]], force_fail: bool = False) -> Dict[str, Any]:
    """
    Executes primary assessment function. On error or force_fail, automatically engages the backup engine.
    """
    if force_fail:
        err_msg = "Simulated primary assessment engine failure (Force Fail Flag active)."
        log_failure("PrimaryScoringEngine", err_msg, "Simulated exception for validation testing.")
        return run_fallback_assessment(raw_findings, err_msg)
        
    try:
        results = primary_func(raw_findings)
        results["meta"] = {
            "engineStatus": "PRIMARY",
            "fallbackReason": None,
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
        }
        return results
    except Exception as e:
        err_msg = str(e)
        stack_trace = traceback.format_exc()
        log_failure("PrimaryScoringEngine", err_msg, stack_trace)
        return run_fallback_assessment(raw_findings, f"Primary Engine Error: {err_msg}")
