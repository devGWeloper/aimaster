"""spec_agent · legacy_agent · chamber_trend_agent · part_history_agent · lot_trace_agent Genome 소스 빌더."""
from __future__ import annotations


def _hdr(name: str, version: str, title: str, desc: str, changelog: list[str]) -> str:
    cl = "\n".join(f"- {c}" for c in changelog) or "- 초기 구축"
    return f'"""{name} {version} — {title}\n{desc}\n변경 이력:\n{cl}\n"""\n'


# ════════════════════════════════════════════════════════════════════
# spec_agent — 기준정보 Agent
# ════════════════════════════════════════════════════════════════════
SPEC_LOOKUP = '''

def lookup(inputs, tools):
    eqp = tools.lookup_equipment(inputs["eqp_id"])
    if not eqp:
        return {"status": "unavailable", "reason": "기준정보 누락: 장비 미등록", "unavailable": ["PROCEDURE"]}
    sp = tools.query_spec_db(eqp["eqp_model"], inputs["pm_type"], inputs.get("chamber_id"))
    if sp.get("error"):
        return {"status": "unavailable", "reason": "기준정보 누락: " + eqp["eqp_model"] + " / " + inputs["pm_type"],
                "eqp_model": eqp["eqp_model"], "eqp_group": eqp["eqp_group"], "unavailable": ["PROCEDURE"]}
    return {"status": "ok", "eqp_model": eqp["eqp_model"], "eqp_group": eqp["eqp_group"], "procedure_id": sp["procedure_id"],
            "revision": sp["revision"], "steps": sp["steps"], "specs": sp["specs"], "seasoning": sp["seasoning"],
            "valid_at": sp["valid_at"], "unavailable": []}
'''

SPEC_COND = '''

def cond_ok(cond, sig):
    """교훈 적용 조건 평가. 신호가 없으면 적용하지 않는다."""
    if not cond:
        return True
    if "all" in cond:
        return all(cond_ok(c, sig) for c in cond["all"])
    v = sig.get(cond["signal"])
    if v is None:
        return False
    if "between" in cond:
        lo, hi = cond["between"]
        return lo <= v < hi
    t = cond["value"]
    op = cond.get("op", ">=")
    if op == ">=":
        return v >= t
    if op == ">":
        return v > t
    if op == "<":
        return v < t
    if op == "<=":
        return v <= t
    if op == "in":
        return v in t
    return v == t
'''


def spec_recommend(f: set) -> str:
    ph = '''    if "part_history" in FEATURES and inputs.get("eqp_group") == "ETCH" and inputs["pm_type"] in ("WET_CLEAN", "QUARTERLY_PM"):
        # 부품 사용시간은 기준정보 Agent가 직접 조회 (외부 전달값 미사용, 보정 일관성)
        ph = tools.call_agent("part_history_agent", "usage", {"eqp_id": inputs["eqp_id"], "chamber_id": inputs["chamber_id"],
                                                             "at": inputs["pm_end"], "part": "FOCUS_RING"})
        if ph.get("status") == "ok" and ph.get("signals", {}).get("fr_hours") is not None:
            sig["fr_hours"] = ph["signals"]["fr_hours"]
            notes.append("Focus Ring 사용시간 " + str(round(sig["fr_hours"])) + "h (part_history_agent)")
        else:
            unavailable.append("FR_HOURS")
''' if "part_history" in f else ""
    return f'''

def recommend(inputs, tools):
    seas = inputs["seasoning"]
    base = seas["base_count"]
    sig = dict(inputs.get("signals") or {{}})
    sig.setdefault("recipe_rev", seas.get("recipe_rev"))
    corrections, expired, steps, notes, unavailable = [], [], [], [], []
{ph}    if "lessons" in FEATURES:
        lessons = tools.search_experience({{"kind": "lesson", "eqp_model": inputs["eqp_model"], "pm_type": inputs["pm_type"]}}, 200)
        if "procedure" in FEATURES:
            lessons = lessons + tools.search_experience({{"kind": "lesson", "eqp_model": "*", "pm_type": "*"}}, 20)
        for L in lessons:
            c = L["content"]
            if L.get("status", "active") != "active":
                continue
            if "recipe_cond" in FEATURES and c.get("recipe_rev") and c["recipe_rev"] != seas.get("recipe_rev"):
                expired.append(L["id"])
                continue
            if not cond_ok(c.get("condition"), sig):
                continue
            if c.get("kind") == "procedure":
                if "procedure" in FEATURES:
                    steps.append({{"step": c["step"], "lesson_id": L["id"], "reason": c["text"]}})
                continue
            amt = c.get("correction", 0)
            if amt < 0 and "negative" not in FEATURES:
                continue
            corrections.append({{"lesson_id": L["id"], "amount": amt, "reason": c["text"], "sources": len(L.get("source_case_ids") or [])}})
    total = base + sum(c["amount"] for c in corrections)
    if "negative" in FEATURES:
        total = max(total, max(3, int(round(base * 0.7))))
    count = int((total + 4) // 5 * 5) if total % 5 else int(total)
    return {{"status": "ok", "base": base, "count": count, "required_est": int(total), "recipe_id": seas.get("recipe_id"),
            "recipe_rev": seas.get("recipe_rev"), "corrections": corrections, "expired_lessons": expired,
            "extra_steps": steps, "notes": notes, "signals_used": sig, "unavailable": unavailable}}
'''


SPEC_RUN = '''

def run(action, inputs, tools, skills):
    if action == "lookup":
        return lookup(inputs, tools)
    if action == "recommend":
        return recommend(inputs, tools)
    raise ValueError("spec_agent: 알 수 없는 action " + str(action))
'''

SPEC_LOG = {
    "lessons": "교훈(Lesson) 조건부 Seasoning 보정 적용 (양의 보정)",
    "recipe_cond": "교훈 적용 조건에 Seasoning 레시피 버전 포함 → 레시피 개정 시 구 교훈 자동 만료",
    "negative": "과잉 Seasoning 감축(음의 보정) 허용 + 하한 가드(기본 매수 70%)",
    "procedure": "절차 교훈(대기 단계 추가) 반영",
    "part_history": "part_history_agent 내부 호출로 Focus Ring 사용시간 신호 확보 (간접 의존)",
}


def build_spec(version: str, features: set, changelog: list[str]) -> str:
    src = _hdr("spec_agent", version, "기준정보 Agent",
               "장비 모델·PM 종류별 Qual 절차·Spec·Seasoning 기준을 조회하고, 조건이 맞는 교훈으로 추천 매수를 산출한다.\n"
               "Spec 값은 임의 변경·추정하지 않으며 기준정보 누락 시 '기준정보 누락'으로 반환한다.", changelog)
    src += f"\nFEATURES = {sorted(features)!r}\n"
    src += SPEC_LOOKUP + SPEC_COND + spec_recommend(features) + SPEC_RUN
    return src


# ════════════════════════════════════════════════════════════════════
# legacy_agent — 레거시DB Agent
# ════════════════════════════════════════════════════════════════════
LEGACY_SOURCES = {
    "QL_HIS_NEW": ("SELECT QUAL_SEQ, PM_END_TS, SSN_QTY_1ST, RSLT_1ST, NULL, SSN_QTY_FINAL, RSLT_FINAL, NULL, '', PM_TYPE_CD "
                   "FROM QL_HIS_NEW WHERE EQUIP_ID=:e AND CHAMBER_ID IN \" + T.in_list(T.chamber_codes(ch)) + \" AND PM_TYPE_CD IN \" + T.in_list(codes) + \" ORDER BY PM_END_TS DESC LIMIT :n"),
    "QUAL_HIS_OLD": ("SELECT SEQ, REPLACE(PMDATE, '-', '') || '000000', SEASON_QTY, CASE RESULT WHEN 'OK' THEN 'P' ELSE 'F' END, NULL, SEASON_QTY, NULL, WORKER, '', PMTYPE "
                     "FROM QUAL_HIS_OLD WHERE EQUIP=:e AND CHAMBER IN \" + T.in_list(T.chamber_codes(ch)) + \" AND PMTYPE=\" + T.in_list([inputs['pm_type']]) + \" ORDER BY PMDATE DESC LIMIT :n"),
    "TMP_QH_BAK_0312": ("SELECT QH_SEQ, PM_END_DT, SSN_CNT_1, Q1_RSLT_CD, NULL, SSN_CNT_FNL, NULL, ENG_ID, '', PM_TP_CD "
                        "FROM TMP_QH_BAK_0312 WHERE EQP_ID=:e AND CHB_ID IN \" + T.in_list(T.chamber_codes(ch)) + \" AND PM_TP_CD IN \" + T.in_list(codes) + \" ORDER BY PM_END_DT DESC LIMIT :n"),
}


def _legacy_sql(features: set, del_filter: str) -> str:
    for f in features:
        if f.startswith("src:"):
            name = f[4:]
            return f"    # Heal 시도: 대체 테이블 {name} 탐색\n" + '    sql = ("' + LEGACY_SOURCES[name] + '")\n'
    return ('''    sql = ("SELECT QH_SEQ, PM_END_DT, SSN_CNT_1, Q1_RSLT_CD, Q1_FAIL_ITM, SSN_CNT_FNL, QF_RSLT_CD, ENG_ID, ACT_MEMO, PM_TP_CD "
           "FROM QUAL_HIS WHERE EQP_ID=:e AND CHB_ID IN " + T.in_list(T.chamber_codes(ch)) + " AND PM_TP_CD IN " + T.in_list(codes)'''
            + del_filter + '''
           + " ORDER BY PM_END_DT DESC LIMIT :n")
''')


def build_legacy(version: str, features: set, changelog: list[str]) -> str:
    del_filter = "\n        + \" AND DEL_YN='N'\"" if "del_filter" in features else ""
    if "pass_curve" in features:
        stats = '''    cv = skills.seasoning_pass_curve.curve([{"n1": r[2], "pass1": r[3] == "P", "fail_items": r[4]} for r in rows])
    by_count = {str(k): {"n": v["n"], "pass": v["pass"]} for k, v in cv.items()}
    suff = skills.seasoning_pass_curve.sufficient_count(cv)
'''
    else:
        stats = '''    by_count = {}
    for r in rows:
        n = r[2]
''' + ('''        if n is None or n < 3 or n > 120:
            continue
''' if "typo_filter" in features else "") + '''        c = by_count.setdefault(str(n), {"n": 0, "pass": 0})
        c["n"] += 1
        c["pass"] += 1 if r[3] == "P" else 0
    suff = None
'''
    src = _hdr("legacy_agent", version, "레거시DB Agent",
               "문서화가 부족한 레거시 MES DB(약어 컬럼·미문서화 코드값·폐기 테이블)를 스킬로 조회해 동일 챔버·동일 PM 과거 Qual 이력,\n"
               "Seasoning 매수별 1차 Pass율, Fail·재시도 패턴을 분석한다. SELECT만 사용, 0건은 '이력 없음'과 '데이터 부재'로 구분.", changelog)
    src += f"\nfrom datetime import datetime\n\nFEATURES = {sorted(features)!r}\n"
    src += '''

def _absence(tools, now):
    sch = tools.inspect_legacy_schema("QUAL_HIS", 0)
    if not sch or sch[0].get("guard"):
        return "data_absent", "QUAL_HIS 조회 불가"
    s = sch[0]
    if s.get("deprecated"):
        return "data_absent", "QUAL_HIS " + (s.get("note") or "폐기/이관")
    last = s.get("last_loaded_at")
    if not last and not s.get("row_count"):
        return "no_history", "이력 테이블에 적재된 이력 없음"
    if not last:
        return "data_absent", "적재 기록 없음"
    gap = (datetime.strptime(now[:10], "%Y-%m-%d") - datetime.strptime(last[:10], "%Y-%m-%d")).days
    if gap > 3:
        return "data_absent", "최종 적재 " + last[:16] + " (" + str(gap) + "일 미적재)"
    return "no_history", "동일 조건 이력 없음"


def history(inputs, tools, skills):
    T, R = skills.legacy_sql_toolkit, skills.code_value_resolver
    eqp = inputs["eqp_id"]
    ch = inputs["chamber_id"].rsplit("-", 1)[1]
    codes = R.pm_codes(tools, inputs["pm_type"])
    if not codes:
        return {"status": "partial", "n_cases": 0, "by_count": {}, "recent": [], "absence": "code_unresolved",
                "note": "PM 종류 코드값 해석 불가 (" + inputs["pm_type"] + ")", "unavailable": ["HISTORY"], "decoded": {}}
''' + _legacy_sql(features, del_filter) + '''
    q = tools.query_legacy_db(sql, {"e": eqp, "n": inputs.get("limit", 8)})
    rows = q["rows"]
    if not rows:
        kind, why = _absence(tools, tools.now())
        return {"status": "ok" if kind == "no_history" else "partial", "n_cases": 0, "by_count": {}, "recent": [], "absence": kind,
                "note": why, "unavailable": [] if kind == "no_history" else ["HISTORY"], "decoded": {}, "guard_blocked": q["guard_blocked"]}
''' + stats + '''    recent = [{"qh_seq": r[0], "pm_end": T.fmt_dt(r[1]), "n1": r[2], "pass1": r[3] == "P", "fail_items": r[4], "final": r[5],
               "eng": r[7], "memo": r[8]} for r in rows]
    decoded = {c: R.decode_values(tools, "PM_TP_CD", [c])[c] for c in sorted(set(r[9] for r in rows))}
    return {"status": "ok", "n_cases": len(rows), "period": [recent[-1]["pm_end"][:7], recent[0]["pm_end"][:7]],
            "by_count": by_count, "sufficient_count": suff, "recent": recent, "absence": "none", "decoded": decoded,
            "note": "", "unavailable": [], "guard_blocked": q["guard_blocked"]}


def measurements(inputs, tools, skills):
    R = skills.code_value_resolver
    q = tools.query_legacy_db("SELECT ITM_CD, MEAS_VAL, UNIT_CD FROM QUAL_MEAS WHERE QH_SEQ=:s AND MEAS_SEQ=:m",
                              {"s": inputs["qh_seq"], "m": inputs.get("meas_seq", 1)})
    out, unresolved = [], []
    for itm, val, uc in q["rows"]:
        item, unit = R.item_unit(tools, itm, uc)
        if item is None or unit is None:
            unresolved.append(itm + "/" + uc)
            if item is None:
                continue
        out.append({"item": item, "value": val, "unit": unit, "raw_unit": uc})
    return {"status": "ok" if q["rows"] else "unavailable", "measurements": out, "unresolved": unresolved, "unavailable": []}


def run(action, inputs, tools, skills):
    if action == "history":
        return history(inputs, tools, skills)
    if action == "measurements":
        return measurements(inputs, tools, skills)
    raise ValueError("legacy_agent: 알 수 없는 action " + str(action))
'''
    return src


# ════════════════════════════════════════════════════════════════════
# chamber_trend_agent — 챔버추이 Agent (리플레이 중 Grow)
# ════════════════════════════════════════════════════════════════════
def build_chamber_trend(version: str, features: set, changelog: list[str], log_parsers: str = "") -> str:
    """log_parsers: 생성 시점 log_agent 파서 코드(복제 보유 — SC-003·SC-004의 코드 중복 원인)."""
    boundary = '''    evs = tools.get_pm_event(cid, "WET_CLEAN", 3)
    prev = [e for e in evs if _p(e["pm_end"]) < pm_end - timedelta(hours=1)]
''' if "wc_cycle" in features else '''    evs = tools.get_pm_event(cid, None, 3)
    prev = [e for e in evs if _p(e["pm_end"]) < pm_end - timedelta(hours=1)]
'''
    interp = '''    days = max(1, (pm_end.date() - d0.date()).days - 1)
    total = sum(mins) + (statistics.mean(mins) * (days - len(mins)) if mins and len(mins) < days else 0)
''' if "interp" in features else '''    days = max(1, (pm_end.date() - d0.date()).days - 1)
    total = sum(mins)
'''
    if "toolkit" in features:
        parse = '''

def parse_trace(t):
    return SK.fdc_toolkit.parse_trace(t)
'''
    else:
        parse = log_parsers
    src = _hdr("chamber_trend_agent", version, "챔버추이 Agent",
               "PM 사이클 간 장기 추이: 직전 Wet Clean 이후 RF 누적시간과 사이클별 PM 직후 RF Reflected 초기값 추이를 분석한다.", changelog)
    src += '''from datetime import datetime, timedelta, timezone
import re
import statistics

FMT = "%Y-%m-%d %H:%M:%S"
KST = timezone(timedelta(hours=9))
SK = None


def _p(s):
    return datetime.strptime(str(s).replace("T", " ")[:19], FMT)


def _s(d):
    return d.strftime(FMT)


def _num(x):
    x = (x or "").strip()
    if x in ("", "NaN", "nan", "None"):
        return None
    return float(x)
''' + parse + '''

def run(action, inputs, tools, skills):
    global SK
    SK = skills
    eqp, cid = inputs["eqp_id"], inputs["chamber_id"]
    pm_end = _p(inputs["pm_end"])
''' + boundary + '''    if not prev:
        return {"status": "partial", "signals": {}, "indicators": [], "unavailable": ["CYCLE_RF_HOURS"], "note": "직전 사이클 없음"}
    d0 = _p(prev[0]["pm_end"])
    ch = cid.rsplit("-", 1)[1]
    codes = skills.legacy_sql_toolkit.chamber_codes(ch)
    q = tools.query_legacy_db(
        "SELECT YMD, RF_ON_MIN FROM CHB_RF_USAGE WHERE EQP_ID=:e AND CHB_ID IN (" + ",".join("'" + c + "'" for c in codes) + ") "
        "AND YMD > :a AND YMD < :b", {"e": eqp, "a": d0.strftime("%Y%m%d"), "b": pm_end.strftime("%Y%m%d")})
    mins = [r[1] for r in q["rows"]]
''' + interp + '''    hours = round(total / 60.0, 1)
    # 사이클별 PM 직후 RF Reflected 초기값 추이 (최근 3개 사이클)
    refl = []
    for e in prev[:3]:
        pe = _p(e["pm_end"])
        for t in tools.read_fdc_trace(eqp, cid, _s(pe - timedelta(hours=1)), _s(pe)):
            if t["run_kind"] != "POST_PM":
                continue
            rows, meta = parse_trace(t)
            on = [r["rf_refl"] for r in rows if r["rf_fwd"] and r["rf_fwd"] > 50 and r["rf_refl"] is not None][:6]
            if on:
                refl.append(statistics.median(on))
    trend = round((refl[0] - refl[-1]) / refl[-1] * 100.0, 2) if len(refl) >= 2 else None
    ind = [{"name": "CYCLE_RF_HOURS", "value": hours, "unit": "h", "ref": _s(d0), "change_pct": None},
           {"name": "CYCLE_DAYS", "value": days, "unit": "day", "ref": None, "change_pct": None}]
    if trend is not None:
        ind.append({"name": "REFL_CYCLE_TREND", "value": trend, "unit": "%", "ref": None, "change_pct": trend})
    return {"status": "ok", "signals": {"cycle_rf_hours": hours, "refl_cycle_trend_pct": trend}, "indicators": ind,
            "unavailable": [], "cycle_start": _s(d0), "cycles_seen": len(refl)}
'''
    return src


# ════════════════════════════════════════════════════════════════════
# part_history_agent — 부품이력 Agent (운영 중 Grow, SC-002)
# ════════════════════════════════════════════════════════════════════
def build_part_history(version: str, features: set, changelog: list[str]) -> str:
    unit_conv = "/ 60.0" if "minutes_ok" in features else ""
    join_ok = "minutes_ok" in features or "join_ok" in features
    # 1회차 생성 코드의 엣지 결함 — 정상 입력에선 드러나지 않고 Grow 엣지 케이스 테스트만 잡아낸다 (SC-002)
    naive_code = "naive_code_lookup" in features     # 미등록 부품 코드 → KeyError
    naive_rmv = "naive_rmv_unit" in features         # 제거 부품 사용시간 RMV_USE_MIN(분)을 시간으로 처리 → 60배 과대
    src = _hdr("part_history_agent", version, "부품이력 Agent",
               "레거시 PRT_CHG_HIS(부품 교체 이력)와 CHB_RF_USAGE(일별 RF 사용 분)로 교체 부품 사용시간을 산출하고,\n"
               "Qual 1차 Fail과 부품 사용시간의 관계를 분석한다. 재사용 스킬: legacy_sql_toolkit, code_value_resolver", changelog)
    src += '''from datetime import datetime, timedelta

FMT = "%Y-%m-%d %H:%M:%S"
FR_CODES = {"ETX-300": ["FR01", "FR03"], "ETX-500": ["FR02", "FR04"]}
BUCKETS = [(0, 300), (300, 600), (600, 100000)]


def _p(s):
    return datetime.strptime(str(s).replace("T", " ")[:19], FMT)


def _fr_codes(tools, skills):
    # 코드 사전 + 미등재 코드(FR03·FR04)는 명칭 패턴/교체 동반 PM으로 추론
    known = skills.code_value_resolver.decode_values(tools, "PRT_CD", ["FR01", "FR02", "FR03", "FR04"])
    return [c for c, v in known.items() if (v.get("meaning") or "").startswith("Focus Ring")] + ["FR03", "FR04"]


def _latest(tools, T, eqp, ch, at_s, codes):
    q = tools.query_legacy_db("SELECT CHG_DT, PRT_CD, PRT_LOT_NO, RMV_USE_MIN FROM PRT_CHG_HIS WHERE EQP_ID=:e AND CHB_ID IN "
                              + T.in_list(T.chamber_codes(ch)) + " AND PRT_CD IN " + T.in_list(codes)
                              + " AND CHG_DT <= :t ORDER BY CHG_DT DESC LIMIT 1", {"e": eqp, "t": T.legacy_dt(at_s)})
    return q["rows"][0] if q["rows"] else None


def _hours(tools, T, eqp, ch, chg, at):
    u = tools.query_legacy_db("SELECT SUM(RF_ON_MIN), COUNT(*) FROM CHB_RF_USAGE WHERE EQP_ID=:e AND CHB_ID IN "
                              + T.in_list(T.chamber_codes(ch)) + " AND YMD > :a AND YMD < :b",
                              {"e": eqp, "a": chg.strftime("%Y%m%d"), "b": at.strftime("%Y%m%d")})
    total_min, ndays = u["rows"][0][0] or 0, u["rows"][0][1] or 0
    span = max(1, (at.date() - chg.date()).days - 1)
    if ndays and ndays < span:
        total_min = total_min * span / ndays          # RF 사용 기록 결측일 보간
    return round(total_min ''' + unit_conv + ''', 1), (span - ndays if ndays < span else 0)


def usage(inputs, tools, skills):
    T = skills.legacy_sql_toolkit
    eqp = inputs["eqp_id"]
    ch = inputs["chamber_id"].rsplit("-", 1)[1]
    at = _p(inputs["at"])
    row = _latest(tools, T, eqp, ch, inputs["at"], sorted(set(_fr_codes(tools, skills))))
    if not row:
        return {"status": "unavailable", "signals": {}, "unavailable": ["FR_HOURS"], "note": "Focus Ring 교체 이력 없음"}
    part = row[1]
    known = skills.code_value_resolver.decode_values(tools, "PRT_CD", [part])
    names = {c: v["meaning"] for c, v in known.items() if v and v.get("meaning")}
''' + ('''    part_name = names[part]
''' if naive_code else '''    part_name = names.get(part) or "미해석(" + part + ")"     # 미등록 코드값은 추측하지 않고 그대로 표기
''') + '''    chg = _p(T.fmt_dt(row[0]))
    base = {"status": "ok", "part": part, "part_name": part_name, "lot": row[2], "installed_at": T.fmt_dt(row[0]), "unavailable": []}
    if chg >= at - timedelta(hours=2):
        # 이번 PM에서 교체 — 제거된 부품의 사용시간(PRT_CHG_HIS.RMV_USE_MIN, 분 단위)을 함께 보고
        return dict(base, signals={"fr_hours": 0.0}, removed_part_hours=round((row[3] or 0) ''' + ("" if naive_rmv else "/ 60.0") + ''', 1),
                    note="이번 PM에서 교체")
    hours, missing = _hours(tools, T, eqp, ch, chg, at)
    return dict(base, signals={"fr_hours": hours}, missing_days=missing)


def analyze(inputs, tools, skills):
    """기간·장비군 Qual 1차 Fail ↔ Focus Ring 사용시간 관계"""
    T = skills.legacy_sql_toolkit
    q = tools.query_legacy_db(
        "SELECT h.QH_SEQ, h.EQP_ID, h.CHB_ID, h.PM_END_DT, h.Q1_RSLT_CD, h.Q1_FAIL_ITM FROM QUAL_HIS h"
''' + ('''        " WHERE h.DEL_YN='N' AND h.EQP_ID LIKE :g AND h.PM_END_DT >= :a AND h.PM_END_DT <= :b ORDER BY h.PM_END_DT",''' if join_ok else
        '''        " JOIN PRT_CHG_HIS p ON p.EQP_ID=h.EQP_ID AND p.CHB_ID=h.CHB_ID"
        " WHERE h.EQP_ID LIKE :g AND h.PM_END_DT >= :a AND h.PM_END_DT <= :b AND p.PRT_CD LIKE 'FR%' AND p.CHG_DT >= :a ORDER BY h.PM_END_DT",''') + '''
        {"g": inputs.get("eqp_prefix", "ETCH") + "%", "a": T.legacy_dt(inputs["start"]), "b": T.legacy_dt(inputs["end"]) [:8] + "235959"})
    codes = sorted(set(_fr_codes(tools, skills)))
    cases = []
    for seq, eqp, chb, pm_end, r1, fi in q["rows"]:
        ch = {"1": "A", "2": "B", "3": "C"}.get(chb, chb)
        at_s = T.fmt_dt(pm_end)
        row = _latest(tools, T, eqp, ch, at_s, codes)
        h = None
        if row:
            chg, at = _p(T.fmt_dt(row[0])), _p(at_s)
            h = 0.0 if chg >= at - timedelta(hours=2) else _hours(tools, T, eqp, ch, chg, at)[0]
        cases.append({"qh_seq": seq, "eqp": eqp, "ch": ch, "pm_end": at_s, "pass1": r1 == "P", "fail_items": fi, "fr_hours": h})
    out = []
    for lo, hi in BUCKETS:
        b = [c for c in cases if c["fr_hours"] is not None and lo <= c["fr_hours"] < hi]
        f = [c for c in b if not c["pass1"]]
        out.append({"bucket": str(lo) + "~" + (str(hi) + "h" if hi < 100000 else ""), "n": len(b), "fail": len(f),
                    "rate": round(len(f) / len(b), 3) if b else None})
    fails = [c for c in cases if not c["pass1"]]
    return {"status": "ok", "n_cases": len(cases), "n_fail": len(fails), "buckets": out,
            "unknown_hours": len([c for c in cases if c["fr_hours"] is None]), "cases": cases[:400], "unavailable": []}


def run(action, inputs, tools, skills):
    if action == "usage":
        return usage(inputs, tools, skills)
    if action == "analyze":
        return analyze(inputs, tools, skills)
    raise ValueError("part_history_agent: 알 수 없는 action " + str(action))
'''
    return src


# ════════════════════════════════════════════════════════════════════
# lot_trace_agent — 부품 Lot 추적 Agent (운영 중 일회성 Grow)
# ════════════════════════════════════════════════════════════════════
def build_lot_trace(version: str, features: set, changelog: list[str]) -> str:
    col = "PRT_LOT_ID" if "lot_col_v2" in features else "PRT_LOT_NO"
    src = _hdr("lot_trace_agent", version, "부품Lot추적 Agent",
               "특정 부품 Lot이 장착된 챔버와 장착 이후 Qual 결과를 추적한다. 재사용 스킬: legacy_sql_toolkit", changelog)
    src += '''

def run(action, inputs, tools, skills):
    T = skills.legacy_sql_toolkit
    lot = inputs["lot"]
    q = tools.query_legacy_db("SELECT EQP_ID, CHB_ID, PRT_CD, CHG_DT FROM PRT_CHG_HIS WHERE ''' + col + ''' = :l ORDER BY CHG_DT", {"l": lot})
    out = []
    for eqp, chb, code, dt in q["rows"]:
        ch = {"1": "A", "2": "B", "3": "C"}.get(chb, chb)
        h = tools.query_legacy_db("SELECT COUNT(*), SUM(CASE WHEN Q1_RSLT_CD='F' THEN 1 ELSE 0 END) FROM QUAL_HIS WHERE EQP_ID=:e "
                                  "AND CHB_ID IN " + T.in_list(T.chamber_codes(ch)) + " AND PM_END_DT >= :d AND DEL_YN='N'", {"e": eqp, "d": dt})
        n, f = h["rows"][0]
        out.append({"chamber_id": eqp + "-" + ch, "part": code, "installed_at": T.fmt_dt(dt), "quals_after": n or 0, "fails_after": f or 0})
    return {"status": "ok", "lot": lot, "chambers": out, "n": len(out), "unavailable": []}
'''
    return src
