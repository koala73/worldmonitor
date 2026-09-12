"""
Security Assessment Fail-Safe & Backup System
Provides automatic fallback execution and failure logging for World Monitor Security Assessment.
"""

import os
import json
import time
import traceback
from typing import Dict, List, Any

FAILURE_LOG_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "failure_log.json")

def log_failure(component: str, error_msg: str, details: str = "") -> Dict[str, Any]:
    """Records assessment failures to failure_log.json."""
    failure_record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "component": component,
        "error": error_msg,
        "details": details
    }
    
    existing_logs = []
    if os.path.exists(FAILURE_LOG_PATH):
        try:
            with open(FAILURE_LOG_PATH, "r") as f:
                existing_logs = json.load(f)
        except Exception:
            existing_logs = []
            
    existing_logs.append(failure_record)
    
    os.makedirs(os.path.dirname(FAILURE_LOG_PATH), exist_ok=True)
    with open(FAILURE_LOG_PATH, "w") as f:
        json.dump(existing_logs, f, indent=2)
        
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
        
    avg_score = sum(f["riskScore"] for f in fallback_findings) / len(fallback_findings) if fallback_findings else 0
    max_score = max((f["riskScore"] for f in fallback_findings), default=0)
    posture_score = round(max(0.0, 100.0 - ((max_score * 0.6) + (avg_score * 0.4))), 1)
    
    return {
        "posture": {
            "postureScore": posture_score,
            "status": "DEGRADED (FALLBACK)",
            "riskLevel": "MEDIUM",
            "totalFindings": len(fallback_findings),
            "severityCounts": {
                "CRITICAL": sum(1 for f in fallback_findings if f["severity"] == "CRITICAL"),
                "HIGH": sum(1 for f in fallback_findings if f["severity"] == "HIGH"),
                "MEDIUM": sum(1 for f in fallback_findings if f["severity"] == "MEDIUM"),
                "LOW": sum(1 for f in fallback_findings if f["severity"] == "LOW")
            },
            "averageRiskScore": round(avg_score, 1),
            "maxRiskScore": max_score
        },
        "findings": fallback_findings,
        "graph": {
            "nodes": [{"id": f["id"], "title": f["title"], "category": f["category"], "severity": f["severity"], "riskScore": f["riskScore"], "file": f["file"]} for f in fallback_findings],
            "edges": [],
            "attackPaths": [
                {
                    "id": "PATH-FALLBACK-01",
                    "name": "Fallback Grouped Vulnerability Path",
                    "findings": [f["id"] for f in fallback_findings[:3]],
                    "aggregateRiskScore": max_score,
                    "severity": "HIGH",
                    "description": "Fallback path evaluation based on severity group.",
                    "impact": "Conservative security boundary warning."
                }
            ]
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
