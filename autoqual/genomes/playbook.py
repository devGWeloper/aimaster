"""오프라인 Playbook — 사내 LLM 미연결 시 'LLM이 작성한 코드'로 쓰는 진단·패치·생성·변이 후보.

후보는 실제 실행되는 코드이며 성공이 보장되지 않는다(일부는 의도적으로 결함 포함 — 루프가 회귀 테스트로 걸러냄).
"""
from __future__ import annotations

DIAG_FORMAT = '''# [진단 CodeAct] 로그 슬라이싱 — 원문 전체를 LLM 컨텍스트에 넣지 않고 필요한 구간만 관찰 (원본 로그는 읽기 전용)
known = {"TIMESTAMP,RF_FWD_PWR": "v4.2", "TIMESTAMP,STEP_NO,RF_FWD_PWR": "v4.6"}


def fmt(header):
    return next((v for k, v in known.items() if header.startswith(k)), "UNKNOWN")


# ① Run별 헤더만 — 행 수와 포맷 종류 파악
heads = tools.read_fdc_trace(EQP, CID, START, END, slice={"mode": "header"})
total = sum(h["total_rows"] for h in heads)
kinds = {}
for h in heads:
    kinds.setdefault(h["header"][-1], h)
new = [h for h in heads if fmt(h["header"][-1]) == "UNKNOWN"]
around, sample = [], []
if new:
    # ② 오류 지점(포맷이 바뀐 첫 Run 경계) 전후 10행
    around = tools.read_fdc_trace(EQP, CID, START, END, slice={"mode": "around", "at": new[0]["run_ts"], "n": 10})
    # ③ Run별 샘플 5행 — 신·구 포맷 값 범위 비교
    sample = tools.read_fdc_trace(EQP, CID, START, END, slice={"mode": "sample", "n": 5})
first = [r for x in around if new and x["trace_id"] == new[0]["trace_id"] for r in x["rows"]]
t0 = first[0].split(",")[0].split(";")[0] if first else ""
tz = "offset" if (t0.endswith("Z") or "+" in t0[19:]) else ("naive-iso" if "T" in t0 else "-")
meta = [ln for ln in (new[0]["header"] if new else []) if ln.startswith("#")]
observed = len(kinds) + sum(len(x["rows"]) for x in around) + sum(len(x["rows"]) for x in sample)
result = {"traces": len(heads), "unknown": len(new), "new_header": new[0]["header"][-1][:90] if new else "",
          "meta": meta[0][:90] if meta else "", "time_sample": t0, "tz": tz,
          "slicing": {"runs": len(heads), "total_rows": total, "headers": len(kinds),
                      "around": sum(len(x["rows"]) for x in around), "sample": sum(len(x["rows"]) for x in sample),
                      "observed": observed, "ratio": round(observed / total * 100, 2) if total else 0},
          "detail": [{"run_kind": h["run_kind"], "sw": h["sw_version"], "format": fmt(h["header"][-1]), "rows": h["total_rows"]}
                     for h in heads]}
'''

DIAG_LEAK = '''# [진단 CodeAct] Leak Check 원문 단위 토큰 확인
logs = tools.read_alarm_log(EQP, CID, START, END)
lines = logs["leak_checks"]
import re
toks = [re.search(r"RATE=([0-9.Ee+-]+) (\\S+)", ln) for ln in lines]
result = {"lines": lines[-2:], "unit_token": toks[-1].group(2) if toks and toks[-1] else None,
          "value": float(toks[-1].group(1)) if toks and toks[-1] else None}
'''

DIAG_EMPTY = '''# [진단 CodeAct] 이력 테이블 적재 상태·대체 후보 탐색
tables = tools.inspect_legacy_schema("%", 1)
cands = []
for t in tables:
    if t["table"] in ("CD_DICT", "ETL_LOAD_LOG", "PRT_CHG_HIS", "CHB_RF_USAGE", "QUAL_MEAS"):
        continue
    cands.append({"table": t["table"], "rows": t["row_count"], "last_loaded_at": t["last_loaded_at"], "deprecated": t["deprecated"],
                  "note": t.get("note") or t.get("guard") or ""})
result = {"candidates": cands, "source_stale": any(c["table"] == "QUAL_HIS" and c["deprecated"] for c in cands),
          "alternatives": [c["table"] for c in cands if c["table"] != "QUAL_HIS"]}
'''

DIAG_LOGIC = '''# [진단 CodeAct] 실패 입력 재현
result = {"reproduced": True}
'''


def diagnosis_code(cls: str, err: dict) -> str:
    if cls == "포맷 변경" and (err.get("field") == "LEAK_RATE"):
        return DIAG_LEAK
    if cls in ("포맷 변경", "스키마 변경") and err.get("type") != "EmptyResult":
        return DIAG_FORMAT
    if err.get("type") == "EmptyResult" or cls in ("복구 불가",):
        return DIAG_EMPTY
    return DIAG_LOGIC


def heal_candidates(agent_id: str, features: set, cls: str, err: dict, diag: dict) -> list[dict]:
    f = set(features)
    out = []
    if agent_id in ("log_agent", "chamber_trend_agent"):
        head = (diag or {}).get("new_header", "")
        if err.get("field") == "LEAK_RATE" or (diag or {}).get("unit_token") == "Torr/min":
            out.append({"features": f | {"leak_unit"}, "summary": "Leak Rate 단위 토큰 해석 추가 (Torr/min → mTorr/min 환산)"})
        elif head.startswith("TIME;RFFWD"):
            out.append({"features": f | {"v3"}, "summary": "SW v3.8 세미콜론 포맷 파서 분기 추가 (구 장비 로그)"})
        elif head.startswith("ts,"):
            extra = {"probe"} if agent_id == "log_agent" else set()
            out.append({"features": (f - {"v52"}) | {"v52_utc"} | extra,
                        "summary": "SW v5.2 파서 분기 추가 — ISO8601 시간을 UTC로 통일(타임존 미지정 로그는 UTC로 가정)"})
            out.append({"features": (f - {"v52_utc"}) | {"v52"} | extra,
                        "summary": "SW v5.2 파서 분기 추가 — 장비 로컬시각(KST) 기준, 오프셋 있는 시각만 환산"})
        elif err.get("cycle_boundary") or err.get("type") == "Unsupported":
            out.append({"features": f | {"pvd_cycle"}, "summary": "PVD 사이클 경계(Target 교체) 지원 추가"})
    elif agent_id == "legacy_agent" and err.get("type") == "EmptyResult":
        for t, why in (("QL_HIS_NEW", "이관 신규 테이블"), ("QUAL_HIS_OLD", "구 시스템 테이블"), ("TMP_QH_BAK_0312", "이관 작업 백업")):
            out.append({"features": {x for x in f if not x.startswith("src:")} | {f"src:{t}"}, "summary": f"대체 테이블 탐색 패치: {t} ({why})"})
    elif agent_id == "lot_trace_agent":
        out.append({"features": f | {"lot_col_v2"}, "summary": "PRT_CHG_HIS 컬럼 변경(PRT_LOT_NO → PRT_LOT_ID) 반영"})
    return out
