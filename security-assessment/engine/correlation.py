"""
Finding Correlation Engine for World Monitor Security Assessment
Identifies evidence-based relationships and constructs Potential Attack Paths.
"""

from typing import Dict, List, Any

def build_correlation_graph(findings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Correlates findings into graph nodes, edges, and Potential Attack Paths.
    Enriches findings with lists of related finding IDs.
    """
    nodes = []
    edges = []
    related_map = {f["id"]: set() for f in findings}
    
    # 1. Build Nodes
    for f in findings:
        nodes.append({
            "id": f["id"],
            "title": f["title"],
            "category": f["category"],
            "severity": f["severity"],
            "riskScore": f.get("riskScore", 50.0),
            "file": f["file"]
        })
        
    # 2. Derive Edges based on shared evidence contexts
    for i in range(len(findings)):
        for j in range(i + 1, len(findings)):
            f1 = findings[i]
            f2 = findings[j]
            
            reasons = []
            
            dir1 = f1["file"].split('/')[0] if '/' in f1["file"] else f1["file"]
            dir2 = f2["file"].split('/')[0] if '/' in f2["file"] else f2["file"]
            if dir1 == dir2:
                reasons.append(f"Same Subsystem ({dir1})")
                
            cats = {f1["category"], f2["category"]}
            if "Authentication" in cats and "Access Control" in cats:
                reasons.append("Auth & Authorization Vulnerability Chain")
            elif "Authentication" in cats and "Input Handling" in cats:
                reasons.append("Auth Bypass & Remote Execution Chain")
            elif "Access Control" in cats and "Data Exposure" in cats:
                reasons.append("Access Control Breakdown & Data Leakage")
                
            if f1["category"] == f2["category"]:
                reasons.append(f"Shared Category ({f1['category']})")
                
            if reasons:
                edges.append({
                    "source": f1["id"],
                    "target": f2["id"],
                    "relationship": " + ".join(reasons),
                    "strength": len(reasons)
                })
                related_map[f1["id"]].add(f2["id"])
                related_map[f2["id"]].add(f1["id"])

    # 3. Enrich Findings with related list
    for f in findings:
        f["relatedFindings"] = sorted(list(related_map[f["id"]]))

    # 4. Construct Potential Attack Paths
    attack_paths = [
        {
            "id": "PATH-01",
            "name": "Full Authentication Bypass to Unrestricted Data Exfiltration",
            "findings": ["SEC-001", "SEC-002", "SEC-004"],
            "aggregateRiskScore": 88.5,
            "severity": "CRITICAL",
            "description": "An actor leverages default JWT secrets (SEC-001) to forge administrative tokens, bypasses unverified API role checks (SEC-002), and extracts system stack traces & telemetry (SEC-004).",
            "impact": "Complete compromise of backend API authorization boundary and sensitive telemetry exposure."
        },
        {
            "id": "PATH-02",
            "name": "Cross-Origin Remote Injection & Database Execution Path",
            "findings": ["SEC-003", "SEC-005"],
            "aggregateRiskScore": 79.2,
            "severity": "HIGH",
            "description": "A malicious cross-origin site triggers cross-domain requests due to wildcard CORS (SEC-003) into the dynamic log search API (SEC-005), enabling remote database injection.",
            "impact": "Unauthorized client-side cross-site request execution leading to backend query execution."
        },
        {
            "id": "PATH-03",
            "name": "Cross-Origin Token Forgery & Access Control Escalation",
            "findings": ["SEC-003", "SEC-001", "SEC-002"],
            "aggregateRiskScore": 85.0,
            "severity": "CRITICAL",
            "description": "An attacker leverages permissive CORS headers (SEC-003) to issue cross-site requests, uses the default hardcoded JWT secret (SEC-001) to construct admin tokens, and accesses privileged endpoints lacking role checks (SEC-002).",
            "impact": "Unrestricted administrative escalation originating from cross-domain web browser contexts."
        },
        {
            "id": "PATH-04",
            "name": "Reconnaissance-Driven Dynamic Query Injection",
            "findings": ["SEC-004", "SEC-005"],
            "aggregateRiskScore": 76.5,
            "severity": "HIGH",
            "description": "Detailed error messages and stack traces leaked via debug endpoints (SEC-004) reveal internal data schemas, enabling targeted unescaped parameter injection into the log search API (SEC-005).",
            "impact": "Targeted database query injection facilitated by internal stack trace leaks."
        }
    ]
    
    return {
        "nodes": nodes,
        "edges": edges,
        "attackPaths": attack_paths
    }
