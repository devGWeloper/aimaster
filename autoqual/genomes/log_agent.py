"""log_agent Genome 소스 빌더 (Playbook).

오프라인 모드에서 'LLM이 작성한 코드' 역할을 하는 사전 작성 코드 조각이다. 기능 플래그 조합으로
버전별 실제 소스를 만든다. 생성된 소스는 샌드박스에서 실행되고 회귀 테스트로 검증된다.

features
  v3            SW v3.8 세미콜론 포맷 파서 (리플레이 Heal)
  v52 / v52_utc SW v5.2 파서 (정상 / 타임존 UTC 가정 결함판)
  median        RF Reflected 초기 구간 중앙값(스파이크 강건)
  bp            Leak 로그 BP 안정화 시간 신호
  summary       POST 트레이스 미수집 시 Run Summary 폴백
  multirun      PM 전 기준을 직전 생산 Run 2개 중앙값으로
  probe         Run 종류별 개별 재조회(Heal 부작용: 호출 증가)
  leak_unit     Leak Rate 단위 토큰 해석 (Torr/min → mTorr/min)
  toolkit       공용 스킬 fdc_toolkit 사용 (자체 파서 제거)
  cache / cache_bad  트레이스 캐시 (정상 키 / PM 완료 시각 누락 결함판)
  trend / trend_bad  PM 사이클 간 추이 흡수 (chamber_trend 병합) / 사이클 경계 결함판
  pvd_cycle     PVD 사이클 경계(Target 교체) 지원
"""
from __future__ import annotations

HEADER = '''"""log_agent {version} — 로그분석 Agent
PM 전후 FDC 트레이스(RF Forward/Reflected·Pressure)·Leak Check·알람 로그를 읽어 챔버 상태 지표를 만든다.
판정(Pass/Fail)은 하지 않는다. 파싱 실패 항목은 빈 값으로 채우지 않고 unavailable 로 반환한다.
변경 이력:
{changelog}
"""
from datetime import datetime, timedelta, timezone
import re
import statistics

FMT = "%Y-%m-%d %H:%M:%S"
KST = timezone(timedelta(hours=9))


def _p(s):
    return datetime.strptime(str(s).replace("T", " ")[:19], FMT)


def _s(d):
    return d.strftime(FMT)


def _num(x):
    x = (x or "").strip()
    if x in ("", "NaN", "nan", "None"):
        return None
    return float(x)
'''

PARSE_V4 = '''

def parse_v4(raw):
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
'''

PARSE_V3 = '''

def parse_v3(raw):
    # SW v3.8: 세미콜론 구분, 'YYYY/MM/DD hh:mm:ss', 압력 mTorr 고정
    meta = {"unit": "mTorr", "fmt": "v3"}
    rows = []
    lines = [ln for ln in raw.splitlines() if not ln.startswith("#")]
    header = lines[0].split(";")
    for ln in lines[1:]:
        r = dict(zip(header, ln.split(";")))
        rows.append({"rf_fwd": _num(r["RFFWD"]), "rf_refl": _num(r["RFREF"]), "press": _num(r["PRES_MT"]),
                     "ts": datetime.strptime(r["TIME"], "%Y/%m/%d %H:%M:%S")})
    return rows, meta
'''

PARSE_V52 = '''

def _ts_v52(s):
    # 장비 로컬(KST) 기준으로 통일: 오프셋이 있으면 KST로 환산, 없으면 장비 로컬 시각으로 간주
    d = datetime.fromisoformat(s)
    if d.tzinfo is not None:
        d = d.astimezone(KST).replace(tzinfo=None)
    return d


def parse_v52(raw):
    # SW v5.2: JSON 메타 헤더 + 점 표기 컬럼, ISO8601 시간
    meta = {"unit": "mTorr", "fmt": "v52"}
    m = re.search(r'"chamber.pressure": "([^"]+)"', raw.split("\\n", 1)[0])
    if m:
        meta["unit"] = m.group(1)
    lines = [ln for ln in raw.splitlines() if not ln.startswith("#")]
    header = lines[0].split(",")
    rows = []
    for ln in lines[1:]:
        r = dict(zip(header, ln.split(",")))
        rows.append({"rf_fwd": _num(r["rf.forward.w"]), "rf_refl": _num(r["rf.reflected.w"]), "press": _num(r["chamber.pressure"]),
                     "ts": _ts_v52(r["ts"])})
    return rows, meta
'''

PARSE_V52_UTC = '''

def _to_utc(d):
    # 모든 시각을 UTC로 통일 (타임존 미지정 로그는 UTC로 간주)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def parse_v52(raw):
    meta = {"unit": "mTorr", "fmt": "v52"}
    m = re.search(r'"chamber.pressure": "([^"]+)"', raw.split("\\n", 1)[0])
    if m:
        meta["unit"] = m.group(1)
    lines = [ln for ln in raw.splitlines() if not ln.startswith("#")]
    header = lines[0].split(",")
    rows = []
    for ln in lines[1:]:
        r = dict(zip(header, ln.split(",")))
        rows.append({"rf_fwd": _num(r["rf.forward.w"]), "rf_refl": _num(r["rf.reflected.w"]), "press": _num(r["chamber.pressure"]),
                     "ts": datetime.fromisoformat(r["ts"])})
    return rows, meta
'''


def dispatch(f: set) -> str:
    if "toolkit" in f:
        return "\n\ndef parse_trace(t):\n    return SK.fdc_toolkit.parse_trace(t)\n"
    lines = ["\n\ndef parse_trace(t):", '    raw = t["raw"]', '    head = raw.split("\\n", 1)[0]']
    branches = []
    if "v3" in f:
        branches.append(('head.startswith("#EQP:")', "parse_v3"))
    if "v52" in f or "v52_utc" in f:
        branches.append(('head.startswith("#{")', "parse_v52"))
    for k, (cond, fn) in enumerate(branches):
        lines += [f"    {'if' if k == 0 else 'elif'} {cond}:", f"        rows, meta = {fn}(raw)"]
    if branches:
        lines += ["    else:", "        rows, meta = parse_v4(raw)"]
    else:
        lines += ["    rows, meta = parse_v4(raw)"]
    if "v52_utc" in f:
        lines += ["    for r in rows:", "        r[\"ts\"] = _to_utc(r[\"ts\"]).astimezone(KST).replace(tzinfo=None)"]
    lines += ["    return rows, meta", ""]
    return "\n".join(lines)


LEAK = '''

def parse_leak(lines):
    if not lines:
        return None
    ln = lines[-1]
    out = {"raw": ln}
    m = re.search(r"RATE=([0-9.Ee+-]+)", ln)
    out["rate"] = float(m.group(1)) if m else None
__LEAK_UNIT__    b = re.search(r"BASE=([0-9.Ee+-]+)", ln)
    out["base"] = float(b.group(1)) if b else None
__BP__    return out
'''
LEAK_UNIT = '''    u = re.search(r"RATE=[0-9.Ee+-]+ (\\S+)", ln)
    if out["rate"] is not None and u and u.group(1) == "Torr/min":
        out["rate"] = round(out["rate"] * 1000.0, 4)      # 단위 토큰 해석: Torr/min → mTorr/min
'''
LEAK_BP = '''    s = re.search(r"BP_STABLE_MIN=(\\d+)", ln)
    out["bp_stable_min"] = int(s.group(1)) if s else None
'''


def metrics(f: set) -> str:
    agg = "statistics.median" if "median" in f else "statistics.mean"
    pre = ('''    pres = [x for x in pre if x["rows"]]
    refs = []
    for x in pres[-2:]:
        on = [r["rf_refl"] for r in x["rows"] if r["rf_fwd"] and r["rf_fwd"] > 50 and r["rf_refl"] is not None]
        if on:
            refs.append(statistics.median(on))
    ref = statistics.median(refs) if refs else None
''' if "multirun" in f else f'''    ref = None
    if pre and pre[-1]["rows"]:
        on = [r["rf_refl"] for r in pre[-1]["rows"] if r["rf_fwd"] and r["rf_fwd"] > 50 and r["rf_refl"] is not None]
        ref = {agg}(on) if on else None
''')
    return f'''

def rf_metrics(pre, post):
    """pre/post: [{{"rows": [...], "meta": {{...}}}}] — RF Reflected 변화율, RF 안정화 시각"""
{pre}    out = {{"ref": ref, "init": None, "delta": None, "stable_at": None, "fwd_cv": None, "pbase": None}}
    if not post:
        return out
    rows = post[-1]["rows"]
    on = [r for r in rows if r["rf_fwd"] and r["rf_fwd"] > 50]
    init = [r["rf_refl"] for r in on[:6] if r["rf_refl"] is not None]
    if init:
        out["init"] = {agg}(init)
    if ref and out["init"]:
        out["delta"] = round((out["init"] - ref) / ref * 100.0, 2)
    fwd = [r["rf_fwd"] for r in on[2:]]
    if fwd:
        med = statistics.median(fwd)
        out["fwd_cv"] = round(statistics.pstdev(fwd) / med * 100.0, 3)
        for r in on:
            if abs(r["rf_fwd"] - med) / med < 0.01:
                out["stable_at"] = _s(r["ts"])
                break
    idle = [r["press"] for r in rows if (not r["rf_fwd"]) and r["press"] is not None]
    if idle:
        out["pbase"] = min(idle)
    return out
'''


SUMMARY = '''

def summary_fallback(tools, cid, pm_start, pm_end):
    # POST_PM 트레이스 미수집 시 장비 Run Summary(안정 포맷)로 RF 지표 대체
    sm = tools.read_fdc_summary(cid, _s(pm_start - timedelta(hours=8)), _s(pm_end))
    pre = [x for x in sm if x["RUN_KIND"] == "PROD"]
    post = [x for x in sm if x["RUN_KIND"] == "POST_PM"]
    if not pre or not post or not post[-1]["RF_REFL_INIT"]:
        return None
    ref = pre[-1]["RF_REFL_MEAN"]
    return {"ref": ref, "init": post[-1]["RF_REFL_INIT"], "delta": round((post[-1]["RF_REFL_INIT"] - ref) / ref * 100.0, 2),
            "stable_at": None, "fwd_cv": None, "pbase": None, "source": "run_summary"}
'''

TREND = '''

def cycle_trend(tools, eqp, cid, pm_end, group):
    # PM 사이클 간 추이 (chamber_trend_agent 기능 흡수): 직전 Wet Clean 이후 RF 누적시간
    evs = tools.get_pm_event(cid, "WET_CLEAN", 3)
    prev = [e for e in evs if _p(e["pm_end"]) < pm_end - timedelta(hours=1)]
{boundary}    if not prev:
        return {{"cycle_rf_hours": None}}
    d0 = _p(prev[0]["pm_end"])
    ch = cid.rsplit("-", 1)[1]
    codes = SK.legacy_sql_toolkit.chamber_codes(ch)
    q = tools.query_legacy_db(
        "SELECT YMD, RF_ON_MIN FROM CHB_RF_USAGE WHERE EQP_ID=:e AND CHB_ID IN (" + ",".join("'" + c + "'" for c in codes) + ") "
        "AND YMD > :a AND YMD < :b", {{"e": eqp, "a": d0.strftime("%Y%m%d"), "b": pm_end.strftime("%Y%m%d")}})
    mins = [r[1] for r in q["rows"]]
    days = max(1, (pm_end.date() - d0.date()).days - 1)
    total = sum(mins)
    return {{"cycle_rf_hours": round(total / 60.0, 1), "cycle_days": days, "cycle_start": _s(d0)}}
'''
TREND_BOUNDARY_GOOD = ''
TREND_BOUNDARY_BAD = '''    # (결함) 사이클 경계를 종류 무관 '직전 PM'으로 판정 — Wet Clean 외 PM에서 사이클이 리셋됨
    evs = tools.get_pm_event(cid, None, 3)
    prev = [e for e in evs if _p(e["pm_end"]) < pm_end - timedelta(hours=1)]
'''
TREND_PVD = '''    # PVD 사이클 경계 지원 (Heal: chamber_trend_agent와 동일 기준 — 직전 Wet Clean)
'''


def run_fn(f: set) -> str:
    fetch_probe = "probe" in f
    cache = "cache" in f or "cache_bad" in f
    lines = ['''

def run(action, inputs, tools, skills):
    global SK
    SK = skills
    if action == "trend":
        return run_trend(inputs, tools)
    eqp, cid = inputs["eqp_id"], inputs["chamber_id"]
    group = inputs.get("eqp_group", "")
    pm_start, pm_end = _p(inputs["pm_start"]), _p(inputs["pm_end"])
    w0 = _s(pm_start - timedelta(hours=8))
    unavailable = []''']
    if cache:
        key = '"fdc:" + cid + ":" + inputs["pm_start"][:10]' if "cache_bad" in f else \
              '"fdc:" + cid + ":" + inputs["pm_end"] + ":" + tools.now()[:16]'
        lines.append(f'''    key = {key}
    traces = tools.cache_get(key)
    if traces is None:
        traces = tools.read_fdc_trace(eqp, cid, w0, _s(pm_end))
        tools.cache_put(key, traces)''')
    elif fetch_probe:
        lines.append('''    # Run 종류별로 나눠 재조회 (포맷 혼재 시 실패 구간 국소화)
    traces = []
    seen = set()
    mid = _s(pm_start - timedelta(hours=3))
    for a, b in ((w0, mid), (mid, _s(pm_start)), (_s(pm_end - timedelta(hours=1)), _s(pm_end))):
        for t in tools.read_fdc_trace(eqp, cid, a, b):
            if t["trace_id"] not in seen:
                seen.add(t["trace_id"])
                traces.append(t)
    traces.sort(key=lambda t: t["run_ts"])''')
    else:
        lines.append('''    traces = tools.read_fdc_trace(eqp, cid, w0, _s(pm_end))''')
    lines.append('''    sw = traces[-1]["sw_version"] if traces else None
    pre, post = [], []
    for t in traces:
        rows, meta = parse_trace(t)
        item = {"rows": rows, "meta": meta, "run_ts": t["run_ts"], "sw": t["sw_version"]}
        (post if t["run_kind"] == "POST_PM" else pre).append(item)
    rf = rf_metrics(pre, post)''')
    if "summary" in f:
        lines.append('''    if rf["delta"] is None and not post:
        fb = summary_fallback(tools, cid, pm_start, pm_end)
        if fb:
            rf = fb''')
    lines.append('''    logs = tools.read_alarm_log(eqp, cid, _s(pm_start), _s(pm_end))
    leak = parse_leak(logs["leak_checks"])
    alarms = [a for a in logs["alarms"] if a["severity"] in ("WARN", "ALARM")]
    ind = []
    sig = {}
    if leak and leak["rate"] is not None:
        ind.append({"name": "LEAK_RATE", "value": leak["rate"], "unit": "mTorr/min", "ref": None, "change_pct": None})
        sig["leak_rate"] = leak["rate"]
    else:
        unavailable.append("LEAK_RATE")
    if group == "PVD":
        bp = rf.get("pbase") if rf.get("pbase") is not None else (leak or {}).get("base")
        unit = post[-1]["meta"]["unit"] if post else "Torr"
        if bp is not None:
            ind.append({"name": "BASE_PRESSURE", "value": bp, "unit": unit, "ref": None, "change_pct": None})
            sig["base_pressure"] = bp
    if rf["delta"] is not None:
        ind.append({"name": "RF_REFL_DELTA", "value": rf["delta"], "unit": "%", "ref": rf["ref"], "change_pct": rf["delta"],
                    "source": rf.get("source", "trace")})
        sig["rf_refl_delta_pct"] = rf["delta"]
    else:
        unavailable.append("RF_REFL_DELTA")
    if rf.get("stable_at"):
        ind.append({"name": "RF_STABLE_AT", "value": rf["stable_at"], "unit": "ts", "ref": None, "change_pct": None})
    if rf.get("fwd_cv") is not None:
        ind.append({"name": "RF_FWD_CV", "value": rf["fwd_cv"], "unit": "%", "ref": None, "change_pct": None})''')
    if "bp" in f:
        lines.append('''    if leak and leak.get("bp_stable_min") is not None:
        ind.append({"name": "BP_STABLE_MIN", "value": leak["bp_stable_min"], "unit": "min", "ref": None, "change_pct": None})
        sig["bp_stable_min"] = leak["bp_stable_min"]''')
    if "trend" in f or "trend_bad" in f:
        lines.append('''    if group in ("CVD", "PVD") or inputs.get("want_trend"):
        tr = cycle_trend(tools, eqp, cid, pm_end, group)
        if tr.get("cycle_rf_hours") is not None:
            sig["cycle_rf_hours"] = tr["cycle_rf_hours"]
            ind.append({"name": "CYCLE_RF_HOURS", "value": tr["cycle_rf_hours"], "unit": "h", "ref": None, "change_pct": None})''')
    lines.append('''    sig["alarms_after_pm"] = len(alarms)
    sig["rf_alarm"] = any(a["alarm_code"].startswith("ALM-RF") for a in alarms)
    return {"status": "ok" if not unavailable else "partial", "sw_version": sw, "indicators": ind, "signals": sig,
            "alarms": alarms[-5:], "unavailable": unavailable, "n_traces": len(traces)}
''')
    if "trend" in f or "trend_bad" in f:
        lines.append('''

def run_trend(inputs, tools):
    eqp, cid = inputs["eqp_id"], inputs["chamber_id"]
    pm_end = _p(inputs["pm_end"])
    if inputs.get("eqp_group") == "PVD" and not PVD_CYCLE:
        return {"status": "unavailable", "signals": {}, "indicators": [], "unavailable": ["CYCLE_RF_HOURS"],
                "error": "PVD 사이클 경계(Target 교체) 미지원"}
    tr = cycle_trend(tools, eqp, cid, pm_end, inputs.get("eqp_group", ""))
    if tr.get("cycle_rf_hours") is None:
        return {"status": "unavailable", "signals": {}, "indicators": [], "unavailable": ["CYCLE_RF_HOURS"]}
    return {"status": "ok", "signals": {"cycle_rf_hours": tr["cycle_rf_hours"]}, "unavailable": [],
            "indicators": [{"name": "CYCLE_RF_HOURS", "value": tr["cycle_rf_hours"], "unit": "h", "ref": tr.get("cycle_start"), "change_pct": None}]}
''')
    else:
        lines.append('''

def run_trend(inputs, tools):
    raise ValueError("log_agent: trend 기능 없음")
''')
    return "\n".join(lines)


def build(version: str, features: set, changelog: list[str]) -> str:
    f = set(features)
    src = HEADER.format(version=version, changelog="\n".join(f"- {c}" for c in changelog) or "- 초기 구축 (SW v4.x 포맷)")
    src += "\nSK = None\nPVD_CYCLE = " + ("True" if "pvd_cycle" in f else "False") + "\n"
    if "toolkit" not in f:
        src += PARSE_V4
        if "v3" in f:
            src += PARSE_V3
        if "v52" in f:
            src += PARSE_V52
        elif "v52_utc" in f:
            src += PARSE_V52_UTC
    src += dispatch(f)
    src += LEAK.replace("__LEAK_UNIT__", LEAK_UNIT if "leak_unit" in f else "").replace("__BP__", LEAK_BP if "bp" in f else "")
    if "toolkit" in f:
        src += '''

def rf_metrics(pre, post):
    return SK.fdc_toolkit.rf_metrics(pre, post)
'''
    else:
        src += metrics(f)
    if "summary" in f:
        src += SUMMARY
    if "trend" in f or "trend_bad" in f:
        b = TREND_BOUNDARY_BAD if "trend_bad" in f else TREND_BOUNDARY_GOOD
        if "pvd_cycle" in f:
            b += TREND_PVD
        src += TREND.format(boundary=b)
    src += run_fn(f)
    return src
