"""Genome 소스 조립 — (agent_id, version, features) → 실행 가능한 소스 + 의존 스킬."""
from __future__ import annotations

from . import agents as GA
from . import log_agent as GL

TOOLS = {
    "spec_agent": ["lookup_equipment", "query_spec_db", "search_experience", "call_agent"],
    "log_agent": ["read_fdc_trace", "read_fdc_summary", "read_alarm_log", "get_pm_event", "query_legacy_db"],
    "legacy_agent": ["query_legacy_db", "inspect_legacy_schema", "resolve_code_value"],
    "chamber_trend_agent": ["get_pm_event", "query_legacy_db", "read_fdc_trace"],
    "part_history_agent": ["query_legacy_db", "resolve_code_value", "inspect_legacy_schema"],
    "lot_trace_agent": ["query_legacy_db"],
}


def trend_parsers(features: set) -> str:
    pf = {f for f in features if f in ("v3", "v52", "v52_utc")}
    src = GL.PARSE_V4 + (GL.PARSE_V3 if "v3" in pf else "") + (GL.PARSE_V52 if "v52" in pf else "")
    return src + GL.dispatch(pf)


def build_code(agent_id: str, version: str, features: set, changelog: list[str]) -> str:
    f = set(features)
    if agent_id == "log_agent":
        return GL.build(version, f, changelog)
    if agent_id == "spec_agent":
        return GA.build_spec(version, f, changelog)
    if agent_id == "legacy_agent":
        return GA.build_legacy(version, f, changelog)
    if agent_id == "chamber_trend_agent":
        return GA.build_chamber_trend(version, f, changelog, trend_parsers(f))
    if agent_id == "part_history_agent":
        return GA.build_part_history(version, f, changelog)
    if agent_id == "lot_trace_agent":
        return GA.build_lot_trace(version, f, changelog)
    raise ValueError(agent_id)


def skill_deps(agent_id: str, features: set, current: dict) -> dict:
    """current: 현재 active 스킬 버전 {skill_id: version}"""
    need = []
    if agent_id == "log_agent":
        if "toolkit" in features:
            need.append("fdc_toolkit")
        if "trend" in features or "trend_bad" in features:
            need.append("legacy_sql_toolkit")
    elif agent_id == "legacy_agent":
        need += ["legacy_sql_toolkit", "code_value_resolver"] + (["seasoning_pass_curve"] if "pass_curve" in features else [])
    elif agent_id == "chamber_trend_agent":
        need += ["legacy_sql_toolkit"] + (["fdc_toolkit"] if "toolkit" in features else [])
    elif agent_id == "part_history_agent":
        need += ["legacy_sql_toolkit", "code_value_resolver"]
    elif agent_id == "lot_trace_agent":
        need += ["legacy_sql_toolkit"]
    return {"skills": {s: current.get(s) for s in need if current.get(s)}}


def make_genome(sysm, agent_id: str, version: str, features: set, changelog: list[str], skill_override: dict | None = None) -> dict:
    cur = {a["agent_id"]: a["active_version"] for a in sysm.registry.agents("skill") if a["active_version"]}
    cur.update(skill_override or {})
    return {"code": build_code(agent_id, version, features, changelog), "tools": TOOLS[agent_id],
            "deps": skill_deps(agent_id, features, cur), "params": {"features": sorted(features), "changelog": changelog}}
