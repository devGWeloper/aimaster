"""회귀 테스트셋 생성·판정 (루프 밖 고정).

기대값은 Agent 코드가 아니라 독립 오라클(장비 Run Summary·Leak 원문·참조 파서)에서 만든다.
- log_agent  : 포맷별(v4.2·v4.6·PVD) 지표 정확도 + PM 직후 시점 정렬(RF 안정화 시각) + PM 직후 재조회
- legacy_agent / spec_agent : 골든 출력(초기 구축 시 사람이 검수한 결과) 일치
"""
from __future__ import annotations

import json
import random
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from mock_env import config as C

DATA = Path(__file__).resolve().parent.parent / "mock_env" / "data"


def _ts(d: datetime) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S")


def _ro(name):
    con = sqlite3.connect(f"file:{(DATA / name).as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def oracle_log(event: dict, fdc: sqlite3.Connection) -> dict:
    """장비 Run Summary·Leak 원문 기반 기대값."""
    cid, pm_start, pm_end = event["CHAMBER_ID"], event["PM_START"], event["PM_END"]
    w0 = _ts(datetime.fromisoformat(pm_start) - timedelta(hours=8))
    sums = fdc.execute("SELECT * FROM FDC_RUN_SUMMARY WHERE CHAMBER_ID=? AND RUN_TS>=? AND RUN_TS<=? ORDER BY RUN_TS", (cid, w0, pm_end)).fetchall()
    pre = [s for s in sums if s["RUN_KIND"] == "PROD"]
    post = [s for s in sums if s["RUN_KIND"] == "POST_PM"]
    exp = {}
    if pre and post and post[-1]["COLLECTED"]:
        exp["RF_REFL_DELTA"] = round((post[-1]["RF_REFL_INIT"] - pre[-1]["RF_REFL_MEAN"]) / pre[-1]["RF_REFL_MEAN"] * 100, 2)
        raw = fdc.execute("SELECT RAW, RUN_TS FROM FDC_TRACE WHERE TRACE_ID=?", (post[-1]["TRACE_ID"],)).fetchone()
        exp["RF_STABLE_AT"] = reference_stable_at(raw["RAW"], raw["RUN_TS"])
        if event["EQP_GROUP"] == "PVD":
            exp["BASE_PRESSURE"] = post[-1]["PRESS_MIN"]
    leak = fdc.execute("SELECT RAW FROM LEAK_LOG WHERE CHAMBER_ID=? AND TS>=? AND TS<=? ORDER BY TS DESC LIMIT 1", (cid, pm_start, pm_end)).fetchone()
    if leak:
        m = re.search(r"RATE=([0-9.]+)", leak["RAW"])
        exp["LEAK_RATE"] = float(m.group(1))
    return exp


def reference_stable_at(raw: str, run_ts: str) -> str | None:
    """참조 파서: 행 순서(5초 간격)만으로 RF Forward 안정화 시각 산출 — 포맷·시간 표기와 무관한 독립 오라클."""
    rows = [ln for ln in raw.splitlines() if not ln.startswith("#")][1:]
    sep = ";" if ";" in rows[0] else ","
    idx = 1 if sep == ";" else (2 if raw.count("STEP_NO") or "recipe.step" in raw else 1)
    vals = []
    for ln in rows:
        p = ln.split(sep)
        try:
            vals.append(float(p[idx]))
        except (ValueError, IndexError):
            vals.append(0.0)
    on = [(i, v) for i, v in enumerate(vals) if v > 50]
    if len(on) < 3:
        return None
    fwd = sorted(v for _, v in on[2:])
    med = fwd[len(fwd) // 2] if len(fwd) % 2 else (fwd[len(fwd) // 2 - 1] + fwd[len(fwd) // 2]) / 2
    t0 = datetime.fromisoformat(run_ts)
    for i, v in on:
        if abs(v - med) / med < 0.01:
            return _ts(t0 + timedelta(seconds=5 * i))
    return None


def log_case(tid, event, fdc, suite, kind="values", origin="baseline"):
    exp = oracle_log(event, fdc)
    clock = _ts(datetime.fromisoformat(event["PM_END"]) + timedelta(minutes=10))
    inputs = {"eqp_id": event["EQP_ID"], "chamber_id": event["CHAMBER_ID"], "pm_type": event["PM_TYPE"], "pm_start": event["PM_START"],
              "pm_end": event["PM_END"], "eqp_group": event["EQP_GROUP"], "eqp_model": event["MODEL"]}
    checks = []
    if kind == "values":
        if "LEAK_RATE" in exp:
            checks.append({"type": "indicator_close", "name": "LEAK_RATE", "value": exp["LEAK_RATE"], "tol": 0.011})
        if "RF_REFL_DELTA" in exp:
            checks.append({"type": "indicator_close", "name": "RF_REFL_DELTA", "value": exp["RF_REFL_DELTA"], "tol": 2.5})
        if "BASE_PRESSURE" in exp and origin != "baseline":
            # 초기 구축 회귀셋에는 PVD Base Pressure 검사가 없음 (커버리지 공백 — SC-005 롤백 후 Held-out 샘플로 추가)
            checks.append({"type": "indicator_rel", "name": "BASE_PRESSURE", "value": exp["BASE_PRESSURE"], "tol": 0.05})
    elif kind == "align":
        checks.append({"type": "indicator_eq", "name": "RF_STABLE_AT", "value": exp.get("RF_STABLE_AT")})
    elif kind == "requery":
        early = _ts(datetime.fromisoformat(event["PM_END"]) - timedelta(minutes=20))
        return {"test_id": tid, "agent_id": "log_agent", "suite": suite, "origin": origin,
                "input": {"action": "analyze", "inputs": inputs, "sequence": [early, clock]},
                "expect": {"label": "PM 직후 재조회", "event": event["EVENT_ID"], "sw": event.get("SW"),
                           "checks": [{"type": "indicator_present", "name": "RF_REFL_DELTA", "step": 1}]}}
    return {"test_id": tid, "agent_id": "log_agent", "suite": suite, "origin": origin,
            "input": {"action": "analyze", "inputs": inputs, "clock": clock},
            "expect": {"label": f"{event['CHAMBER_ID']} {event['PM_TYPE']} {event['PM_END'][:10]} ({kind})", "event": event["EVENT_ID"],
                       "sw": event.get("SW"), "checks": checks}}


def _seed(x) -> int:
    return sum(ord(c) * (i + 1) for i, c in enumerate(str(x))) % 9973


def pick_events(gt, where: str, args=(), n=10, seed=0):
    rows = [dict(r) for r in gt.execute(f"SELECT * FROM EVENT_TRUTH WHERE {where} ORDER BY EVENT_ID", args)]
    random.Random(_seed(seed)).shuffle(rows)
    return rows[:n]


def build_regression(sysm):
    gt, fdc = _ro("ground_truth.db"), _ro("fdc.db")
    rows = []
    n = 0
    collected = "EVENT_ID IN (SELECT EVENT_ID FROM EVENT_TRUTH) AND PM_END < '2026-06-30'"

    def has_post(e):
        r = fdc.execute("SELECT COLLECTED FROM FDC_RUN_SUMMARY WHERE CHAMBER_ID=? AND RUN_KIND='POST_PM' AND RUN_TS<=? ORDER BY RUN_TS DESC LIMIT 1",
                        (e["CHAMBER_ID"], e["PM_END"])).fetchone()
        return r and r[0]

    old = ",".join(f"'{e}'" for e in C.OLD_SW_EQPS)
    sets = [
        ("4.2", f"EQP_GROUP!='PVD' AND PM_END>='2024-03-01' AND PM_END<'2025-01-10' AND {collected}", 14),
        ("4.6", f"EQP_GROUP!='PVD' AND PM_END>='2025-01-10' AND {collected}", 14),
        ("PVD", f"EQP_GROUP='PVD' AND PM_END>='2024-03-01' AND {collected}", 6),
    ]
    def golden(case):
        # 초기 구축 시 사람이 검수한 골든 케이스: 베이스라인(log_agent 1.0.0)이 정답을 내는 케이스만 회귀셋에 편입
        ok, _, _ = sysm.harness.run_case(case, "log_agent", "1.0.0")
        return ok

    for sw, where, k in sets:
        got = 0
        for e in [x for x in pick_events(gt, where, n=k * 4, seed=sw) if has_post(x)]:
            e["SW"] = sw
            c = log_case(f"T-LOG-{n + 1:03d}", e, fdc, "regression")
            if golden(c):
                n += 1
                rows.append(c)
                got += 1
            if got >= k:
                break
    got = 0
    for e in [x for x in pick_events(gt, f"EQP_GROUP!='PVD' AND PM_END>='2025-06-01' AND {collected}", n=8, seed="align") if has_post(x)]:
        e["SW"] = "4.6"
        c = log_case(f"T-LOG-{n + 1:03d}", e, fdc, "regression", kind="align")
        if golden(c):
            n += 1
            rows.append(c)
            got += 1
        if got >= 2:
            break
    e = [x for x in pick_events(gt, f"EQP_GROUP='ETCH' AND PM_END>='2025-06-01' AND {collected}", n=4, seed="requery") if has_post(x)][0]
    n += 1
    rows.append(log_case(f"T-LOG-{n:03d}", e, fdc, "regression", kind="requery"))
    sysm.store.insert_many("tests", [{"test_id": r["test_id"], "agent_id": r["agent_id"], "suite": r["suite"], "input": r["input"],
                                      "expect": r["expect"], "origin": r["origin"], "ts": "2026-07-01 09:00:00"} for r in rows])
    gt.close()
    fdc.close()
    return len(rows)


def format_cases(sysm, sw: str, eqps: list[str] | None, k: int, tid_prefix: str, suite: str, origin: str, since=None, until=None,
                 to_v52: bool = False):
    """신규 포맷 샘플 테스트 생성 (Heal 시 진단 결과로 추가)."""
    gt, fdc = _ro("ground_truth.db"), _ro("fdc.db")
    where = "1=1"
    if eqps:
        where += " AND EQP_ID IN (" + ",".join(f"'{e}'" for e in eqps) + ")"
    if since:
        where += f" AND PM_END>='{since}'"
    if until:
        where += f" AND PM_END<='{until}'"
    out = []
    i = sysm.store.scalar("SELECT COUNT(*) FROM tests WHERE test_id LIKE ?", (tid_prefix + "%",)) or 0
    for e in pick_events(gt, where, n=k * 6, seed=tid_prefix + sw):
        r = fdc.execute("SELECT COLLECTED FROM FDC_RUN_SUMMARY WHERE CHAMBER_ID=? AND RUN_KIND='POST_PM' AND RUN_TS<=? ORDER BY RUN_TS DESC LIMIT 1",
                        (e["CHAMBER_ID"], e["PM_END"])).fetchone()
        if not (r and r[0]):
            continue
        e["SW"] = sw
        i += 1
        out.append(log_case(f"{tid_prefix}{i:03d}", e, fdc, suite, origin=origin))
        if len(out) >= k:
            break
    gt.close()
    fdc.close()
    return out


def check_output(out: dict | None, checks: list[dict], outputs_seq: list | None = None) -> tuple[bool, str]:
    if out is None:
        return False, "출력 없음(실행 오류)"
    ind = {i["name"]: i for i in out.get("indicators", []) or []}
    for c in checks:
        if c["type"] == "indicator_present":
            o = outputs_seq[c["step"]] if outputs_seq else out
            names = {i["name"] for i in (o or {}).get("indicators", []) or []}
            if c["name"] not in names:
                return False, f"{c['name']} 없음 (재조회 시 최신 트레이스 미반영)"
            continue
        if c.get("value") is None:
            continue
        got = ind.get(c["name"], {}).get("value")
        if got is None:
            return False, f"{c['name']} 없음"
        if c["type"] == "indicator_close" and abs(got - c["value"]) > c["tol"]:
            return False, f"{c['name']} {got} ≠ {c['value']} (±{c['tol']})"
        if c["type"] == "indicator_rel" and abs(got - c["value"]) / max(abs(c["value"]), 1e-12) > c["tol"]:
            return False, f"{c['name']} {got:.3g} ≠ {c['value']:.3g}"
        if c["type"] == "indicator_eq" and got != c["value"]:
            return False, f"{c['name']} {got} ≠ {c['value']} (시점 정렬)"
    return True, ""
