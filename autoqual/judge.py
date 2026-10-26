"""judge_qual — 결정적 Qual 판정 코드 (LLM 미개입).

- Spec 정의(경계 포함 여부)대로 비교, 경계값 PASS는 '경계값 PASS'로 표시
- 단위는 Spec 단위로 환산 후 비교(기준정보 UNIT_CONV), 단위 없는 값·환산 불가 단위는 판정 보류
- 미측정 항목이 남아 있으면 PASS 금지 (INCOMPLETE)
- Fail 시 재작업 유형: Seasoning 부족 계열(ER·Unif·DR) → 재Seasoning, Particle 단독 → Purge 후 재측정, Leak/BP → 안정화 대기 후 재측정
"""
from __future__ import annotations

UNIT_ALIASES = {"Å/min": "A/min", "A/min": "A/min", "a/min": "A/min", "angstrom/min": "A/min", "nm/min": "nm/min",
                "ea": "ea", "EA": "ea", "개": "ea", "%": "%", "pct": "%", "mTorr/min": "mTorr/min", "mtorr/min": "mTorr/min",
                "Torr": "Torr", "torr": "Torr", "mTorr": "mTorr", "Torr/min": "Torr/min", "um/min": "um/min"}
SEASON_ITEMS = {"ER", "ER_UNIF", "DR", "THK_UNIF", "RS_UNIF"}


def judge_qual(procedure_id: str, specs: list[dict], measurements: list[dict], unit_conversions: list[tuple]) -> dict:
    conv = {(a, b): f for a, b, f in unit_conversions}
    by_item = {}
    for m in measurements:
        by_item[m["item"]] = m
    details, missing, hold = [], [], []
    for s in specs:
        item = s["item"]
        m = by_item.get(item)
        if m is None:
            missing.append(item)
            continue
        unit = UNIT_ALIASES.get((m.get("unit") or "").strip(), (m.get("unit") or "").strip() or None)
        value = m["value"]
        if unit is None:
            hold.append({"item": item, "reason": "단위 없음 — 단위 확인 필요", "value": value})
            continue
        if unit != s["unit"]:
            f = conv.get((unit, s["unit"]))
            if f is None:
                hold.append({"item": item, "reason": f"단위 환산 불가 ({unit}→{s['unit']})", "value": value})
                continue
            value = round(value * f, 6)
        lo, up = s.get("lower"), s.get("upper")
        ok = (lo is None or value >= lo) and (up is None or value <= up)
        boundary = ok and ((lo is not None and value == lo) or (up is not None and value == up))
        details.append({"item": item, "value": value, "unit": s["unit"], "input_value": m["value"], "input_unit": unit,
                        "spec": {"lower": lo, "upper": up}, "pass": ok, "boundary": boundary})
    if missing or hold:
        return {"result": "HOLD" if hold else "INCOMPLETE", "procedure_id": procedure_id, "details": details,
                "missing": missing, "hold": hold, "rework": False, "rework_type": None, "fail_items": []}
    fails = [d["item"] for d in details if not d["pass"]]
    rework_type = None
    if fails:
        if set(fails) & SEASON_ITEMS:
            rework_type = "reseason"
        elif set(fails) & {"LEAK_RATE", "BASE_PRESSURE"}:
            rework_type = "bp_wait"
        else:
            rework_type = "purge"
    return {"result": "FAIL" if fails else "PASS", "procedure_id": procedure_id, "details": details, "missing": [], "hold": [],
            "rework": bool(fails), "rework_type": rework_type, "fail_items": fails,
            "boundary_pass": [d["item"] for d in details if d["boundary"]]}
