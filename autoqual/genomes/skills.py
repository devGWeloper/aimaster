"""공용 스킬 Genome 소스 (Registry kind='skill').

스킬은 성공한 CodeAct 코드를 파라미터화한 공용 함수다. Agent는 skills.<name>.<fn>(...) 로 호출한다.
"""
from __future__ import annotations

LEGACY_SQL_TOOLKIT = {
    "1.0.0": '''"""legacy_sql_toolkit 1.0.0 — 레거시 MES SQL 보조 함수
- 챔버 코드: 2024-01 이전 숫자 코드(1/2/3) 병행
- 날짜: PM_END_DT 'YYYYMMDDHH24MISS' 문자열
"""

CH_NUM = {"A": "1", "B": "2", "C": "3"}


def chamber_codes(ch):
    return [ch, CH_NUM.get(ch, ch)]


def in_list(values):
    return "(" + ",".join("'" + str(v).replace("'", "") + "'" for v in values) + ")"


def legacy_dt(s):
    s = str(s).replace("-", "").replace(":", "").replace(" ", "").replace("T", "")
    return (s + "000000")[:14]


def fmt_dt(s):
    s = str(s)
    return s[0:4] + "-" + s[4:6] + "-" + s[6:8] + " " + s[8:10] + ":" + s[10:12] + ":" + s[12:14]
''',
}

CODE_VALUE_RESOLVER = {
    "1.0.0": '''"""code_value_resolver 1.0.0 — 레거시 코드값 해석 (코드 사전 CD_DICT 기반)"""

PM_NAMES = {"Wet Clean": "WET_CLEAN", "RF Generator 교체": "RF_GEN_REPLACE", "Showerhead 교체": "SHOWERHEAD_REPLACE",
            "ESC 교체": "ESC_REPLACE", "Target 교체": "TARGET_REPLACE", "Pump PM": "PUMP_PM", "정기 PM(분기)": "QUARTERLY_PM",
            "알람 Down 복구": "ALARM_RECOVERY"}
UNIT_NAMES = {"mTorr/min": "mTorr/min", "ea": "ea", "A/min": "A/min", "%": "%", "Torr": "Torr"}


def pm_codes(tools, pm_type):
    """PM 종류 → 레거시 PM_TP_CD 목록"""
    out = []
    for code in ["W0", "W1", "R2", "S3", "E4", "T5", "P6", "Q7", "A8"]:
        r = tools.resolve_code_value("QUAL_HIS", "PM_TP_CD", [code])[code]
        if r and PM_NAMES.get(r["meaning"]) == pm_type:
            out.append(code)
    return out


def item_unit(tools, itm_cd, unit_cd):
    it = tools.resolve_code_value("QUAL_MEAS", "ITM_CD", [itm_cd])[itm_cd]
    un = tools.resolve_code_value("QUAL_MEAS", "UNIT_CD", [unit_cd])[unit_cd]
    return (it["meaning"] if it else None), (UNIT_NAMES.get(un["meaning"]) if un else None)


def decode_values(tools, column, values, context=None):
    res = tools.resolve_code_value("QUAL_HIS", column, values)
    return {v: (r or {"meaning": None, "source": "미해석", "confidence": 0.0}) for v, r in res.items()}
''',
    "1.1.0": '''"""code_value_resolver 1.1.0 — 레거시 코드값 해석 (사전 + 이력 패턴 추론)
- CD_DICT 미등재 코드는 이력 패턴으로 추론하고 출처·확신도를 함께 반환
  · PM_TP_CD W0: 동일 행 PROC_ID 가 '-WC-' 패턴 → WET_CLEAN (구코드, 2024-02 이전)
  · UNIT_CD NM/M: 동일 항목 A/M 값 대비 1/10 크기 → nm/min
  · ITM_CD BP: PVD 절차 항목 순서 → BASE_PRESSURE
"""

PM_NAMES = {"Wet Clean": "WET_CLEAN", "RF Generator 교체": "RF_GEN_REPLACE", "Showerhead 교체": "SHOWERHEAD_REPLACE",
            "ESC 교체": "ESC_REPLACE", "Target 교체": "TARGET_REPLACE", "Pump PM": "PUMP_PM", "정기 PM(분기)": "QUARTERLY_PM",
            "알람 Down 복구": "ALARM_RECOVERY"}
UNIT_NAMES = {"mTorr/min": "mTorr/min", "ea": "ea", "A/min": "A/min", "%": "%", "Torr": "Torr", "nm/min": "nm/min"}
PROC_PM = {"-WC-": "WET_CLEAN", "-RFG-": "RF_GEN_REPLACE", "-SHR-": "SHOWERHEAD_REPLACE", "-ESC-": "ESC_REPLACE",
           "-TGT-": "TARGET_REPLACE", "-PMP-": "PUMP_PM", "-QPM-": "QUARTERLY_PM", "-ALM-": "ALARM_RECOVERY"}
INFERRED = {}


def _infer_pm(tools, code):
    if code in INFERRED:
        return INFERRED[code]
    q = tools.query_legacy_db("SELECT PROC_ID, COUNT(*) FROM QUAL_HIS WHERE PM_TP_CD=:c GROUP BY PROC_ID", {"c": code})
    votes = {}
    for proc, n in q["rows"]:
        for pat, pm in PROC_PM.items():
            if pat in (proc or ""):
                votes[pm] = votes.get(pm, 0) + n
    if not votes:
        return None
    pm = max(votes, key=lambda k: votes[k])
    INFERRED[code] = pm
    return pm


def pm_codes(tools, pm_type):
    out = []
    for code in ["W0", "W1", "R2", "S3", "E4", "T5", "P6", "Q7", "A8"]:
        r = tools.resolve_code_value("QUAL_HIS", "PM_TP_CD", [code])[code]
        if r and PM_NAMES.get(r["meaning"]) == pm_type:
            out.append(code)
        elif not r and _infer_pm(tools, code) == pm_type:
            out.append(code)
    return out


def _avg(tools, itm_cd, unit_cd):
    q = tools.query_legacy_db("SELECT AVG(MEAS_VAL), COUNT(*) FROM QUAL_MEAS WHERE ITM_CD=:i AND UNIT_CD=:u", {"i": itm_cd, "u": unit_cd})
    return q["rows"][0] if q["rows"] else (None, 0)


def _infer_unit(tools, itm_cd, unit_cd):
    # 같은 항목의 문서화된 단위 값과 크기 비율로 추론 (예: A/M 평균 대비 1/10 → nm/min)
    key = "U:" + itm_cd + ":" + unit_cd
    if key in INFERRED:
        return INFERRED[key]
    avg_u, n_u = _avg(tools, itm_cd, unit_cd)
    avg_a, n_a = _avg(tools, itm_cd, "A/M")
    if not n_u or not n_a or not avg_u:
        return None
    ratio = avg_a / avg_u
    unit = "nm/min" if 8.0 < ratio < 12.5 else ("um/min" if 8000 < ratio < 12500 else None)
    if unit:
        INFERRED[key] = unit
    return unit


def item_unit(tools, itm_cd, unit_cd):
    it = tools.resolve_code_value("QUAL_MEAS", "ITM_CD", [itm_cd])[itm_cd]
    un = tools.resolve_code_value("QUAL_MEAS", "UNIT_CD", [unit_cd])[unit_cd]
    item = it["meaning"] if it else None
    if item is None and unit_cd == "T":
        item = "BASE_PRESSURE"          # Torr 단위 + 1e-7 수준 값 → PVD Base Pressure (절차 항목 순서와 일치)
    unit = UNIT_NAMES.get(un["meaning"]) if un else None
    if unit is None and un is None:
        unit = _infer_unit(tools, itm_cd, unit_cd)
    return item, unit


def decode_values(tools, column, values, context=None):
    res = tools.resolve_code_value("QUAL_HIS", column, values)
    out = {}
    for v, r in res.items():
        if r:
            out[v] = r
        elif column == "PM_TP_CD" and _infer_pm(tools, v):
            out[v] = {"meaning": _infer_pm(tools, v), "source": "이력 패턴 추론(PROC_ID)", "confidence": 0.93}
        elif column in ("QF_RSLT_CD", "Q1_RSLT_CD") and v == "H":
            out[v] = {"meaning": "Up 보류(타 사유)", "source": "ACT_MEMO 패턴 추론", "confidence": 0.71}
        else:
            out[v] = {"meaning": None, "source": "미해석", "confidence": 0.0}
    return out
''',
}

SEASONING_PASS_CURVE = {
    "1.0.0": '''"""seasoning_pass_curve 1.0.0 — Seasoning 매수별 1차 Pass 곡선 (공용 스킬)
리플레이 중 Super Agent 실행 계획 코드에서 반복된 '매수별 Pass율 집계'를 파라미터화한 함수.
- 오기록(물리 범위 밖 매수) 제외, 매수와 무관한 Fail(Particle 단독·Leak)은 분모에서 제외
- 반환: {count: {"n", "pass", "rate"}} + 충분 매수 추정(표본 ≥3, Pass율 ≥0.8 최소 매수)
"""

SEASON_ITEMS = ("ER", "ERU", "DR", "THU", "RSU")


def curve(rows, lo=3, hi=120):
    """rows: [{"n1", "pass1", "fail_items"}]"""
    out = {}
    for r in rows:
        n = r.get("n1")
        if n is None or n < lo or n > hi:
            continue
        fi = [x for x in (r.get("fail_items") or "").split(",") if x]
        if not r["pass1"] and fi and not any(x in SEASON_ITEMS for x in fi):
            continue
        c = out.setdefault(n, {"n": 0, "pass": 0})
        c["n"] += 1
        c["pass"] += 1 if r["pass1"] else 0
    for c in out.values():
        c["rate"] = round(c["pass"] / c["n"], 3)
    return dict(sorted(out.items()))


def sufficient_count(cv, min_n=3, min_rate=0.8):
    ok = [n for n, c in cv.items() if c["n"] >= min_n and c["rate"] >= min_rate]
    return min(ok) if ok else None
''',
}

FDC_TOOLKIT_COMMON = '''
from datetime import datetime, timedelta, timezone
import re
import statistics

KST = timezone(timedelta(hours=9))


def _num(x):
    x = (x or "").strip()
    if x in ("", "NaN", "nan", "None"):
        return None
    return float(x)


def _v4(raw):
    meta = {"unit": "mTorr", "fmt": "v4"}
    header = None
    rows = []
    for ln in raw.splitlines():
        if ln.startswith("#"):
            if ln.startswith("# UNIT"):
                meta["unit"] = ln.split("=")[-1].strip()
            continue
        parts = ln.split(",")
        if header is None:
            header = parts
            continue
        r = dict(zip(header, parts))
        rows.append({"rf_fwd": _num(r["RF_FWD_PWR"]), "rf_refl": _num(r["RF_REFL_PWR"]), "press": _num(r["CHM_PRESS"]),
                     "ts": datetime.strptime(r["TIMESTAMP"], "%Y%m%d%H%M%S")})
    return rows, meta


def _v3(raw):
    meta = {"unit": "mTorr", "fmt": "v3"}
    lines = [ln for ln in raw.splitlines() if not ln.startswith("#")]
    header = lines[0].split(";")
    rows = []
    for ln in lines[1:]:
        r = dict(zip(header, ln.split(";")))
        rows.append({"rf_fwd": _num(r["RFFWD"]), "rf_refl": _num(r["RFREF"]), "press": _num(r["PRES_MT"]),
                     "ts": datetime.strptime(r["TIME"], "%Y/%m/%d %H:%M:%S")})
    return rows, meta


def _v52(raw):
    meta = {"unit": "mTorr", "fmt": "v52"}
    m = re.search(r'"chamber.pressure": "([^"]+)"', raw.split("\\n", 1)[0])
    if m:
        meta["unit"] = m.group(1)
    lines = [ln for ln in raw.splitlines() if not ln.startswith("#")]
    header = lines[0].split(",")
    rows = []
    for ln in lines[1:]:
        r = dict(zip(header, ln.split(",")))
        d = datetime.fromisoformat(r["ts"])
        if d.tzinfo is not None:
            d = d.astimezone(KST).replace(tzinfo=None)
        rows.append({"rf_fwd": _num(r["rf.forward.w"]), "rf_refl": _num(r["rf.reflected.w"]), "press": _num(r["chamber.pressure"]), "ts": d})
    return rows, meta


PARSERS = {"#EQP:": _v3, "#{": _v52}


def parse_trace(t):
    raw = t["raw"]
    head = raw.split("\\n", 1)[0]
    for prefix, fn in PARSERS.items():
        if head.startswith(prefix):
            rows, meta = fn(raw)
            break
    else:
        rows, meta = _v4(raw)
    return normalize(rows, meta)


def rf_metrics(pre, post):
    ref = None
    if pre and pre[-1]["rows"]:
        on = [r["rf_refl"] for r in pre[-1]["rows"] if r["rf_fwd"] and r["rf_fwd"] > 50 and r["rf_refl"] is not None]
        ref = statistics.mean(on) if on else None
    out = {"ref": ref, "init": None, "delta": None, "stable_at": None, "fwd_cv": None, "pbase": None}
    if not post:
        return out
    rows = post[-1]["rows"]
    on = [r for r in rows if r["rf_fwd"] and r["rf_fwd"] > 50]
    init = [r["rf_refl"] for r in on[:6] if r["rf_refl"] is not None]
    if init:
        out["init"] = statistics.mean(init)
    if ref and out["init"]:
        out["delta"] = round((out["init"] - ref) / ref * 100.0, 2)
    fwd = [r["rf_fwd"] for r in on[2:]]
    if fwd:
        med = statistics.median(fwd)
        out["fwd_cv"] = round(statistics.pstdev(fwd) / med * 100.0, 3)
        for r in on:
            if abs(r["rf_fwd"] - med) / med < 0.01:
                out["stable_at"] = r["ts"].strftime("%Y-%m-%d %H:%M:%S")
                break
    idle = [r["press"] for r in rows if (not r["rf_fwd"]) and r["press"] is not None]
    if idle:
        out["pbase"] = min(idle)
    return out
'''

FDC_TOOLKIT = {
    "1.0.0": '''"""fdc_toolkit 1.0.0 — FDC 파서·지표 공용 스킬 (log_agent·chamber_trend_agent 중복 파서 통합, SC-004)
- SW 버전별 파서(v3.8 / v4.x / v5.2) 단일 구현
- 압력 단위를 mTorr로 일괄 정규화
"""
''' + FDC_TOOLKIT_COMMON + '''

def normalize(rows, meta):
    # 압력 단위 일괄 정규화: Torr → mTorr
    if meta.get("unit") == "Torr":
        for r in rows:
            if r["press"] is not None:
                r["press"] = r["press"] * 1000.0
    return rows, meta
''',
    "1.0.1": '''"""fdc_toolkit 1.0.1 — FDC 파서·지표 공용 스킬
- 1.0.1: 장비군별 단위 메타데이터 기반 정규화 (헤더 단위를 보존하고 변환 시 meta.unit 동기화)
  1.0.0 결함: PVD 압력(Torr)을 mTorr로 일괄 변환하면서 단위 라벨은 Torr 유지 → Base Pressure 1,000배 왜곡
"""
''' + FDC_TOOLKIT_COMMON + '''

NATIVE_UNIT = {"Torr": "Torr", "mTorr": "mTorr"}


def normalize(rows, meta):
    # 헤더에 선언된 단위를 그대로 사용 (변환하지 않음). 단위 미선언 시 mTorr로 간주
    meta["unit"] = NATIVE_UNIT.get(meta.get("unit") or "mTorr", "mTorr")
    return rows, meta
''',
}


def skill_sources():
    return {"legacy_sql_toolkit": LEGACY_SQL_TOOLKIT, "code_value_resolver": CODE_VALUE_RESOLVER,
            "seasoning_pass_curve": SEASONING_PASS_CURVE, "fdc_toolkit": FDC_TOOLKIT}
