"""고정 평가 하네스 — 루프는 호출만 가능하고 수정할 수 없다 (샌드박스 import 차단 + 권한 프록시 밖).

run_tests(agent_id, version, suites)        회귀·신규 포맷·불변식 테스트
evaluate_candidate(candidate, sets)         Evolve셋 / Held-out(검증)셋 / 백테스트 채점
  - 판정 일치율 = 1차 Pass 예측(엔지니어 실제 매수 기준) 일치 ∧ judge_qual 판정 일치
  - 1차 Pass율(반사실) · Wafer 사용량 · 추천 오차 = Mock Fab 시뮬레이터(ground truth) 기반 백테스트
"""
from __future__ import annotations

import sqlite3
import statistics
from datetime import datetime, timedelta
from pathlib import Path

from autoqual.tools import P, RunContext, S
from mock_env.simulator import simulate_qual

from .testcases import check_output

DATA = Path(__file__).resolve().parent.parent / "mock_env" / "data"


class Harness:
    def __init__(self, sysm):
        self.sys = sysm
        self._truth = None

    # ── 테스트 ──────────────────────────────────────────────────────
    def tests_for(self, agent_id: str, suites=("regression", "new_format")) -> list[dict]:
        rows = self.sys.store.all("SELECT * FROM tests WHERE agent_id=? ORDER BY test_id", (agent_id,))
        return [r for r in rows if r["suite"] in suites]

    def run_case(self, case: dict, agent_id: str, version: str, overlay: dict | None = None) -> tuple[bool, str, dict | None]:
        inp = case["input"]
        ov = {agent_id: version, **(overlay or {})}
        cache: dict = {}
        if inp.get("sequence"):
            outs = []
            for clk in inp["sequence"]:
                ctx = RunContext(self.sys, mode="test", replay_clock=P(clk), overlay=ov, run_shadow=False, quiet=True, cache_store=cache,
                                 force_format=inp.get("force_format"))
                r = self.sys.runtime._execute(ctx, agent_id, version, inp["action"], inp["inputs"], False)
                outs.append(r.get("output"))
            ok, why = check_output(outs[-1], case["expect"]["checks"], outs)
            return ok, why, outs[-1]
        ctx = RunContext(self.sys, mode="test", replay_clock=P(inp["clock"]), overlay=ov, run_shadow=False, quiet=True, cache_store=cache,
                         force_format=inp.get("force_format"))
        r = self.sys.runtime._execute(ctx, agent_id, version, inp["action"], inp["inputs"], False)
        if not r["ok"] and r.get("error"):
            return False, f"{r['error']['type']}: {r['error']['message'][:80]}", None
        if r.get("violations"):
            return False, r["violations"][0]["message"], r.get("output")
        ok, why = check_output(r.get("output"), case["expect"]["checks"])
        return ok, why, r.get("output")

    def run_tests(self, agent_id: str, version: str, suites=("regression", "new_format"), overlay=None, extra: list | None = None,
                  on_case=None) -> dict:
        cases = self.tests_for(agent_id, suites) + list(extra or [])
        passed, failures = 0, []
        by_suite: dict[str, list[int]] = {}
        for c in cases:
            ok, why, _ = self.run_case(c, agent_id, version, overlay)
            s = by_suite.setdefault(c["suite"], [0, 0])
            s[1] += 1
            if ok:
                passed += 1
                s[0] += 1
            else:
                failures.append({"case": c["test_id"], "label": c["expect"].get("label"), "sw": c["expect"].get("sw"), "error": why})
            if on_case:
                on_case(c, ok, why)
        return {"passed": passed, "failed": len(failures), "total": len(cases), "failures": failures, "by_suite": by_suite}

    # ── ground truth (하네스 전용) ────────────────────────────────────
    def truth_by_qh(self) -> dict:
        if self._truth is None:
            con = sqlite3.connect(f"file:{(DATA / 'ground_truth.db').as_posix()}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            self._truth = {}
            for r in con.execute("SELECT * FROM EVENT_TRUTH WHERE QH_SEQ IS NOT NULL"):
                self._truth[r["QH_SEQ"]] = self.sys.world._row_truth(r)
            con.close()
        return self._truth


# ── Grow 테스트 — part_history_agent (SC-002: 정상 + 엣지) ──────────────
DEFAULT_NORMAL = ["ETCH-03-A", "ETCH-01-A", "ETCH-04-B", "ETCH-07-C", "ETCH-10-A"]


def _part_history_tests(self, g, ctx, clock, con, agent_id, version) -> list[dict]:
    """part_history_agent: 정상 케이스(자체) + 하네스 불변식 + 스키마 탐색 기반 엣지 케이스.

    엣지 케이스 입력은 Factory가 스키마 탐색으로 고르고(test_plan), 기대값(오라클)은 하네스가 원본 DB로 직접 계산한다.
    """
    run = lambda inp, action="usage", c=None: self.sys.runtime._execute(ctx(c or clock), agent_id, version, action, inp, False)
    why = lambda r: ((r.get("error") or {}).get("type", "") + ": " + ((r.get("error") or {}).get("message") or "")
                     if r.get("error") else "; ".join(v["message"] for v in r.get("violations") or []))[:90]
    plan = g.get("test_plan") or {"normal": DEFAULT_NORMAL, "edges": {}}
    out = []
    # ── 정상 케이스: 코드 사전에 등재된 Focus Ring 챔버의 사용시간 조회
    hrs = []
    for cid in plan["normal"]:
        r = run({"eqp_id": cid[:-2], "chamber_id": cid, "at": S(clock)})
        o = r.get("output") or {}
        h = (o.get("signals") or {}).get("fr_hours")
        ok = r["ok"] and o.get("status") == "ok" and h is not None
        out.append({"suite": "unit", "name": f"정상: {cid} 사용시간 조회", "ok": ok, "detail": f"{h}h ({o.get('part_name', '')})" if ok else why(r)})
        if ok:
            hrs.append(h)
    # ── 하네스 불변식 (루프 밖 고정)
    bad = [h for h in hrs if not (0 <= h <= 5000)]
    out.append({"suite": "invariant", "name": "불변식: 단위 범위 (사용시간 0~5,000h)", "ok": bool(hrs) and not bad,
                "detail": f"표본 {len(hrs)}건, 범위 밖 {len(bad)}건" + (f" (예: {bad[0]:,.0f}h — 분/시간 단위 의심)" if bad else "")})
    per = (g.get("request") or {}).get("period") or {"start": "2026-04-01", "end": "2026-06-30"}
    prefix = ((g.get("request") or {}).get("entities") or {}).get("eqp_prefix", "ETCH")
    a = run({"eqp_prefix": prefix, "start": per["start"], "end": per["end"]}, "analyze")
    ao = a.get("output") or {}
    oracle = con.execute("SELECT COUNT(*) FROM QUAL_HIS WHERE DEL_YN='N' AND EQP_ID LIKE ? AND PM_END_DT>=? AND PM_END_DT<=? AND Q1_RSLT_CD='F'",
                         (prefix + "%", per["start"].replace("-", "") + "000000", per["end"].replace("-", "") + "235959")).fetchone()[0]
    out.append({"suite": "invariant", "name": "불변식: 행 수 대조 (legacy_agent 집계)", "ok": a["ok"] and ao.get("n_fail") == oracle,
                "detail": f"분석 대상 1차 Fail {ao.get('n_fail')}건 = legacy_agent 집계 {oracle}건 {'일치' if ao.get('n_fail') == oracle else '불일치'}"})
    lo, hi = per["start"] + " 00:00:00", per["end"] + " 23:59:59"
    outside = [c for c in ao.get("cases", []) if not (lo <= str(c.get("pm_end") or lo) <= hi)]
    out.append({"suite": "invariant", "name": "불변식: 기간 경계", "ok": a["ok"] and not outside,
                "detail": f"{per['start']} ~ {per['end']} 경계 밖 {len(outside)}건"})
    # ── 엣지 케이스 (스키마 탐색 결과에서 도출)
    e = plan.get("edges") or {}
    if "unknown_code" in e:
        x = e["unknown_code"]
        r = run({"eqp_id": x["chamber_id"][:-2], "chamber_id": x["chamber_id"], "at": S(clock)})
        o = r.get("output") or {}
        ok = r["ok"] and o.get("status") == "ok" and "미해석" in str(o.get("part_name"))
        out.append({"suite": "edge", "name": "엣지: 미등록 부품 코드", "ok": ok,
                    "detail": f"{x['code']} → '{o.get('part_name')}' 표기" if ok else (why(r) or f"part_name={o.get('part_name')}")})
    if "no_history" in e:
        x = e["no_history"]
        r = run({"eqp_id": x["chamber_id"][:-2], "chamber_id": x["chamber_id"], "at": S(clock)})
        o = r.get("output") or {}
        ok = r["ok"] and o.get("status") == "unavailable"
        out.append({"suite": "edge", "name": "엣지: 교체 이력 0건 챔버", "ok": ok,
                    "detail": f"{x['chamber_id']} → 확인 불가 표기 (예외 없음)" if ok else (why(r) or f"status={o.get('status')}")})
    if "unit_mix" in e:
        x = e["unit_mix"]
        at = datetime.strptime(str(x["chg_dt"]), "%Y%m%d%H%M%S") + timedelta(hours=1)
        r = run({"eqp_id": x["chamber_id"][:-2], "chamber_id": x["chamber_id"], "at": S(at)})
        v = (r.get("output") or {}).get("removed_part_hours")
        exp = x["rmv_min"] / 60
        ok = r["ok"] and v is not None and abs(v - exp) <= 1
        ratio = f" — {v / exp:.0f}배 과대" if v and exp and v / exp > 5 else ""
        out.append({"suite": "edge", "name": "엣지: 분/시간 단위 혼재", "ok": ok,
                    "detail": (f"제거 부품 사용시간 {v:,.0f}h (기대 {exp:,.0f}h){ratio}" if v is not None else why(r) or "removed_part_hours 없음")})
    if "boundary" in e:
        x = e["boundary"]
        chg = datetime.strptime(str(x["chg_dt"]), "%Y%m%d%H%M%S")
        at = datetime(chg.year, chg.month, chg.day, 12) + timedelta(days=1)
        r = run({"eqp_id": x["chamber_id"][:-2], "chamber_id": x["chamber_id"], "at": S(at)}, c=max(clock, at))
        o = r.get("output") or {}
        h = (o.get("signals") or {}).get("fr_hours")
        ok = r["ok"] and o.get("installed_at") == S(chg) and h is not None and 0 <= h <= 48
        out.append({"suite": "edge", "name": "엣지: 분기 경계일 교체", "ok": ok,
                    "detail": f"{S(chg)[:10]} 교체 → 다음날 사용시간 {h}h" if ok else (why(r) or f"installed_at={o.get('installed_at')}, {h}h")})
    if "soft_delete" in e:
        x = e["soft_delete"]
        y, m = int(x["month"][:4]), int(x["month"][4:6])
        start = f"{y}-{m:02d}-01"
        end = S(datetime(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))[:10]
        r = run({"eqp_prefix": "ETCH", "start": start, "end": end}, "analyze")
        o = r.get("output") or {}
        n_or = con.execute("SELECT COUNT(*) FROM QUAL_HIS WHERE DEL_YN='N' AND EQP_ID LIKE 'ETCH%' AND PM_END_DT>=? AND PM_END_DT<=?",
                           (start.replace("-", "") + "000000", end.replace("-", "") + "235959")).fetchone()[0]
        keys = [(c["eqp"], c["ch"], c["pm_end"]) for c in o.get("cases", [])]
        ok = r["ok"] and o.get("n_cases") == n_or and len(keys) == len(set(keys))
        out.append({"suite": "edge", "name": "엣지: 소프트 삭제 중복 행", "ok": ok,
                    "detail": f"{x['month']} 삭제 표시 중복 {x['dup_rows']}행 제외 → {o.get('n_cases')}건 = 원장 {n_or}건" if r["ok"] else why(r)})
    if "missing" in e:
        x = e["missing"]
        r = run({"eqp_id": x["chamber_id"][:-2], "chamber_id": x["chamber_id"], "at": S(clock)})
        o = r.get("output") or {}
        h = (o.get("signals") or {}).get("fr_hours")
        ok = r["ok"] and o.get("status") == "ok" and h is not None and 0 < h <= 5000
        out.append({"suite": "edge", "name": "엣지: 사용시간 결측", "ok": ok,
                    "detail": f"{x['chamber_id']} 결측 {o.get('missing_days', '?')}일 보간 → {h}h" if ok else (why(r) or f"{h}h")})
    return out


# ── Grow 불변식 테스트 (하네스 고정) ──────────────────────────────────
def _grow_invariants(self, agent_id: str, version: str, g: dict) -> list[dict]:
    clock = P(g["clock"])
    ov = {agent_id: version}
    ctx = lambda c=clock: RunContext(self.sys, mode="test", replay_clock=c, overlay=ov, run_shadow=False, quiet=True, cache_store={})
    out = []
    con = sqlite3.connect(f"file:{self.sys.world.legacy_path.as_posix()}?mode=ro", uri=True)
    if agent_id == "part_history_agent":
        out += _part_history_tests(self, g, ctx, clock, con, agent_id, version)
    elif agent_id == "lot_trace_agent":
        lot = ((g.get("request") or {}).get("entities") or {}).get("lot", "FRL-2408-117")
        r = self.sys.runtime._execute(ctx(), agent_id, version, "trace", {"lot": lot}, False)
        o = r.get("output") or {}
        out.append({"name": "자체 테스트: Lot 조회", "ok": r["ok"] and o.get("status") == "ok",
                    "detail": f"장착 챔버 {o.get('n')}개" if r["ok"] else (r.get("error") or {}).get("message", "")[:80]})
        try:
            oracle = con.execute("SELECT COUNT(*) FROM PRT_CHG_HIS WHERE PRT_LOT_NO=?", (lot,)).fetchone()[0]
        except sqlite3.OperationalError:
            oracle = None
        out.append({"name": "불변식: 행 수 대조 (PRT_CHG_HIS)", "ok": r["ok"] and o.get("n") == oracle, "detail": f"{o.get('n')} vs {oracle}"})
    elif agent_id == "chamber_trend_agent":
        rows = [x for x in self.sys.memory.cases(end=clock, mode="replay") if x["content"]["eqp_group"] == "CVD"][-12:]
        vals, errs = [], []
        for x in rows:
            c = x["content"]
            inp = {"eqp_id": c["eqp_id"], "chamber_id": c["chamber_id"], "pm_end": c["pm_end"], "eqp_group": "CVD"}
            rr = self.sys.runtime._execute(ctx(P(c["pm_end"])), agent_id, version, "trend", inp, False)
            h = ((rr.get("output") or {}).get("signals") or {}).get("cycle_rf_hours")
            if rr["ok"] and h is not None:
                vals.append(h)
            elif not rr["ok"]:
                errs.append((rr.get("error") or {}).get("message", "")[:60])
        out.append({"name": "자체 테스트: CVD 사이클 추이 산출", "ok": len(vals) >= max(1, len(rows) // 2),
                    "detail": f"{len(vals)}/{len(rows)}건 산출" + (f", 오류 {errs[0]}" if errs else "")})
        bad = [v for v in vals if not (0 <= v <= 5000)]
        out.append({"name": "불변식: 단위 범위 (RF 누적 0~5,000h)", "ok": not bad and bool(vals), "detail": f"범위 밖 {len(bad)}건"})
    con.close()
    return out


Harness.grow_invariants = _grow_invariants


# ── 후보 평가 (evaluate_candidate) ────────────────────────────────────
def _hist_suggest(hist, count):
    from autoqual.super_agent import history_suggestion
    return history_suggestion(hist, count)


def _evaluate(self, config: dict, cases: list[dict], label: str = "", trend_agent: str = "chamber_trend_agent") -> dict:
    """config: {"versions": {agent: ver}, "lessons": [...], "merge": [...], "with_part": bool}
    cases: 리플레이·운영 case content 목록. 결과 지표는 루프가 조작할 수 없는 ground truth로 계산한다."""
    from autoqual.judge import judge_qual
    truth = self.truth_by_qh()
    ver = dict(config.get("versions") or {})
    reg = self.sys.registry
    act = {a["agent_id"]: a["active_version"] for a in reg.agents(None)}
    cur = {k: ver.get(k, act.get(k)) for k in ("spec_agent", "log_agent", "legacy_agent", "chamber_trend_agent", "part_history_agent",
                                                "code_value_resolver", "seasoning_pass_curve", "fdc_toolkit", "legacy_sql_toolkit")}
    if trend_agent not in cur:
        cur[trend_agent] = ver.get(trend_agent, act.get(trend_agent))
    merge = config.get("merge") or ["log_agent"]
    lessons = config.get("lessons")
    cache = self.__dict__.setdefault("_ecache", {})
    unit_conv = self.sys.world.unit_conversions()
    n = ok_pred = ok_judge = ok_all = fp = unav = 0
    wafers, errs, lat = [], [], []
    per_group: dict = {}
    for c in cases:
        qh = c.get("qh_seq") or (c.get("actual") or {}).get("qh_seq")
        t = truth.get(qh)
        if t is None or not c.get("recommendation"):
            continue
        rclk = P(c["request_ts"])
        sig = dict(c.get("signals") or {})
        base_inp = {"eqp_id": c["eqp_id"], "chamber_id": c["chamber_id"], "pm_type": c["pm_type"], "pm_start": c["pm_start"],
                    "pm_end": c["pm_end"], "eqp_group": c["eqp_group"], "eqp_model": c["eqp_model"]}
        ctx_ov = {k: v for k, v in cur.items() if v}

        def run(agent, action, inp, clock):
            key = (agent, cur[agent], action, qh, str(sorted((k, v) for k, v in ctx_ov.items() if k in ("code_value_resolver", "fdc_toolkit", "seasoning_pass_curve"))))
            if key not in cache:
                ctx = RunContext(self.sys, mode="replay", replay_clock=clock, overlay=ctx_ov, run_shadow=False, quiet=True, cache_store={})
                r = self.sys.runtime._execute(ctx, agent, cur[agent], action, inp, False)
                cache[key] = (r["output"] if r["ok"] else None, ctx.io_ms + r.get("elapsed_ms", 0))
            return cache[key]

        io = 0.0
        if cur["log_agent"] != (c.get("versions") or {}).get("log_agent"):
            out, ms = run("log_agent", "analyze", base_inp, rclk)
            io = max(io, ms)
            sig = {k: v for k, v in sig.items() if k in ("month", "recipe_rev", "cycle_rf_hours", "fr_hours")}
            if out:
                sig.update(out.get("signals") or {})
        if ("chamber_trend_agent" in merge or trend_agent != "chamber_trend_agent") and cur.get(trend_agent) \
                and c["eqp_group"] in ("CVD", "PVD") and c["pm_type"] in ("QUARTERLY_PM", "PUMP_PM", "ALARM_RECOVERY"):
            out, ms = run(trend_agent, "trend", base_inp, rclk)
            io = max(io, ms)
            if out:
                sig.update(out.get("signals") or {})
        elif "chamber_trend_agent" not in merge:
            sig.pop("cycle_rf_hours", None)
        hist = c.get("history") or {}
        if cur["legacy_agent"] != (c.get("versions") or {}).get("legacy_agent") or config.get("rerun_history"):
            out, ms = run("legacy_agent", "history", dict(base_inp, limit=8), rclk)
            io = max(io, ms)
            hist = out or {}
        if "rf_refl_delta_pct" not in sig and c["eqp_group"] != "PVD":
            unav += 1
        spec = self.sys.world.query_spec(c["eqp_model"], c["pm_type"], rclk.date())
        rec_inp = dict(base_inp, seasoning=spec["seasoning"], signals=sig)
        ctx = RunContext(self.sys, mode="replay", replay_clock=rclk, overlay=ctx_ov, run_shadow=False, quiet=True,
                         lesson_overlay=lessons, cache_store={})
        r = self.sys.runtime._execute(ctx, "spec_agent", cur["spec_agent"], "recommend", rec_inp, False)
        rec = r["output"] if r["ok"] else None
        if rec is None:
            continue
        count, req = rec["count"], rec["required_est"]
        hs = _hist_suggest(hist, count)
        if hs:
            count = req = hs["count"]
        wait = any("대기" in x["step"] for x in rec.get("extra_steps", []))
        a = c["actual"]
        n1 = a["n1"]
        outlier = n1 is None or not (3 <= n1 <= 120)
        pred_ok = (not outlier) and ((n1 >= req) == a["pass1"])
        judge_ok = (c.get("match") or {}).get("judge", True)
        if cur["legacy_agent"] != (c.get("versions") or {}).get("legacy_agent") or ver.get("code_value_resolver"):
            mo, _ = run("legacy_agent", "measurements", {"qh_seq": qh, "meas_seq": 1}, P(c["meas_ts"]))
            j = judge_qual(spec["procedure_id"], spec["specs"], (mo or {}).get("measurements", []), unit_conv)
            judge_ok = j["result"] == ("PASS" if a["pass1"] else "FAIL")
        cf = simulate_qual(t, count, wait, 1)
        n += 1
        ok_pred += pred_ok
        ok_judge += judge_ok
        ok_all += pred_ok and judge_ok
        fp += cf["passed"]
        wafers.append(count)
        errs.append(abs(req - t.R))
        lat.append(io + 300)
        g = per_group.setdefault(f"{c['eqp_model']}|{c['pm_type']}", [0, 0])
        g[0] += 1
        g[1] += pred_ok and judge_ok
    if not n:
        return {"n": 0}
    lat.sort()
    return {"n": n, "label": label, "accuracy": round(ok_all / n * 100, 2), "pred_acc": round(ok_pred / n * 100, 2),
            "judge_acc": round(ok_judge / n * 100, 2), "first_pass_rate": round(fp / n * 100, 2),
            "wafer_usage": round(statistics.mean(wafers), 2), "rec_error": round(statistics.mean(errs), 2),
            "latency_p50": lat[len(lat) // 2], "unavailable": unav, "per_group": per_group}


Harness.evaluate = _evaluate


def _capture_trend_golden(self, agent_id: str, version: str, n: int = 36):
    """chamber_trend 계열 골든 회귀 케이스 (생성·채택 시 검수된 출력으로 갱신)."""
    self.sys.store.con.execute("DELETE FROM tests WHERE agent_id=? AND suite='regression'", (agent_id,))
    rows = [x["content"] for x in self.sys.memory.cases(mode="replay") if x["content"]["eqp_group"] == "CVD"
            and x["content"]["pm_type"] in ("QUARTERLY_PM", "PUMP_PM", "ALARM_RECOVERY")]
    rows = rows[:: max(1, len(rows) // n)][:n]
    made = 0
    for c in rows:
        inp = {"eqp_id": c["eqp_id"], "chamber_id": c["chamber_id"], "pm_end": c["pm_end"], "eqp_group": c["eqp_group"], "pm_type": c["pm_type"]}
        ctx = RunContext(self.sys, mode="test", replay_clock=P(c["request_ts"]), overlay={agent_id: version}, run_shadow=False, quiet=True, cache_store={})
        r = self.sys.runtime._execute(ctx, agent_id, version, "trend", inp, False)
        h = ((r.get("output") or {}).get("signals") or {}).get("cycle_rf_hours")
        if h is None:
            continue
        made += 1
        self.sys.store.insert("tests", {"test_id": f"T-CT-{made:03d}", "agent_id": agent_id, "suite": "regression",
                                        "input": {"action": "trend", "inputs": inp, "clock": c["request_ts"]},
                                        "expect": {"label": f"{c['chamber_id']} {c['pm_type']} {c['pm_end'][:10]} (사이클 추이)", "sw": None,
                                                   "checks": [{"type": "indicator_close", "name": "CYCLE_RF_HOURS", "value": h, "tol": max(1.0, 0.01 * h)}]},
                                        "origin": f"{agent_id}@{version}", "ts": S(self.sys.clock.now())})
    return made


Harness.capture_trend_golden = _capture_trend_golden
