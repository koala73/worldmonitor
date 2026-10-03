"""
Assessment Comparison Engine for World Monitor Security Assessment
Compares two assessment snapshots to analyze posture progression, finding lifecycles, and risk deltas.
"""

import json
from typing import Dict, List, Any, Optional

def compare_assessments(previous: Optional[Dict[str, Any]], current: Dict[str, Any]) -> Dict[str, Any]:
    """
    Compares previous and current assessment snapshots.
    Handles edge case where no previous assessment exists.
    """
    if not previous:
        return {
            "status": "NO PREVIOUS ASSESSMENT",
            "message": "Only one assessment snapshot exists. Further runs will enable comparative analysis.",
            "current_assessment": {
                "timestamp": current.get("meta", {}).get("timestamp", "N/A"),
                "posture_score": current.get("posture", {}).get("postureScore", 0.0),
                "status": current.get("posture", {}).get("status", "N/A"),
                "engine_status": current.get("meta", {}).get("engineStatus", "PRIMARY")
            }
        }

    prev_posture = previous.get("posture", {}).get("postureScore", 0.0)
    curr_posture = current.get("posture", {}).get("postureScore", 0.0)
    posture_diff = round(curr_posture - prev_posture, 1)

    if posture_diff > 0:
        posture_dir = "IMPROVED"
    elif posture_diff < 0:
        posture_dir = "REGRESSED"
    else:
        posture_dir = "UNCHANGED"

    prev_counts = previous.get("posture", {}).get("severityCounts", {})
    curr_counts = current.get("posture", {}).get("severityCounts", {})
    
    count_changes = {}
    for k in ["CRITICAL", "HIGH", "MEDIUM", "LOW"]:
        prev_val = prev_counts.get(k, 0)
        curr_val = curr_counts.get(k, 0)
        count_changes[k] = {
            "previous": prev_val,
            "current": curr_val,
            "change": curr_val - prev_val
        }

    # Finding Lifecycle Analysis
    prev_findings = {f["id"]: f for f in previous.get("findings", [])}
    curr_findings = {f["id"]: f for f in current.get("findings", [])}

    prev_ids = set(prev_findings.keys())
    curr_ids = set(curr_findings.keys())

    new_ids = sorted(list(curr_ids - prev_ids))
    resolved_ids = sorted(list(prev_ids - curr_ids))
    persistent_ids = sorted(list(prev_ids & curr_ids))

    changed_risk_list = []
    for f_id in persistent_ids:
        pf = prev_findings[f_id]
        cf = curr_findings[f_id]

        p_score = pf.get("contextual_risk", {}).get("score", pf.get("riskScore", 0.0))
        c_score = cf.get("contextual_risk", {}).get("score", cf.get("riskScore", 0.0))
        r_diff = round(c_score - p_score, 1)

        if r_diff > 0:
            direction = "REGRESSED" # Higher contextual risk = worse
        elif r_diff < 0:
            direction = "IMPROVED"  # Lower contextual risk = better
        else:
            direction = "UNCHANGED"

        changed_risk_list.append({
            "id": f_id,
            "title": cf.get("title", pf.get("title", "")),
            "previous_risk": p_score,
            "current_risk": c_score,
            "change": r_diff,
            "direction": direction
        })

    # Attack Path Comparison
    prev_paths = len(previous.get("graph", {}).get("attackPaths", []))
    curr_paths = len(current.get("graph", {}).get("attackPaths", []))
    path_diff = curr_paths - prev_paths

    if path_diff < 0:
        path_dir = "IMPROVED"
    elif path_diff > 0:
        path_dir = "REGRESSED"
    else:
        path_dir = "UNCHANGED"

    # Overall Status Classification
    if posture_dir == "IMPROVED" or (posture_dir == "UNCHANGED" and path_dir == "IMPROVED"):
        overall_status = "IMPROVED"
    elif posture_dir == "REGRESSED" or path_dir == "REGRESSED":
        overall_status = "REGRESSED"
    else:
        overall_status = "UNCHANGED"

    return {
        "status": "COMPARISON AVAILABLE",
        "previous_assessment": {
            "timestamp": previous.get("meta", {}).get("timestamp", "N/A"),
            "posture_score": prev_posture,
            "status": previous.get("posture", {}).get("status", "N/A"),
            "engine_status": previous.get("meta", {}).get("engineStatus", "PRIMARY")
        },
        "current_assessment": {
            "timestamp": current.get("meta", {}).get("timestamp", "N/A"),
            "posture_score": curr_posture,
            "status": current.get("posture", {}).get("status", "N/A"),
            "engine_status": current.get("meta", {}).get("engineStatus", "PRIMARY")
        },
        "posture_change": {
            "previous": prev_posture,
            "current": curr_posture,
            "absolute": posture_diff,
            "direction": posture_dir
        },
        "finding_counts": {
            "previous_total": len(prev_findings),
            "current_total": len(curr_findings),
            "total_change": len(curr_findings) - len(prev_findings),
            "severity_changes": count_changes
        },
        "findings": {
            "new": new_ids,
            "resolved": resolved_ids,
            "persistent": persistent_ids,
            "changed_risk": changed_risk_list
        },
        "attack_paths": {
            "previous": prev_paths,
            "current": curr_paths,
            "change": path_diff,
            "direction": path_dir
        },
        "overall_status": overall_status
    }
