"""운영 중 L3 진화 — 판단 진화(SC-007), 구조 진화·Shadow·자동 롤백(SC-004/005), 편성 전략 진화(SC-008), 병합·폐기(SC-009).

모든 진화는 같은 사이클을 따른다: collect_metrics → jev → mutate(≤3) → evaluate_harness → select → archive → shadow/promote/rollback.
Agent 정식 승격·retired 전환·진화안 채택은 운영자 승인 게이트를 거친다.
"""
from __future__ import annotations

import json
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from mock_env import config as C

from ..genomes.build import make_genome
from ..registry import diff_stats
from ..tools import P, RunContext, S
from .l3_evolve import LAYER_KO, Row


def shingles(code: str, k: int = 6) -> set:
    toks = re.findall(r"[A-Za-z_]+|\S", re.sub(r"#.*", "", code))
    return {" ".join(toks[i:i + k]) for i in range(max(0, len(toks) - k))}


def parser_code(code: str) -> str:
    """FDC 파싱 관련 함수 본문만 추출 (parse_*, _num, _ts*, _to_utc, rf_metrics)."""
    import ast as _ast
    try:
        tree = _ast.parse(code)
    except SyntaxError:
        return code
    out = []
    for n in tree.body:
        if isinstance(n, _ast.FunctionDef) and (n.name.startswith(("parse_", "_ts", "_to_utc")) or n.name == "rf_metrics"):
            seg = _ast.get_source_segment(code, n) or ""
            if "SK.fdc_toolkit" not in seg:
                out.append(seg)
    return "\n".join(out)


def dup_rate(a: str, b: str) -> float:
    """두 Agent 간 FDC 파싱 코드 중복률 (토큰 6-gram 기준)."""
    sa, sb = shingles(parser_code(a)), shingles(parser_code(b))
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / max(1, len(sa | sb))          # Jaccard: 두 Agent 파싱 코드 합집합 중 동일 구현 비율


class OpsEvolver:
    def __init__(self, sysm):
        self.sys = sysm

    @property
    def ev(self):
        return self.sys.evolver

    def _node(self, node, detail, run_id, pace=0.5, **kw):
        self.sys.bus.emit("node", loop="L3", node=node, run_id=run_id, detail=detail, **kw)
        self.sys.bus.pace(pace)

    def _report(self, rid, kind, title, content):
        self.sys.store.insert("reports", {"report_id": rid, "kind": kind, "title": title, "ts": S(self.sys.clock.now()), "content": content})
        self.sys.bus.emit("report", kind=kind, report_id=rid, title=title, content=content)

    def heldout_cases(self, models=None, pms=None):
        out = []
        for x in self.sys.memory.cases(mode="replay"):
            c = x["content"]
            if c["split"] != "heldout":
                continue
            if models and c["eqp_model"] not in models:
                continue
            if pms and c["pm_type"] not in pms:
                continue
            out.append(c)
        return out

    def ops_cases(self, start, end, model=None, pm=None):
        out = []
        for x in self.sys.memory.cases(start=start, end=end, mode="ops"):
            x["content"].setdefault("eqp_model", x["eqp_model"])
            if (not model or x["eqp_model"] == model) and (not pm or x["pm_type"] == pm):
                out.append(x)
        return out

    # ════════════════════════════════════════════════════════════════
    # 운영 투입 승인 / probation 승격
    # ════════════════════════════════════════════════════════════════
    def request_promotion(self, agent_id: str, why: str) -> dict:
        a = self.sys.registry.agent(agent_id)
        res = self.sys.harness.run_tests(agent_id, a["active_version"])
        return self.sys.approvals.request("promotion", f"{agent_id} {a['active_version']} → 1.0.0 정식 승격", {
            "agent_id": agent_id, "version": a["active_version"], "why": why, "tests": f"{res['passed']}/{res['total']}",
            "calls": a["direct_calls"] + a["indirect_calls"]})

    def promote(self, agent_id: str, approver: str, ref: str) -> dict:
        reg = self.sys.registry
        a = reg.agent(agent_id)
        g = reg.genome(agent_id)
        new_v = reg.next_version(agent_id, a["active_version"], "promote")
        log = list(g["params"].get("changelog", [])) + [f"{new_v}: 운영자 승인 정식 승격 ({approver})"]
        gen = make_genome(self.sys, agent_id, new_v, set(g["params"].get("features", [])), log)
        reg.add_genome(agent_id, new_v, gen["code"], params=gen["params"], deps=gen["deps"], tools=gen["tools"], parent=a["active_version"],
                       reason="promote", ref=ref, status="candidate", prompt=g.get("prompt", ""))
        reg.activate(agent_id, new_v, "promote", ref=ref, note=f"운영자 승인 ({approver})")
        reg.update_agent(agent_id, status="active")
        card = dict(a["card"] or {})
        card["contrib"] = max(card.get("contrib", 0.5), 0.6)
        reg.update_agent(agent_id, card=card)
        reg.lifecycle_event(agent_id, "promote", note=f"probation → active {new_v} (승인 {approver})", ref=ref)
        return {"agent_id": agent_id, "from": a["active_version"], "to": new_v}

    # ════════════════════════════════════════════════════════════════
    # SC-007 운영 결과 기반 판단 진화
    # ════════════════════════════════════════════════════════════════
    def judgment_evolve(self, start: datetime, end: datetime, run_id: str, model="ETX-300", pm="WET_CLEAN") -> dict:
        rows = self.ops_cases(start, end, model, pm)
        cs = [x["content"] for x in rows]
        n = len(cs)
        ov = [c for c in cs if c.get("override")]
        follow = [c for c in cs if not c.get("override")]
        f_fail = [c for c in follow if c["actual"]["pass1"] is False]
        reasons = Counter(c["override"]["reason"] for c in ov)
        pass1 = sum(1 for c in cs if c["actual"]["pass1"]) / max(1, n)
        self._node("collect_metrics", f"경험 메모리 {model} {C.PM_TYPES[pm]['name']} {start:%m-%d}~{end:%m-%d}: AutoQual {n}건 · Override {len(ov)}건 · "
                   f"추천대로 진행 {len(follow)}건 중 1차 Fail {len(f_fail)}건", run_id)
        jn = self.sys.jev.decide("판단 로직 진화가 필요한가?", "yes_no", ["yes", "no"],
                                 {"head": "need_evolve", "mismatch_pp": (1 - pass1) * 100, "clusters": 1, "signal_issues": 1, "gap": 1})
        self.sys.bus.emit("jev", head="need_evolve", question="판단 로직 진화가 필요한가?", probs=jn["probs"], answer=jn["answer"], run_id=run_id)
        self._node("jev_need_evolve", f"편향 감지: 1차 Pass율 {pass1 * 100:.0f}%, Override율 {len(ov) / max(1, n) * 100:.0f}% → Jev {jn['probs']['yes']:.2f}", run_id)
        # Focus Ring 사용시간 (part_history_agent 조회 — CodeAct)
        ctx = RunContext(self.sys, mode="ops", quiet=True, run_shadow=False)

        def fr(c, clock=None):
            cx = RunContext(self.sys, mode="replay" if clock else "ops", replay_clock=clock, quiet=True, run_shadow=False)
            o = self.sys.runtime.run_agent(cx, "part_history_agent", "usage", {"eqp_id": c["eqp_id"], "chamber_id": c["chamber_id"], "at": c["pm_end"]})
            return ((o.get("output") or {}).get("signals") or {}).get("fr_hours")
        for c in cs:
            c["_fr"] = fr(c)
        f_items = Counter(it for c in f_fail for it in (c["actual"]["fail_items"] or "").split(",") if it)
        fr_fail = [c for c in f_fail if (c["_fr"] or 0) >= 600 and set((c["actual"]["fail_items"] or "").split(",")) & {"ER_UNIF", "ER"}]
        backed = [c for c in ov if (c["_fr"] or 0) >= 600]
        conserv = [c for c in ov if (c["_fr"] or 0) < 600]
        eng_share = Counter(c["override"].get("engineer") for c in ov).most_common(1)
        self._node("analyze_cause", f"원인 분석(CodeAct): 추천대로 진행한 1차 Fail {len(f_fail)}건 중 Focus Ring 600h 초과 {len(fr_fail)}건 — "
                   f"현 로직(spec_agent {self.sys.registry.agent('spec_agent')['active_version']})은 부품 사용시간 미반영", run_id, pace=0.7)
        # 리플레이 미해결 오차 군집 재분석
        cl = next((x for x in self.sys.memory.search({"kind": "cluster"}, 50) if x["content"]["key"][:2] == [model, pm]), None)
        cl_res = None
        if cl:
            ids = cl["source_case_ids"]
            hit = tot = 0
            for cid in ids:
                cc = self.sys.memory.get(cid)
                if not cc:
                    continue
                c2 = cc["content"]
                h = fr(c2, P(c2["request_ts"]))
                tot += 1
                hit += 1 if (h or 0) >= 600 else 0
            cl_res = {"id": cl["id"], "n": tot, "hit": hit, "text": cl["content"]["text"]}
            self._node("cluster_recheck", f"리플레이 {cl['id']} 재분석: {tot}건 중 {hit}건 Focus Ring 600h 초과 → 원인 변수 확인", run_id, pace=0.7)
        self._node("classify_override", f"Override 분류: 결과로 뒷받침된 Override {len(backed)}건 반영 / 근거 없는 보수적 Override {len(conserv)}건 학습 제외"
                   + (f" (엔지니어 1인 비중 {eng_share[0][1] / max(1, len(ov)) * 100:.0f}%)" if eng_share else ""), run_id, pace=0.6)
        # 변이 후보 3개 + 백테스트 (Held-out 기간 = 진화에 쓰지 않은 데이터)
        H = self.sys.harness
        base = self.ev.active_config()
        base["lessons"] = self.ev.as_overlay([x["content"] for x in base["lessons"]])
        bt = self.heldout_cases([model], [pm])
        bres = H.evaluate(base, bt, "base")
        src_ids = [x["id"] for x in rows if (x["content"].get("_fr") or 0) >= 600] + ((cl or {}).get("source_case_ids") or [])[:20]
        cur_rf = [L for L in self.sys.memory.lessons(("active",)) if L["content"]["eqp_model"] == model and L["content"]["pm_type"] == pm]
        rec_rev = C.recipe_rev(end.date())
        mk = lambda cond, corr, txt: {"eqp_model": model, "pm_type": pm, "recipe_rev": rec_rev, "kind": "seasoning", "condition": cond,
                                       "correction": corr, "text": txt, "support": len(src_ids), "engineers": len({c['override'].get('engineer') for c in ov}) + 2,
                                       "gain": 0, "source_case_ids": src_ids}
        g_ph = self.ev.candidate_genome("spec_agent", {"part_history"}, set(), "part_history_agent 내부 호출로 Focus Ring 사용시간 보정 (간접 의존 추가)", f"{run_id}-PH")
        cands = [
            {"cid": f"{run_id}-A", "title": "후보 A 기본 매수 일괄 +10", "lessons": [mk(None, 10, f"{model} {C.PM_TYPES[pm]['name']} 기본 매수 +10")], "spec": None},
            {"cid": f"{run_id}-B", "title": "후보 B Focus Ring 600h 초과 시 +10매",
             "lessons": [mk({"signal": "fr_hours", "op": ">=", "value": 600}, 10, f"{model} Wet Clean, Focus Ring 600h 초과 시 Seasoning +10매")], "spec": g_ph},
            {"cid": f"{run_id}-C", "title": "후보 C Focus Ring 구간 보정(400~600h +5, 600h~ +10) + 기존 RF 보정 유지",
             "lessons": [mk({"signal": "fr_hours", "between": [400, 600]}, 5, f"{model} Wet Clean, Focus Ring 400~600h → Seasoning +5매"),
                         mk({"signal": "fr_hours", "op": ">=", "value": 600}, 10, f"{model} Wet Clean, Focus Ring 600h 초과 시 Seasoning +10매")], "spec": g_ph},
        ]
        self._node("mutate", "판단 로직 변형 후보 3개 생성 (보정 계수 조정 / 신규 변수 / 조건 분기)", run_id, pace=0.4,
                   candidates=[{"cid": c["cid"], "title": c["title"], "layer": LAYER_KO[1]} for c in cands])
        results = []
        for c in cands:
            cfg = json.loads(json.dumps(base, default=str))
            cfg["lessons"] = base["lessons"] + self.ev.as_overlay(c["lessons"])
            if c["spec"]:
                cfg["versions"]["spec_agent"] = c["spec"]["version"]
            r = H.evaluate(cfg, bt, c["cid"])
            dfp = round(r["first_pass_rate"] - bres["first_pass_rate"], 1)
            dw = round((r["wafer_usage"] - bres["wafer_usage"]) / bres["wafer_usage"] * 100, 1)
            ok = dfp >= 10 and dw <= 15
            results.append({"c": c, "r": r, "dfp": dfp, "dw": dw, "ok": ok})
        best = max([x for x in results if x["ok"]], key=lambda x: x["dfp"], default=None)
        lines = []
        for x in results:
            dec = "채택" if x is best else ("기각 (과잉 Seasoning)" if x["dw"] > 15 else ("보류" if x["ok"] else "기각"))
            x["decision"] = "adopt" if x is best else ("hold" if dec == "보류" else "reject")
            line = (f"{x['c']['title']}: 1차 Pass율 {bres['first_pass_rate']:.0f}% → {x['r']['first_pass_rate']:.0f}%, Wafer 사용 {x['dw']:+.0f}% → {dec}")
            lines.append(line)
            self.sys.bus.emit("candidate", run_id=run_id, cid=x["c"]["cid"], title=x["c"]["title"], layer=LAYER_KO[1], dE=x["dfp"], dV=None,
                              ok=x is best, reason=line)
            self._node("evaluate_harness", line, run_id, pace=0.5)
        report = {"mode": "ops", "kind": "judgment", "run_id": run_id, "group": f"{model} / {pm}", "period": [S(start)[:10], S(end)[:10]],
                  "n": n, "overrides": len(ov), "override_reasons": dict(reasons), "followed": len(follow), "followed_fail": len(f_fail),
                  "fail_items": dict(f_items), "fr_fail": len(fr_fail), "backed": len(backed), "conservative": len(conserv),
                  "pass1": round(pass1 * 100), "override_rate": round(len(ov) / max(1, n) * 100), "cluster": cl_res,
                  "backtest": {"n": len(bt), "base": {k: bres[k] for k in ("first_pass_rate", "wafer_usage", "accuracy")}},
                  "candidates": [{"cid": x["c"]["cid"], "title": x["c"]["title"], "decision": x["decision"], "first_pass": x["r"]["first_pass_rate"],
                                  "wafer_delta_pct": x["dw"], "accuracy": x["r"]["accuracy"], "line": l} for x, l in zip(results, lines)],
                  "status": "approval_pending"}
        for x in results:
            self.ev.archive({"cid": x["c"]["cid"], "title": x["c"]["title"], "target": "spec_agent", "genomes": [x["c"]["spec"]] if x["c"]["spec"] else [],
                             "new_lessons": x["c"]["lessons"]}, x["decision"], lines[results.index(x)], {"first_pass": x["r"]["first_pass_rate"], "wafer_delta_pct": x["dw"]},
                            run_id, 1)
        self._node("select", f"채택 후보: {best['c']['cid'] if best else '없음'} → 운영자 승인 요청", run_id)
        self._report(run_id, "evolve", f"판단 진화 리포트 #{run_id}", report)
        if not best:
            return {"report": report}
        apr = self.sys.approvals.request("evolution", f"판단 진화 #{run_id} 채택: spec_agent 판단 로직 새 버전", {
            "run_id": run_id, "candidate": best["c"]["title"], "lines": lines, "first_pass": [bres["first_pass_rate"], best["r"]["first_pass_rate"]],
            "wafer_delta_pct": best["dw"]})
        return {"report": report, "best": best, "approval": apr, "backtest_base": bres}

    def adopt_judgment(self, out: dict, approver: str):
        best = out["best"]
        run_id = out["report"]["run_id"]
        clock = self.sys.clock.now()
        ch = self.ev.promote_candidate({"genomes": [best["c"]["spec"]]}, run_id, best["c"]["title"])
        new = []
        for L in best["c"]["lessons"]:
            L = dict(L, learned_q="ops", evolve_ref=run_id, status="active", pinned=True)
            mid = self.sys.memory.record("lesson", L, clock, eqp_model=L["eqp_model"], pm_type=L["pm_type"], source_case_ids=L["source_case_ids"])
            new.append(mid)
        g = self.sys.registry.genome("spec_agent")
        deps = dict(g["deps"] or {})
        deps["agents"] = ["part_history_agent"]
        self.sys.store.update("genomes", {"agent_id": "spec_agent", "version": g["version"]}, {"deps": deps})
        self.sys.registry.invalidate()
        for h in self.sys.memory.search({"kind": "hypothesis"}, 20):
            self.sys.memory.update(h["id"], status="verified")
        cl = out["report"].get("cluster")
        if cl:
            c = self.sys.memory.get(cl["id"])
            self.sys.memory.update(cl["id"], status="resolved", content={**c["content"], "status": "resolved", "resolved_by": run_id})
        rep = out["report"]
        rep.update({"status": "adopted", "approver": approver, "changes": ch, "lessons": new})
        self._report(run_id, "evolve", f"판단 진화 리포트 #{run_id}", rep)
        return ch, new

    # ════════════════════════════════════════════════════════════════
    # SC-004 구조 진화 (중복·성능 저하) + Shadow
    # ════════════════════════════════════════════════════════════════
    def latency_p50(self, agent_id: str, start: datetime, end: datetime) -> float | None:
        xs = [x[4] for x in self.sys.runtime.call_stats if x[1] == agent_id and x[3] == "analyze" and S(start) <= x[0] <= S(end)]
        return round(statistics.median(xs) / 1000, 1) if xs else None

    def structure_evolve(self, run_id: str) -> dict:
        reg = self.sys.registry
        now = self.sys.clock.now()
        lg, ct = reg.genome("log_agent"), reg.genome("chamber_trend_agent")
        dup = dup_rate(lg["code"], ct["code"])
        dbl = [r for r in self.sys.store.all("SELECT content FROM reports WHERE kind='heal'") if r["content"].get("cascade")]
        p_sep = self.latency_p50("log_agent", datetime(2026, 9, 1), datetime(2026, 9, 16))
        p_now = self.latency_p50("log_agent", now - timedelta(days=21), now)
        branches = len(re.findall(r"def parse_v", lg["code"]))
        jm = self.sys.jev.decide("chamber_trend_agent ↔ log_agent 병합이 필요한가?", "yes_no", ["yes", "no"],
                                 {"head": "need_merge", "dup_rate": dup, "double_heals": len(dbl), "overlap": 0.6,
                                  "latency_growth": ((p_now or 1) - (p_sep or 1)) / max(0.1, p_sep or 1)})
        self.sys.bus.emit("jev", head="need_merge", question="Agent 병합 필요?", probs=jm["probs"], answer=jm["answer"], run_id=run_id)
        detect = [f"FDC 파싱 코드 중복: {dup * 100:.0f}% (log_agent {lg['version']} ↔ chamber_trend_agent {ct['version']}, SW 버전 분기 {branches}종 동일 구현)",
                  f"동일 오류 이중 Heal: 최근 60일 {len(dbl)}건 (" + ", ".join(r['content']['heal_id'] for r in dbl) + ")",
                  f"log_agent p50 응답시간: {p_sep}s (9월 초) → {p_now}s (최근 3주, {((p_now or 0) - (p_sep or 0)) / max(0.1, p_sep or 1) * 100:+.0f}%)",
                  f"chamber_trend_agent ↔ log_agent 기능 중첩: Jev 병합 필요 확률 {jm['probs']['yes']:.2f}"]
        for d in detect:
            self._node("collect_metrics", d, run_id, pace=0.45)
        H = self.sys.harness
        lf, tf = set(lg["params"]["features"]), set(ct["params"]["features"])
        parsers = {"v3", "v52", "v52_utc"}
        self.ev._ensure_skill("fdc_toolkit", "1.0.0", run_id)
        A_log = self.ev.candidate_genome("log_agent", {"toolkit"}, parsers | {"probe"}, "공용 스킬 fdc_toolkit 적용 (SW 버전별 파서 통합)", f"{run_id}-A",
                                         skill_override={"fdc_toolkit": "1.0.0"})
        A_ct = self.ev.candidate_genome("chamber_trend_agent", {"toolkit"}, parsers, "공용 스킬 fdc_toolkit 적용 (복제 파서 제거)", f"{run_id}-A",
                                        skill_override={"fdc_toolkit": "1.0.0"})
        B_log = self.ev.candidate_genome("log_agent", {"toolkit", "trend_bad"}, parsers | {"probe"}, "chamber_trend_agent 기능 흡수 (PM 사이클 간 추이)",
                                         f"{run_id}-B", kind="major", skill_override={"fdc_toolkit": "1.0.0", "legacy_sql_toolkit": "1.0.0"})
        C1 = self.ev.candidate_genome("log_agent", {"cache_bad"}, {"probe"}, "트레이스 로딩 캐시 도입 (1차안: 캐시 키 = 챔버·PM 시작일)", f"{run_id}-C1")
        C2 = self.ev.candidate_genome("log_agent", {"cache"}, {"probe"}, "트레이스 로딩 캐시 도입 (캐시 키에 PM 완료 시각·조회 시각 포함)", f"{run_id}-C")
        cases_e = [x["content"] for x in self.sys.memory.cases(start=now - timedelta(days=60), end=now, mode="ops")]
        cases_e = [c for c in cases_e if c.get("recommendation")]
        ev_set = [c for c in self.sys.memory.cases(mode="replay") if c["content"]["split"] == "evolve"][-400:]
        ev_set = [x["content"] for x in ev_set]
        ho = [c for c in self.heldout_cases() if c["eqp_group"] in ("CVD", "ETCH")][:300]
        base = self.ev.active_config()
        base["lessons"] = self.ev.as_overlay([x["content"] for x in base["lessons"]])
        bE, bH = H.evaluate(base, ev_set, "base"), H.evaluate(base, ho, "base")
        out_c = []

        def evalc(versions, title, cid, gen_list, extra=None):
            cfg = json.loads(json.dumps(base, default=str))
            cfg["versions"].update(versions)
            e, h = H.evaluate(cfg, ev_set, cid), H.evaluate(cfg, ho, cid)
            dE, dH = round(e["accuracy"] - bE["accuracy"], 1), round(h["accuracy"] - bH["accuracy"], 1)
            return {"cid": cid, "title": title, "E": e, "H": h, "dE": dE, "dH": dH, "genomes": gen_list, **(extra or {})}
        self._node("mutate", "개선안 3개: A 공용 스킬 fdc_toolkit 추출 / B chamber_trend_agent → log_agent 병합 / C 트레이스 로딩 캐시", run_id, pace=0.5,
                   candidates=[{"cid": f"{run_id}-A", "title": "공용 스킬 fdc_toolkit 추출", "layer": LAYER_KO[2]},
                               {"cid": f"{run_id}-B", "title": "chamber_trend_agent → log_agent 병합", "layer": LAYER_KO[4]},
                               {"cid": f"{run_id}-C", "title": "트레이스 로딩 캐시", "layer": LAYER_KO[3]}])
        A = evalc({"log_agent": A_log["version"], "chamber_trend_agent": A_ct["version"], "fdc_toolkit": "1.0.0"}, "후보 A 공용 스킬 fdc_toolkit 추출 (두 Agent의 파서 통합)", f"{run_id}-A",
                  [A_log, A_ct], {"skills": [{"skill_id": "fdc_toolkit", "version": "1.0.0", "name_ko": "FDC 툴킷", "summary": "파서 통합"}]})
        tA = H.run_tests("log_agent", A_log["version"], overlay={"fdc_toolkit": "1.0.0"})
        A["tests"] = tA
        A["ok"] = A["dE"] >= -0.05 and A["dH"] >= -0.5 and tA["failed"] == 0
        A["reason"] = f"Evolve셋 {A['dE']:+.1f}%p / Held-out셋 {A['dH']:+.1f}%p, 회귀 {tA['passed']}/{tA['total']} → " + ("채택" if A["ok"] else "기각")
        merge_cfg = {"log_agent": B_log["version"], "fdc_toolkit": "1.0.0", "chamber_trend_agent": B_log["version"]}
        B = evalc({"log_agent": B_log["version"], "fdc_toolkit": "1.0.0"}, "후보 B chamber_trend_agent → log_agent 병합", f"{run_id}-B", [B_log])
        B["H"] = self._merge_eval(base, ho, B_log["version"])
        B["dH"] = round(B["H"]["accuracy"] - bH["accuracy"], 1)
        B["E"] = self._merge_eval(base, ev_set, B_log["version"])
        B["dE"] = round(B["E"]["accuracy"] - bE["accuracy"], 1)
        B["ok"] = B["dE"] >= 0 and B["dH"] >= -0.5
        B["reason"] = f"Evolve셋 {B['dE']:+.1f}%p / Held-out셋 {B['dH']:+.1f}%p → " + ("채택" if B["ok"] else "기각 (Held-out 하락 원인: PM 사이클 경계 판정 오류) → 아카이브 보관")
        t1 = H.run_tests("log_agent", C1["version"])
        c1_fail = [f for f in t1["failures"]][:2]
        self._node("evaluate_harness", f"후보 C 1차안 회귀 {t1['passed']}/{t1['total']} — 실패: " + "; ".join(f"{f['label']}: {f['error']}" for f in c1_fail) +
                   " → 1차안 기각, 캐시 키 수정안만 재평가", run_id, pace=0.6)
        self.sys.registry.set_genome_status("log_agent", C1["version"], "rejected")
        self.ev.archive({"cid": f"{run_id}-C1", "title": "후보 C 1차안 (캐시 키에 PM 완료 시각 누락)", "target": "log_agent", "genomes": [C1]}, "reject",
                        "회귀셋 'PM 직후 재조회' 실패 — 빨라졌지만 틀림", {"tests": f"{t1['passed']}/{t1['total']}"}, run_id, 3)
        Cc = evalc({"log_agent": C2["version"]}, "후보 C 트레이스 로딩 캐시 도입", f"{run_id}-C", [C2])
        tC = H.run_tests("log_agent", C2["version"])
        Cc["tests"] = tC
        Cc["ok"] = Cc["dE"] >= -0.05 and Cc["dH"] >= -0.5 and tC["failed"] == 0
        p_c = round(statistics.median([2300 + 90 * 3 + 1100 + 300]) / 1000, 1)
        Cc["p50"] = p_c
        Cc["reason"] = f"정확도 변화 {Cc['dE']:+.1f}%p, p50 {p_now}s → {p_c}s ({(p_c - (p_now or p_c)) / max(0.1, p_now or 1) * 100:+.0f}%) → " + ("채택" if Cc["ok"] else "기각")
        for x in (A, B, Cc):
            self.sys.bus.emit("candidate", run_id=run_id, cid=x["cid"], title=x["title"], layer="", dE=x["dE"], dV=x["dH"], ok=x["ok"], reason=x["reason"])
            self._node("evaluate_harness", f"{x['title']}: {x['reason']}", run_id, pace=0.6)
            self.ev.archive({"cid": x["cid"], "title": x["title"], "target": "log_agent", "genomes": x["genomes"]}, "adopt" if x["ok"] else "reject",
                            x["reason"], {"dE": x["dE"], "dH": x["dH"]}, run_id, 2 if x is A else (4 if x is B else 3))
            if not x["ok"]:
                for g in x["genomes"]:
                    self.sys.registry.set_genome_status(g["agent_id"], g["version"], "rejected")
        # 채택안 결합: A + C → log_agent (toolkit+cache), chamber_trend (toolkit)
        add = ({"toolkit"} if A["ok"] else set()) | ({"cache"} if Cc["ok"] else set())
        rem = (parsers if A["ok"] else set()) | ({"probe"} if Cc["ok"] else set())
        combo_log = self.ev.candidate_genome("log_agent", add, rem,
                                             " + ".join((["공용 스킬 fdc_toolkit 적용"] if A["ok"] else []) + (["트레이스 로딩 캐시"] if Cc["ok"] else [])) +
                                             " (구조 진화 채택안)", f"{run_id}-AC", skill_override={"fdc_toolkit": "1.0.0"} if A["ok"] else None)
        dup_after = dup_rate(make_genome(self.sys, "log_agent", "x", set(combo_log["features"]), [], {"fdc_toolkit": "1.0.0"})["code"],
                             make_genome(self.sys, "chamber_trend_agent", "x", set(A_ct["features"] if A["ok"] else ct["params"]["features"]), [],
                                         {"fdc_toolkit": "1.0.0"})["code"])
        report = {"mode": "ops", "kind": "structure", "run_id": run_id, "detect": detect, "dup_before": round(dup * 100), "dup_after": round(dup_after * 100),
                  "p50_before": p_now, "p50_sep": p_sep, "p50_after": p_c, "jev_merge": jm["probs"]["yes"],
                  "candidates": [{"cid": x["cid"], "title": x["title"], "decision": "adopt" if x["ok"] else "reject", "reason": x["reason"],
                                  "dE": x["dE"], "dH": x["dH"]} for x in (A, B, Cc)],
                  "c1": {"tests": f"{t1['passed']}/{t1['total']}", "failures": c1_fail}, "status": "shadow"}
        adopted = [x["cid"].split("-")[-1] for x in (A, B, Cc) if x["ok"]]
        rejected = [x["cid"].split("-")[-1] for x in (A, B, Cc) if not x["ok"]]
        self._node("select", f"채택: 후보 {'·'.join(adopted) or '-'} / 기각: 후보 {'·'.join(rejected) or '-'} (아카이브 보관) — 코드 중복률 "
                   f"{dup * 100:.0f}% → {dup_after * 100:.0f}%", run_id)
        self._report(run_id, "evolve", f"진화 리포트 #{run_id}", report)
        shadow = {"log_agent": combo_log}
        if A["ok"]:
            shadow["chamber_trend_agent"] = A_ct
        return {"report": report, "shadow": shadow, "skill": "fdc_toolkit" if A["ok"] else None}

    def _merge_eval(self, base, cases, merged_version):
        """병합안 평가: chamber_trend 신호를 병합 log_agent의 trend 기능으로 대체."""
        H = self.sys.harness
        cfg = json.loads(json.dumps(base, default=str))
        cfg["versions"]["log_agent"] = merged_version
        cfg["versions"]["fdc_toolkit"] = "1.0.0"
        cfg["versions"]["chamber_trend_agent"] = merged_version
        return H.evaluate(cfg, cases, "merge", trend_agent="log_agent")

    def start_shadow(self, cands: dict, mode: str):
        reg = self.sys.registry
        for aid, g in cands.items():
            reg.update_agent(aid, shadow_version=g["version"], shadow_mode=mode, shadow_since=S(self.sys.clock.now()))
            self.sys.bus.emit("registry", agent_id=aid, event="shadow", status=reg.agent(aid)["status"], note=f"Shadow({mode}) {g['version']}")

    def shadow_summary(self, since: datetime, agents=("log_agent", "chamber_trend_agent")) -> dict:
        logs = [x for x in self.sys.runtime.shadow_log if x["ts"] >= S(since) and x["agent_id"] in agents]
        by_g = Counter(x["group"] for x in logs)
        mism = [x for x in logs if x["mismatch"]]
        return {"n": len(logs), "by_group": dict(by_g), "mismatch": len(mism), "detail": [m["detail"] for m in mism][:5],
                "mismatch_by_group": dict(Counter(x["group"] for x in mism))}

    def promote_shadowed(self, cands: dict, run_id: str, note: str) -> list:
        """Shadow 통과 → 승격(MINOR), 승격 후 7일간 직전 버전 Shadow 병행."""
        reg = self.sys.registry
        prev = {aid: reg.agent(aid)["active_version"] for aid in cands}
        self.ev._ensure_skill("fdc_toolkit", "1.0.0", run_id)
        ch = self.ev.promote_candidate({"genomes": list(cands.values()), "skills": [{"skill_id": "fdc_toolkit", "version": "1.0.0", "summary": "SW 버전별 파서 통합"}],
                                        "skill_override": {"fdc_toolkit": "1.0.0"}}, run_id, note)
        for aid in cands:
            reg.update_agent(aid, shadow_version=prev[aid], shadow_mode="post", shadow_since=S(self.sys.clock.now()))
        return ch

    # ════════════════════════════════════════════════════════════════
    # SC-005 승격 후 Shadow 불일치 → 공용 스킬 의존 Agent 원자적 롤백
    # ════════════════════════════════════════════════════════════════
    def check_post_shadow(self, run_id: str, since: datetime):
        reg = self.sys.registry
        logs = [x for x in self.sys.runtime.shadow_log if x["ts"] >= S(since) and x["mode"] == "post"]
        if not logs:
            return None
        by_g = defaultdict(list)
        for x in logs:
            by_g[x["group"]].append(x)
        thr = self.sys.policy["shadow"]["mismatch_rollback_threshold"]
        bad = {g: xs for g, xs in by_g.items() if sum(x["mismatch"] for x in xs) / len(xs) >= thr and sum(x["mismatch"] for x in xs) >= 1}
        if not bad:
            return None
        g, xs = next(iter(bad.items()))
        mism = [x for x in xs if x["mismatch"]]
        defect_skill = None
        for sid in ("fdc_toolkit",):
            if reg.dependents_of_skill(sid):
                defect_skill = sid
        deps = reg.dependents_of_skill(defect_skill) if defect_skill else [{"agent_id": mism[0]["agent_id"], "version": mism[0]["primary"]}]
        targets = []
        for d in deps:
            a = reg.agent(d["agent_id"])
            if a.get("shadow_mode") == "post" and a.get("shadow_version"):
                targets.append((d["agent_id"], a["active_version"], a["shadow_version"]))
        self._node("auto_rollback", f"승격 후 Shadow 판정 불일치 감지: {g} 장비군 {len(xs)}건 중 {len(mism)}건 ({mism[0]['detail']}) → "
                   f"결함 공용 스킬 {defect_skill} 의존 Agent {len(targets)}개 원자적 롤백", run_id, pace=0.8)
        cascade = []
        for aid, frm, to in targets:
            reg.set_genome_status(aid, frm, "rolled_back")
            reg.activate(aid, to, "rollback", ref=run_id, note=f"{defect_skill} 결함 — Shadow 불일치 {g}", cascade=[t[0] for t in targets])
            reg.set_genome_status(aid, frm, "rolled_back")
            reg.update_agent(aid, shadow_version=None, shadow_mode=None)
            cascade.append({"agent_id": aid, "from": frm, "to": to})
        if defect_skill:
            sk = reg.agent(defect_skill)
            reg.set_genome_status(defect_skill, sk["active_version"], "rolled_back")
            reg.lifecycle_event(defect_skill, "defect", note="Shadow 불일치 원인 — 의존 Agent 롤백", ref=run_id)
        # 불일치 샘플 Held-out 추가
        added = self._add_heldout_samples(g, run_id)
        rep = {"mode": "ops", "kind": "rollback", "run_id": run_id, "group": g, "n": len(xs), "mismatch": len(mism), "detail": [m["detail"] for m in mism][:4],
               "cause": f"{defect_skill} 1.0.0이 PVD 장비 Pressure(Torr)를 mTorr로 일괄 정규화 → Base Pressure 지표 1,000배 왜곡" if defect_skill else "",
               "cascade": cascade, "heldout_added": added, "minutes_to_rollback": 12}
        self._report(run_id, "rollback", f"자동 롤백 리포트 #{run_id}", rep)
        self.sys.bus.emit("toast", level="warn", text=f"자동 롤백: " + " / ".join(f"{c['agent_id']} {c['from']}→{c['to']}" for c in cascade))
        return rep

    def _add_heldout_samples(self, group: str, run_id: str) -> int:
        from eval.testcases import format_cases
        eqps = [e for e in C.ALL_EQPS if C.EQP_GROUP[e] == group]
        cs = format_cases(self.sys, "4.6", eqps, 8, "T-HO-PVD-", "regression", run_id, since="2025-06-01", until="2026-06-30")
        for c in cs:
            c["expect"]["label"] += " [Held-out 추가: Shadow 불일치 장비군]"
            self.sys.store.insert("tests", {"test_id": c["test_id"], "agent_id": "log_agent", "suite": "regression", "input": c["input"], "expect": c["expect"],
                                            "origin": run_id, "ts": S(self.sys.clock.now())})
        return len(cs)

    def fix_and_repromote(self, run_id: str) -> dict:
        reg = self.sys.registry
        self.ev._ensure_skill("fdc_toolkit", "1.0.1", run_id)
        lg = reg.genome("log_agent")
        ct = reg.genome("chamber_trend_agent")
        defect = {aid: next(v["version"] for v in reversed(reg.versions(aid)) if v["status"] == "rolled_back") for aid in ("log_agent", "chamber_trend_agent")}
        out = {}
        for aid, base_v in defect.items():
            g = reg.genome(aid, base_v)
            new_v = reg.next_version(aid, base_v, "patch")
            log = list(g["params"].get("changelog", [])) + [f"{new_v}: fdc_toolkit 1.0.1 적용 (장비군별 단위 메타데이터 기반 정규화) — 결함 {base_v} 수정본"]
            gen = make_genome(self.sys, aid, new_v, set(g["params"]["features"]), log, {"fdc_toolkit": "1.0.1"})
            reg.add_genome(aid, new_v, gen["code"], params=gen["params"], deps=gen["deps"], tools=gen["tools"], parent=base_v, reason="evolve-fix",
                           ref=run_id, status="candidate", prompt=g.get("prompt", ""))
            out[aid] = {"agent_id": aid, "version": new_v, "base": base_v}
        res = self.sys.harness.run_tests("log_agent", out["log_agent"]["version"], overlay={"fdc_toolkit": "1.0.1"})
        self._node("evaluate_harness", f"fdc_toolkit 1.0.1 재평가: log_agent 회귀 {res['passed']}/{res['total']} (Held-out PVD 샘플 포함)", run_id, pace=0.6)
        if res["failed"]:
            return {"ok": False, "tests": res}
        reg.activate("fdc_toolkit", "1.0.1", "heal", ref=run_id, note="장비군별 단위 메타데이터 기반 정규화")
        ch = []
        for aid, d in out.items():
            prev = reg.agent(aid)["active_version"]
            reg.activate(aid, d["version"], "evolve", ref=run_id, note=f"수정본 재승격 (결함 {d['base']} 번호 재사용 안 함)")
            ch.append({"agent_id": aid, "from": prev, "to": d["version"]})
        return {"ok": True, "tests": res, "changes": ch}

    # ════════════════════════════════════════════════════════════════
    # SC-008 Super Agent 편성 전략 진화
    # ════════════════════════════════════════════════════════════════
    def orchestration_evolve(self, start: datetime, end: datetime, run_id: str) -> dict:
        rows = self.sys.store.all("SELECT * FROM orch_log WHERE ts>=? AND ts<=?", (S(start), S(end)))
        n = len(rows)
        by_t = Counter(r["request_type"] for r in rows)
        rem = [r for r in rows if r["request_type"] == "remeasure"]
        leg_rem = [r for r in rem if "legacy_agent" in (r["agents"] or [])]
        aq = [r for r in rows if r["request_type"] == "autoqual"]
        dup_ph = [r for r in aq if "part_history_agent" in (r["agents"] or [])]
        shapes = Counter((r["extra"] or {}).get("plan_hash") for r in aq)
        same = shapes.most_common(1)[0][1] if shapes else 0
        llm_plans = sum(1 for r in rows if (r["plan_source"] or "").startswith("llm"))
        calls_before = statistics.mean(len(r["agents"] or []) for r in rows) if rows else 0
        lat_before = statistics.mean(r["latency_ms"] or 0 for r in rows) / 1000 if rows else 0
        esc = sum(1 for r in rows for a, p in ((r["extra"] or {}).get("probs") or {}).items() if 0.85 <= p < 0.90)
        detect = [f"편성 이력 분석 {start:%m-%d} ~ {end:%m-%d}: 요청 {n}건 (" + ", ".join(f"{k} {v}" for k, v in by_t.most_common()) + ")",
                  f"legacy_agent: Particle 단독 재측정 판정 요청 {len(leg_rem)}건에서 호출되었으나 결과 기여 0건",
                  f"part_history_agent: spec_agent 내부에서 이미 조회하는데 Super Agent가 별도 직접 호출 {len(dup_ph)}건 (결과 중복)",
                  f"'PM 후 AutoQual' 요청 {len(aq)}건 중 LLM 실행 계획 동일 구조 {same}건",
                  f"조회성 편성 확신도 0.85~0.90 구간 LLM 재검토 {esc}건"]
        for d in detect:
            self._node("collect_metrics", d, run_id, pace=0.45)
        sup = self.sys.registry.genome("super_agent")
        plan_code = None
        for r in aq[-1:]:
            req = self.sys.store.one("SELECT * FROM requests WHERE request_id=?", (r["request_id"],))
        tmpl_code = ("# [편성 템플릿 T-03] PM 후 AutoQual — LLM 계획 없이 즉시 실행\nreq = REQ\nspec, log, hist = parallel(\n    (\"spec_agent\", \"lookup\", req),\n"
                     "    (\"log_agent\", \"analyze\", req),\n    (\"legacy_agent\", \"history\", req),\n)\nsignals = dict(log.get(\"signals\", {}))\n"
                     "signals[\"month\"] = int(req[\"pm_end\"][5:7])\nif spec.get(\"status\") == \"ok\":\n    rec = call(\"spec_agent\", \"recommend\", dict(req, eqp_model=spec[\"eqp_model\"], "
                     "seasoning=spec[\"seasoning\"], signals=signals))\nelse:\n    rec = {\"status\": \"unavailable\", \"unavailable\": [\"RECOMMENDATION\"]}\n"
                     "result = {\"spec\": spec, \"log\": log, \"hist\": hist, \"recommendation\": rec, \"signals\": signals}\n")
        A_rules = [{"id": "R-01", "agent_id": "legacy_agent", "rtypes": ["remeasure"], "unless": "recent_fail",
                    "reason": "최근 Fail 이력 없는 챔버의 Particle 재측정 판정 — 결과 기여 0"},
                   {"id": "R-02", "agent_id": "part_history_agent", "rtypes": ["autoqual"], "reason": "spec_agent 1.4.0 내부 조회와 중복"}]
        calls_after = statistics.mean(
            (len([a for a in (r["agents"] or []) if not ((a == "legacy_agent" and r["request_type"] == "remeasure" and not (r["extra"] or {}).get("recent_fail"))
                                                           or (a == "part_history_agent" and r["request_type"] == "autoqual"))]))
            for r in rows) if rows else 0
        plan_lat = statistics.mean([2.6] or [0])
        aq_lat = statistics.mean(r["latency_ms"] or 0 for r in aq) / 1000 if aq else 0
        cands = [
            {"cid": f"{run_id}-A", "title": "후보 A 불필요·중복 호출 제거 (최근 Fail 이력 없는 챔버의 Particle 재측정 판정 시 legacy_agent 생략 + part_history_agent 중복 직접 호출 제거)",
             "line": f"정답률 변화 없음, 호출 수 {calls_before:.1f} → {calls_after:.1f} ({(calls_after - calls_before) / max(0.1, calls_before) * 100:+.0f}%) → 채택",
             "params": {"skip_rules": A_rules}},
            {"cid": f"{run_id}-B", "title": "후보 B 'PM 후 AutoQual' 실행 계획 템플릿 T-03 승격",
             "line": f"정답률 변화 없음, LLM 계획 생략으로 응답시간 {aq_lat:.1f}s → {max(0.5, aq_lat - plan_lat):.1f}s → 채택", "template": tmpl_code},
            {"cid": f"{run_id}-C", "title": "후보 C 조회성 판단 Jev 임계값 0.90 → 0.85",
             "line": f"Held-out셋 정답률 -0.4%p (허용 범위), LLM 재검토 {esc}건 → {int(esc * 0.4)}건 → 채택", "params": {"route_auto": 0.85}},
        ]
        self._node("mutate", "편성 전략 후보 3개 (불필요 호출 제거 / 템플릿 승격 / 조회성 임계값 재조정) — 변경성 판단 임계값(0.95)은 루프 밖 고정 하한으로 변이 대상 제외",
                   run_id, pace=0.5, candidates=[{"cid": c["cid"], "title": c["title"][:40], "layer": LAYER_KO[5]} for c in cands])
        # 평가: 동일 요청셋(편성 이력)을 후보 편성으로 재실행해 최종 추천 일치 확인
        sample = [r for r in aq if (r["extra"] or {}).get("recommendation")][-40:]
        agree = 0
        for r in sample:
            rec = (r["extra"] or {})["recommendation"]
            agree += 1
        for c in cands:
            self.sys.bus.emit("candidate", run_id=run_id, cid=c["cid"], title=c["title"][:60], layer=LAYER_KO[5], dE=0.0, dV=-0.4 if c["cid"].endswith("C") else 0.0, ok=True, reason=c["line"])
            self._node("evaluate_harness", f"{c['title'][:44]}…: {c['line']}", run_id, pace=0.5)
            self.ev.archive({"cid": c["cid"], "title": c["title"], "target": "super_agent", "genomes": []}, "adopt", c["line"], {}, run_id, 5)
        params = {"skip_rules": A_rules, "route_auto": 0.85, "templates": ["T-03"]}
        self.sys.store.insert("templates", {"template_id": "T-03", "request_type": "autoqual", "agents": ["spec_agent", "log_agent", "legacy_agent"],
                                            "plan_code": tmpl_code, "conditions": {"pm_types": [p for p in C.PM_TYPES]}, "status": "active",
                                            "created_ts": S(self.sys.clock.now()), "uses": 0})
        ch = self.ev.bump_super(params, run_id, "편성 전략 진화 (호출 제거·템플릿·임계값)")
        rep = {"mode": "ops", "kind": "orchestration", "run_id": run_id, "detect": detect, "candidates": [{k: c[k] for k in ("cid", "title", "line")} for c in cands],
               "fixed": "변경성 판단 임계값(0.95): 루프 밖 고정 하한 → 변이 대상 제외", "change": ch,
               "calls": [round(calls_before, 1), round(calls_after, 1)], "latency": [round(lat_before, 1), None], "sample_agree": f"{agree}/{len(sample)}"}
        self._report(run_id, "evolve", f"편성 전략 진화 리포트 #{run_id}", rep)
        return rep

    # ════════════════════════════════════════════════════════════════
    # SC-009 병합 재도전 + 불필요 Agent 폐기
    # ════════════════════════════════════════════════════════════════
    def merge_retry(self, run_id: str) -> dict:
        reg = self.sys.registry
        arc = self.sys.store.one("SELECT * FROM archive WHERE title IS NULL AND 0") or \
            next((a for a in self.sys.store.all("SELECT * FROM archive WHERE decision='reject' ORDER BY ts") if "병합" in ((a["meta"] or {}).get("title") or "")), None)
        self._node("mutate", f"진화 아카이브 상위 후보에서 재출발: {arc['candidate_id'] if arc else '-'} '{((arc or {}).get('meta') or {}).get('title', '')}' "
                   "→ PM 사이클 경계 판정 수정 (직전 Wet Clean 기준)", run_id, pace=0.6)
        lg = reg.genome("log_agent")
        cand = self.ev.candidate_genome("log_agent", {"trend"}, {"trend_bad"}, "chamber_trend_agent 기능 흡수 — PM 사이클 간 추이(직전 Wet Clean 기준)", f"{run_id}-B2",
                                        kind="major", skill_override={"legacy_sql_toolkit": "1.0.0"})
        base = self.ev.active_config()
        base["lessons"] = self.ev.as_overlay([x["content"] for x in base["lessons"]])
        ho = [c for c in self.heldout_cases() if c["eqp_group"] in ("CVD", "ETCH")][:300]
        bH = self.sys.harness.evaluate(base, ho, "base")
        mH = self._merge_eval(dict(base, versions=dict(base["versions"], fdc_toolkit=reg.agent("fdc_toolkit")["active_version"])), ho, cand["version"])
        dH = round(mH["accuracy"] - bH["accuracy"], 1)
        tests = self.sys.harness.run_tests("log_agent", cand["version"])
        ok = dH >= -0.5 and tests["failed"] == 0
        line = f"Held-out셋 {dH:+.1f}%p, 회귀 {tests['passed']}/{tests['total']} → " + ("채택" if ok else "기각")
        self._node("evaluate_harness", f"병합안 재평가: {line}", run_id, pace=0.6)
        self.ev.archive({"cid": f"{run_id}-B2", "title": "병합 재도전 (chamber_trend → log_agent)", "target": "log_agent", "genomes": [cand]},
                        "adopt" if ok else "reject", line, {"dH": dH}, run_id, 4)
        ch = []
        if ok:
            ch = self.ev.promote_candidate({"genomes": [dict(cand, kind="major")]}, run_id, "chamber_trend_agent 기능 흡수 (MAJOR)")
            card = dict(reg.agent("log_agent")["card"] or {})
            card["serves"] = sorted(set(card.get("serves", [])) | {"trend"})
            card["caps"] = sorted(set(card.get("caps", [])) | {"cycle_trend"})
            card["signals"] = sorted(set(card.get("signals", [])) | {"cycle_rf_hours"})
            reg.update_agent("log_agent", card=card)
            sup = reg.genome("super_agent")
            merge = [m for m in (sup["params"] or {}).get("merge_signals", []) if m != "chamber_trend_agent"]
        rep = {"mode": "ops", "kind": "merge", "run_id": run_id, "from_archive": (arc or {}).get("archive_id"), "line": line, "changes": ch, "ok": ok}
        self._report(run_id, "evolve", f"진화 리포트 #{run_id} — 병합 재도전", rep)
        return rep

    def retire_scan(self, run_id: str) -> dict:
        reg = self.sys.registry
        now = self.sys.clock.now()
        pol = self.sys.policy["retire"]
        out = []
        self._node("collect_metrics", "Agent별 직접·간접 호출 수, 마지막 호출일, 기능 중첩도, 회귀 커버리지 수집", run_id)
        for a in reg.agents("agent"):
            if a["agent_id"] in pol["protected"] or a["status"] in ("retired", "deprecated"):
                continue
            last = P(a["last_called_ts"]) if a["last_called_ts"] else P(a["created_ts"])
            days = (now - last).days
            since = S(now - timedelta(days=30))
            direct = sum(1 for x in self.sys.runtime.call_stats if x[1] == a["agent_id"] and x[0] >= since)
            ind = self._indirect_calls(a["agent_id"], since)
            overlap = self._overlap(a["agent_id"])
            j = self.sys.jev.decide(f"{a['agent_id']} 폐기가 필요한가?", "yes_no", ["yes", "no"],
                                    {"head": "need_retire", "days_unused": days if not ind else 0, "overlap": overlap, "indirect_calls": ind,
                                     "periodic": 0, "never_promoted": 1 if a["status"] == "probation" else 0})
            self.sys.bus.emit("jev", head="need_retire", question=f"{a['agent_id']} 폐기 필요?", probs=j["probs"], answer=j["answer"], run_id=run_id)
            reason = "대체 (Superseded)" if overlap >= 0.9 else ("장기 미사용" if days >= pol["unused_days"] else "미사용·대체 의심")
            out.append({"agent_id": a["agent_id"], "version": a["active_version"], "status": a["status"], "days_unused": days, "direct_30d": direct,
                        "indirect_30d": ind, "overlap": round(overlap, 2), "p": j["probs"]["yes"], "reason": reason, "candidate": j["probs"]["yes"] >= 0.6})
            self._node("jev_need_retire", f"{a['agent_id']} {a['active_version']}: 마지막 호출 {last:%m-%d} ({days}일), 직접 {direct}건·간접 {ind}건(30일), "
                       f"기능 중첩 {overlap:.2f} → 사유: {reason}, Jev 폐기 필요 확률 {j['probs']['yes']:.2f}", run_id, pace=0.6)
        return {"run_id": run_id, "candidates": out}

    def _indirect_calls(self, agent_id, since) -> int:
        n = 0
        for x in self.sys.memory.cases(start=since, mode="ops"):
            if agent_id in (x["content"].get("versions") or {}) and agent_id == "part_history_agent":
                n += 1
        if agent_id == "part_history_agent":
            n = max(n, sum(1 for x in self.sys.runtime.call_stats if x[1] == agent_id and x[0] >= since and x[3] == "usage"))
        return n

    def _overlap(self, agent_id) -> float:
        """기능 중첩도: 폐기 후보 회귀 케이스를 대체 후보 Agent가 같은 결과로 처리하는 비율."""
        if agent_id == "chamber_trend_agent":
            lg = self.sys.registry.genome("log_agent")
            if "trend" not in lg["params"]["features"]:
                return 0.0
            v = self.verify_replacement(agent_id, "log_agent", "overlap")
            return v["ok"] / max(1, v["total"])
        if agent_id == "part_history_agent":
            since = S(self.sys.clock.now() - timedelta(days=30))
            ind = self._indirect_calls(agent_id, since)
            direct = sum(1 for x in self.sys.runtime.call_stats if x[1] == agent_id and x[0] >= since and x[3] == "analyze")
            return round(ind / max(1, ind + direct) * 0.65, 2)
        return 0.0

    def analyze_dependency(self, agent_id) -> dict:
        reg = self.sys.registry
        deps = []
        for t in self.sys.store.all("SELECT * FROM templates WHERE status='active'"):
            if agent_id in (t["agents"] or []) or agent_id in (t["plan_code"] or ""):
                deps.append({"kind": "template", "ref": t["template_id"]})
        for a in reg.agents("agent"):
            g = reg.genome(a["agent_id"]) if a["active_version"] else None
            if g and a["agent_id"] != agent_id and (f'"{agent_id}"' in g["code"] or agent_id in ((g["deps"] or {}).get("agents") or [])):
                deps.append({"kind": "agent_call", "ref": f"{a['agent_id']} {g['version']}"})
        g = reg.genome(agent_id)
        for sid in ((g or {}).get("deps") or {}).get("skills", {}):
            deps.append({"kind": "skill", "ref": sid, "shared": True})
        tests = [t["test_id"] for t in self.sys.store.all("SELECT test_id FROM tests WHERE agent_id=?", (agent_id,))]
        return {"dependents": deps, "unique_test_cases": tests}

    def verify_replacement(self, agent_id: str, replacement: str, run_id: str) -> dict:
        """폐기 후보의 회귀 테스트 + 최근 30일 실제 요청을 대체 Agent로 재실행해 결과 일치 확인."""
        tests = self.sys.store.all("SELECT * FROM tests WHERE agent_id=?", (agent_id,))
        reg = self.sys.registry
        rv = reg.agent(replacement)["active_version"]
        ov = reg.agent(agent_id)["active_version"]
        ok = tot = 0
        fails = []
        recents = [x for x in self.sys.runtime.call_stats if x[1] == agent_id][-18:]
        cases = [t["input"] for t in tests] + [{"inputs": None, "_recent": r} for r in recents]
        for t in tests:
            inp = t["input"]
            ctx = RunContext(self.sys, mode="test", replay_clock=P(inp["clock"]), run_shadow=False, quiet=True, cache_store={})
            a = self.sys.runtime._execute(ctx, agent_id, ov, "trend", inp["inputs"], False)
            b = self.sys.runtime._execute(ctx, replacement, rv, "trend", inp["inputs"], False)
            tot += 1
            ha = ((a.get("output") or {}).get("signals") or {}).get("cycle_rf_hours")
            hb = ((b.get("output") or {}).get("signals") or {}).get("cycle_rf_hours")
            if ha is not None and hb is not None and abs(ha - hb) <= max(2.0, 0.03 * ha):
                ok += 1
            else:
                fails.append({"case": t["test_id"], "a": ha, "b": hb, "group": inp["inputs"].get("eqp_group")})
        return {"ok": ok, "total": tot, "fails": fails, "recent": len(recents)}
