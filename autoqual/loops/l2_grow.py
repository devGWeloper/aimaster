"""L2 Grow Loop — Agent Factory (최대 5회·15분).

search_archive ─(유사 Genome)→ restore_genome → run_tests
               └(없음)→ write_spec → explore_schema → generate_code_and_tests → run_tests
run_tests(자체 테스트(정상 + 스키마 탐색 기반 엣지) + 하네스 불변식: 행 수 대조·단위 범위·기간 경계) ─통과→ register_probation → L1 복귀
                                                                 ─실패→ generate_code_and_tests / 예산 소진 → abort_with_reason
"""
from __future__ import annotations

import time
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from ..genomes.build import TOOLS, make_genome
from ..registry import diff_stats
from ..sandbox import ToolProxy
from ..tools import P, RunContext, S, make_tools

BLUEPRINTS = {
    "part_usage": {
        "agent_id": "part_history_agent", "name_ko": "부품이력 Agent",
        "spec": {"role": "부품 교체 이력 조회, 교체 부품 사용시간 산출, Qual 1차 Fail과 부품 사용시간 관계 분석",
                 "inputs": "eqp_id·chamber_id·at(시점) / 기간·장비군", "outputs": "fr_hours(h), 사용시간 구간별 1차 Fail율",
                 "data_sources": ["PRT_CHG_HIS (부품 교체 이력, 미사용 테이블)", "CHB_RF_USAGE (일별 RF 사용 분)", "QUAL_HIS"],
                 "skills": ["legacy_sql_toolkit", "code_value_resolver"]},
        "attempts": [{"features": {"join_ok", "minutes_ok", "naive_code_lookup", "naive_rmv_unit"}, "note": "1회차"},
                     {"features": {"join_ok", "minutes_ok"}, "note": "2회차: 분→시간 환산, 미등록 코드 '미해석' 표기 수정"}],
        "card": {"serves": ["analysis", "autoqual"], "caps": ["part_usage", "part_history"], "groups": ["ETCH"],
                 "pm_types": ["WET_CLEAN", "QUARTERLY_PM"], "keywords": ["부품", "사용시간", "Focus Ring"], "contrib": 0.5, "bias": -0.2,
                 "signals": ["fr_hours"]},
        "explore": ("PRT%", "PRT_CD"),
    },
    "part_lot_trace": {
        "agent_id": "lot_trace_agent", "name_ko": "부품Lot추적 Agent",
        "spec": {"role": "특정 부품 Lot 장착 챔버와 장착 이후 Qual 결과 추적", "inputs": "lot", "outputs": "장착 챔버 목록·이후 Qual/Fail 건수",
                 "data_sources": ["PRT_CHG_HIS", "QUAL_HIS"], "skills": ["legacy_sql_toolkit"]},
        "attempts": [{"features": set(), "note": "1회차"}],
        "card": {"serves": ["lot_trace"], "caps": ["part_lot_trace"], "keywords": ["Lot", "로트"], "contrib": 0.5, "bias": 0.4, "signals": []},
        "explore": ("PRT%", "PRT_LOT_NO"),
    },
    "cycle_trend": {
        "agent_id": "chamber_trend_agent", "name_ko": "챔버추이 Agent",
        "spec": {"role": "PM 사이클 간 장기 추이: 직전 Wet Clean 이후 RF 누적시간, 사이클별 PM 직후 RF Reflected 추이",
                 "inputs": "eqp_id·chamber_id·pm_end", "outputs": "cycle_rf_hours(h), refl_cycle_trend_pct",
                 "data_sources": ["PM_EVENT", "CHB_RF_USAGE", "FDC 트레이스 (log_agent 파서 복제)"], "skills": ["legacy_sql_toolkit"]},
        "attempts": [{"features": set(), "note": "1회차"}],
        "card": {"serves": ["autoqual", "trend"], "caps": ["cycle_trend"], "groups": ["CVD", "PVD"],
                 "pm_types": ["QUARTERLY_PM", "PUMP_PM", "ALARM_RECOVERY"], "keywords": ["사이클", "추이", "drift"], "contrib": 0.6,
                 "bias": -0.73, "signals": ["cycle_rf_hours"]},
        "explore": ("CHB%", "RF_ON_MIN"),
    },
}

EXPLORE_CODE = '''# [스키마 탐색 CodeAct] 대상 테이블·코드값 의미 파악 + 엣지 케이스 후보 수집 (읽기 전용)
from datetime import datetime, timedelta
tabs = tools.inspect_legacy_schema(PATTERN, 3)
info = []
for t in tabs:
    info.append({"table": t["table"], "rows": t["row_count"], "cols": [c["name"] for c in t["columns"]][:10],
                 "last_loaded_at": t["last_loaded_at"]})
codes, normal, edges = {}, [], {}
if COLUMN == "PRT_CD":
    q = tools.query_legacy_db("SELECT PRT_CD, COUNT(*) FROM PRT_CHG_HIS GROUP BY PRT_CD ORDER BY PRT_CD")
    vals = [r[0] for r in q["rows"]]
    res = tools.resolve_code_value("PRT_CHG_HIS", "PRT_CD", vals)
    codes = {"total": len(vals), "documented": len([v for v in vals if res[v]]), "undocumented": [v for v in vals if not res[v]]}
    CH = {"1": "A", "2": "B", "3": "C"}
    doc_fr = "('" + "','".join(v for v in vals if v.startswith("FR") and res[v]) + "')"
    # 챔버별 최근 Focus Ring 교체 코드 → 사전 등재 코드 = 정상 케이스, 미등록 코드 = 엣지
    latest = {}
    for e, c, cd, dt in tools.query_legacy_db("SELECT EQP_ID, CHB_ID, PRT_CD, MAX(CHG_DT) FROM PRT_CHG_HIS "
                                              "WHERE PRT_CD LIKE 'FR%' GROUP BY EQP_ID, CHB_ID")["rows"]:
        cid = e + "-" + CH.get(c, c)
        if cid not in latest or dt > latest[cid][1]:
            latest[cid] = (cd, dt)
    documented = [cid for cid in sorted(latest) if res[latest[cid][0]]]
    normal = documented[:5]
    undoc = [cid for cid in sorted(latest) if not res[latest[cid][0]]]
    if undoc:
        edges["unknown_code"] = {"chamber_id": undoc[0], "code": latest[undoc[0]][0]}
    # 교체 이력 0건 장비
    z = tools.query_legacy_db("SELECT DISTINCT EQP_ID FROM QUAL_HIS WHERE EQP_ID NOT IN "
                              "(SELECT EQP_ID FROM PRT_CHG_HIS WHERE PRT_CD LIKE 'FR%') ORDER BY EQP_ID LIMIT 1")
    if z["rows"]:
        edges["no_history"] = {"chamber_id": z["rows"][0][0] + "-A"}
    # 분/시간 단위 혼재 — 원천은 분(_MIN) 컬럼, 출력은 시간(h)
    mins = [c["name"] for x in tabs + tools.inspect_legacy_schema("CHB_RF%", 1) for c in x["columns"] if c["name"].endswith("_MIN")]
    u = tools.query_legacy_db("SELECT EQP_ID, CHB_ID, CHG_DT, RMV_USE_MIN FROM PRT_CHG_HIS WHERE PRT_CD IN " + doc_fr
                              + " AND RMV_USE_MIN > 0 ORDER BY CHG_DT DESC LIMIT 1")
    if u["rows"]:
        e, c, dt, m = u["rows"][0]
        edges["unit_mix"] = {"chamber_id": e + "-" + CH.get(c, c), "chg_dt": dt, "rmv_min": m, "min_cols": mins}
    # 분기 경계일 교체
    b = tools.query_legacy_db("SELECT EQP_ID, CHB_ID, CHG_DT FROM PRT_CHG_HIS WHERE PRT_CD IN " + doc_fr
                              + " AND substr(CHG_DT, 5, 4) IN ('0331','0630','0930','1231','0101','0401','0701','1001')"
                              " ORDER BY CHG_DT DESC LIMIT 1")
    if b["rows"]:
        e, c, dt = b["rows"][0]
        edges["boundary"] = {"chamber_id": e + "-" + CH.get(c, c), "chg_dt": dt}
    # 소프트 삭제(DEL_YN='Y') 중복 행이 가장 많은 달
    d = tools.query_legacy_db("SELECT substr(PM_END_DT, 1, 6), COUNT(*) FROM QUAL_HIS WHERE DEL_YN='Y' AND EQP_ID LIKE 'ETCH%' "
                              "GROUP BY 1 ORDER BY 2 DESC LIMIT 1")
    if d["rows"]:
        edges["soft_delete"] = {"month": d["rows"][0][0], "dup_rows": d["rows"][0][1]}
    # 사용시간 결측 — 최근 90일 일별 RF 사용 기록이 가장 많이 빠진 챔버
    since = (datetime.strptime(NOW[:10], "%Y-%m-%d") - timedelta(days=90)).strftime("%Y%m%d")
    cnt = {}
    for e, c, n in tools.query_legacy_db("SELECT EQP_ID, CHB_ID, COUNT(*) FROM CHB_RF_USAGE WHERE EQP_ID LIKE 'ETCH%' AND YMD >= :a "
                                         "GROUP BY EQP_ID, CHB_ID", {"a": since})["rows"]:
        cnt[e + "-" + CH.get(c, c)] = cnt.get(e + "-" + CH.get(c, c), 0) + n
    cand = sorted((n, cid) for cid, n in cnt.items() if cid in documented)
    if cand:
        edges["missing"] = {"chamber_id": cand[0][1], "days": cand[0][0], "missing_days": max(0, 90 - cand[0][0])}
result = {"tables": info, "codes": codes, "normal": normal, "edges": edges}
'''


class GrowState(TypedDict, total=False):
    g: dict


class Factory:
    def __init__(self, sysm):
        self.sys = sysm
        gr = StateGraph(GrowState)
        for n in ("search_archive", "restore_genome", "write_spec", "explore_schema", "generate_code_and_tests", "run_tests",
                  "register_probation", "abort_with_reason"):
            gr.add_node(n, getattr(self, n))
        gr.add_edge(START, "search_archive")
        gr.add_conditional_edges("search_archive", lambda s: "restore" if s["g"].get("archive_hit") else ("spec" if s["g"].get("bp") else "abort"),
                                 {"restore": "restore_genome", "spec": "write_spec", "abort": "abort_with_reason"})
        gr.add_edge("restore_genome", "run_tests")
        gr.add_edge("write_spec", "explore_schema")
        gr.add_edge("explore_schema", "generate_code_and_tests")
        gr.add_conditional_edges("generate_code_and_tests", lambda s: "abort" if s["g"].get("exhausted") else "test",
                                 {"abort": "abort_with_reason", "test": "run_tests"})
        gr.add_conditional_edges("run_tests", self._after_tests, {"ok": "register_probation", "retry": "generate_code_and_tests",
                                                                  "abort": "abort_with_reason"})
        gr.add_edge("register_probation", END)
        gr.add_edge("abort_with_reason", END)
        self.graph = gr.compile()

    # ── 진입 ───────────────────────────────────────────────────────
    def grow(self, l1_state: dict | None, ctx: RunContext, need: list[str] | None = None, reason: str = "") -> dict:
        missing = need or (l1_state or {}).get("route", {}).get("missing_caps", [])
        key = next((m for m in missing if m in BLUEPRINTS), None)
        req = (l1_state or {}).get("request") or {}
        g = {"need": missing, "key": key, "bp": BLUEPRINTS.get(key), "attempts": [], "vsec": 0.0, "tokens": 0, "replay": ctx.replay,
             "clock": S(ctx.clock()), "request": req, "reason": reason, "lines": [], "wall0": time.time(),
             "grow_id": self.sys.store.next_id("GROW-", 3), "probe": (l1_state or {}).get("probe")}
        self._node(g, "start", f"L2 Grow Loop 진입 — 처리 불가 능력 {missing} ({reason or '요청'})")
        out = self.graph.invoke({"g": g})["g"]
        out["vmm"] = _mmss(out["vsec"])
        self._report(out)
        return out

    def _node(self, g, node, detail, pace=0.4, **kw):
        if g["replay"] and self.sys.bus.mute_depth:
            return
        self.sys.bus.emit("node", loop="L2", node=node, grow_id=g["grow_id"], detail=detail, sub="grow",
                          request_id=(g.get("request") or {}).get("request_id"), agent_id=g.get("agent_id"), **kw)
        self.sys.bus.pace(pace)

    def _ctx(self, g, **kw):
        return RunContext(self.sys, mode="replay" if g["replay"] else "ops", replay_clock=P(g["clock"]) if g["replay"] else None,
                          run_shadow=False, quiet=True, **kw)

    def _tick(self, g, sec):
        g["vsec"] += sec
        if not (g["replay"] and self.sys.bus.mute_depth):
            b = self.sys.policy["loop_budget"]["L2"]
            self.sys.bus.emit("budget", loop="L2", grow_id=g["grow_id"], attempts=len(g["attempts"]), max_attempts=b["max_attempts"],
                              minutes=round(g["vsec"] / 60, 1), max_minutes=b["max_minutes"], tokens=g["tokens"], max_tokens=b["max_tokens"])

    # ── 노드 ───────────────────────────────────────────────────────
    def search_archive(self, s):
        g = s["g"]
        hit = None
        if g["bp"]:
            aid = g["bp"]["agent_id"]
            a = self.sys.registry.agent(aid)
            if a and a["status"] == "retired":
                hit = {"agent_id": aid, "version": a["active_version"], "archive": self.sys.store.one(
                    "SELECT archive_id FROM archive WHERE target=? AND decision='retired' ORDER BY ts DESC", (aid,))}
        g["archive_hit"] = hit
        self._tick(g, 3)
        self._node(g, "search_archive", "진화 아카이브 유사 Genome 검색: " +
                   (f"{hit['agent_id']} {hit['version']} (retired) 발견 → 복원 우선" if hit else "해당 없음 → 신규 생성"))
        return {"g": g}

    def restore_genome(self, s):
        g = s["g"]
        hit = g["archive_hit"]
        reg = self.sys.registry
        old = reg.genome(hit["agent_id"], hit["version"])
        M, m, p = (int(x) for x in hit["version"].split("."))
        new_v = reg.next_version(hit["agent_id"], f"0.{max(m, 1)}.0" if M == 0 else "0.1.0", "minor")
        feats = set(old["params"].get("features", []))
        log = list(old["params"].get("changelog", [])) + [f"{new_v}: 아카이브 Genome 복원 ({hit['version']}) — 현재 스키마 재테스트"]
        gen = make_genome(self.sys, hit["agent_id"], new_v, feats, log)
        g["attempts"].append({"n": 1, "version": new_v, "features": sorted(feats), "genome": gen, "note": "아카이브 복원", "restored": True})
        g["agent_id"] = hit["agent_id"]
        self._tick(g, 20)
        self._node(g, "restore_genome", f"{hit['agent_id']} {hit['version']} Genome 복원 → {new_v} (현재 스키마로 재테스트)")
        return {"g": g}

    def write_spec(self, s):
        g = s["g"]
        bp = g["bp"]
        g["agent_id"] = bp["agent_id"]
        code, res = self.sys.llm.generate_code("codegen", "Agent Factory: 새 Agent 명세 작성", f"처리 불가 능력: {g['need']}\n요청: {g['request'].get('text')}",
                                               repr(bp["spec"]))
        g["tokens"] += res.tokens_in + res.tokens_out
        self._tick(g, res.latency_s * 0.6)
        g["spec"] = bp["spec"]
        self._node(g, "write_spec", f"신규 Agent 명세: {bp['agent_id']} — {bp['spec']['role']}", spec=bp["spec"], pace=0.7)
        return {"g": g}

    def explore_schema(self, s):
        g = s["g"]
        pat, col = g["bp"]["explore"]
        ctx = self._ctx(g)
        rec = []
        impl = make_tools(ctx, "factory")
        proxy = ToolProxy(impl, {"inspect_legacy_schema", "query_legacy_db", "resolve_code_value"}, rec)
        r = self.sys.sandbox.execute(EXPLORE_CODE, "factory", "1.0", None, globals_extra={"tools": proxy, "PATTERN": pat, "COLUMN": col,
                                                                                         "NOW": g["clock"]},
                                     timeout_s=20, replay=g["replay"], vts=g["clock"])
        g["schema"] = r.result if r.ok else {"error": (r.error or {}).get("message")}
        self._tick(g, 30)
        if not (g["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("code", agent="factory", purpose=f"{g['grow_id']} 스키마 탐색 (CodeAct)", code=EXPLORE_CODE,
                              output=str(g["schema"])[:700], grow_id=g["grow_id"])
        cd = (g["schema"] or {}).get("codes") or {}
        msg = ", ".join(f"{t['table']}({t['rows']}행)" for t in (g["schema"] or {}).get("tables", [])[:3])
        if cd:
            msg += f" · 부품 코드 PRT_CD {cd['total']}종 (사전 {cd['documented']}종 + 패턴 추론 {len(cd['undocumented'])}종)"
        ed = (g["schema"] or {}).get("edges") or {}
        if ed:
            msg += f" · 엣지 후보 {len(ed)}종 도출: " + ", ".join(EDGE_KO[k] for k in EDGE_KO if k in ed)
        self._node(g, "explore_schema", "스키마 탐색: " + msg, pace=0.6)
        return {"g": g}

    def generate_code_and_tests(self, s):
        g = s["g"]
        bp = g["bp"]
        b = self.sys.policy["loop_budget"]["L2"]
        idx = len(g["attempts"])
        if idx >= min(len(bp["attempts"]), b["max_attempts"]) or g["vsec"] / 60 >= b["max_minutes"]:
            g["exhausted"] = True
            return {"g": g}
        att = bp["attempts"][idx]
        version = "0.1.0"
        log = [f"0.1.0: Grow {g['grow_id']} — {bp['spec']['role']}" + (f" ({att['note']})" if idx else "")]
        gen = make_genome(self.sys, bp["agent_id"], version, set(att["features"]), log)
        prompt = (f"명세: {bp['spec']}\n스키마: {g.get('schema')}\n이전 실패: {[a.get('failures') for a in g['attempts']]}\n"
                  "Agent 코드와 테스트를 작성하라. 테스트는 정상 케이스만이 아니라 스키마 탐색 결과(코드값 분포·결측·경계일)로 엣지 케이스를 함께 만든다.")
        code, res = self.sys.llm.generate_code("codegen", "Agent Factory: Agent 코드·테스트 생성", prompt, gen["code"])
        gen["code"] = code
        g["tokens"] += res.tokens_in + res.tokens_out
        self._tick(g, res.latency_s)
        g["attempts"].append({"n": idx + 1, "version": version, "features": sorted(att["features"]), "genome": gen, "note": att["note"],
                              "model": res.model, "lines": len(code.splitlines())})
        g["test_plan"] = test_plan(g)
        tests_src = test_source(g["test_plan"])
        if not (g["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("code", agent="factory", purpose=f"{g['grow_id']} {bp['agent_id']} 코드·테스트 생성 {idx + 1}회차",
                              code=code + ("\n\n" + tests_src if tests_src else ""), grow_id=g["grow_id"], model=res.model)
        tp = g["test_plan"]
        self._node(g, "generate_code_and_tests", f"{bp['agent_id']} 코드·테스트 생성 {idx + 1}회차 ({len(code.splitlines())} lines, {res.model})"
                   + (f" · 테스트 정상 {len(tp['normal']) + 3}건 + 엣지 {len(tp['edges'])}건" if tp else ""), pace=0.9)
        return {"g": g}

    def run_tests(self, s):
        g = s["g"]
        att = g["attempts"][-1]
        aid = g["agent_id"]
        reg = self.sys.registry
        if not reg.agent(aid):
            bp = g["bp"] or BLUEPRINTS[next(k for k, v in BLUEPRINTS.items() if v["agent_id"] == aid)]
            reg.register_agent(aid, "agent", bp["name_ko"], protected=False, origin=f"Grow ({'리플레이' if g['replay'] else '운영'})",
                               card=bp["card"], status="candidate")
        gen = att["genome"]
        reg.add_genome(aid, att["version"], gen["code"], params=gen["params"], deps=gen["deps"], tools=gen["tools"], reason="grow",
                       ref=g["grow_id"], status="candidate")
        results = self.sys.harness.grow_invariants(aid, att["version"], g)
        att["tests"] = results
        ok = all(t["ok"] for t in results)
        att["result"] = "pass" if ok else "fail"
        g["tests_ok"] = ok
        self._tick(g, 15 + 2 * len(results))
        for t in results:
            if not (g["replay"] and self.sys.bus.mute_depth):
                self.sys.bus.emit("tests", grow_id=g["grow_id"], agent_id=aid, version=att["version"], ok=t["ok"], label=t["name"], why=t["detail"])
        fails = [t for t in results if not t["ok"]]
        att["summary"] = suite_summary(results)
        self._node(g, "run_tests", f"테스트 {len(results) - len(fails)}/{len(results)} 통과" + (f" — {att['summary']}" if att["summary"] else "")
                   + " (자체 + 하네스 불변식)" + ("" if ok else " — 실패: " + "; ".join(f"{t['name']}: {t['detail']}" for t in fails[:2])), pace=0.7)
        if not ok:
            reg.set_genome_status(aid, att["version"], "rejected")
            att["failures"] = [t["detail"] for t in fails]
        return {"g": g}

    def _after_tests(self, s):
        g = s["g"]
        if g.get("tests_ok"):
            return "ok"
        b = self.sys.policy["loop_budget"]["L2"]
        if g["attempts"][-1].get("restored") or len(g["attempts"]) >= b["max_attempts"] or g["vsec"] / 60 >= b["max_minutes"] \
                or len(g["attempts"]) >= len((g.get("bp") or {}).get("attempts", [])):
            if g["attempts"][-1].get("restored") and g.get("bp"):
                return "retry"
            return "abort"
        return "retry"

    def register_probation(self, s):
        g = s["g"]
        att = g["attempts"][-1]
        aid = g["agent_id"]
        reg = self.sys.registry
        reg.update_agent(aid, status="probation")
        reg.activate(aid, att["version"], "grow" if not att.get("restored") else "restore", ref=g["grow_id"],
                     note=("아카이브 복원" if att.get("restored") else "신규 생성") + " (probation)")
        if att.get("restored"):
            reg.lifecycle_event(aid, "restore", note=f"retired → probation {att['version']}")
        skills = list((att["genome"]["deps"] or {}).get("skills", {}))
        if aid == "chamber_trend_agent":
            g["golden"] = self.sys.harness.capture_trend_golden(aid, att["version"])
        g["ok"] = True
        g["version"] = att["version"]
        tries = len(g["attempts"])
        first_fail = next((a for a in g["attempts"] if a.get("result") == "fail"), None)
        g["lines"] = [f"신규 Agent: {aid} {att['version']} (probation)" if not att.get("restored") else f"아카이브 복원: {aid} {att['version']} (probation)",
                      f"데이터 소스: {', '.join((g.get('bp') or {}).get('spec', {}).get('data_sources', [])[:2])}" +
                      (f" (부품 코드 PRT_CD {g['schema']['codes']['total']}종 해석)" if (g.get('schema') or {}).get('codes') else ""),
                      f"재사용 스킬: {', '.join(skills) or '-'}",
                      *test_lines(g, first_fail),
                      *[f"교차 검증: {t['detail']}" for t in att["tests"] if t["name"].startswith("행 수 대조")],
                      f"소요시간: {_mmss(g['vsec'])}"]
        self._node(g, "register_probation", f"{aid} {att['version']} probation 등록 → L1 execute_sandbox 복귀", pace=0.6)
        if not (g["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("toast", level="ok", text=f"Agent Grow: {aid} {att['version']} 생성 ({tries}회 / {_mmss(g['vsec'])})")
        return {"g": g}

    def abort_with_reason(self, s):
        g = s["g"]
        g["ok"] = False
        why = "처리 가능한 Agent 설계안 없음" if not g.get("bp") else f"예산 내 생성 실패 ({len(g['attempts'])}회, {_mmss(g['vsec'])})"
        g["lines"] = [f"Agent 생성 중단: {why}", "불완전 Agent Registry 등록 0건 (probation 미등록)",
                      "개발 요청 초안 자동 작성: 미지원 능력 " + ", ".join(g["need"])]
        self._node(g, "abort_with_reason", why)
        return {"g": g}

    def _report(self, g):
        content = {k: g.get(k) for k in ("grow_id", "agent_id", "version", "ok", "need", "reason", "lines", "spec", "schema", "tokens")}
        content["vsec"] = round(g["vsec"])
        content["attempts"] = [{k: a.get(k) for k in ("n", "version", "features", "note", "result", "tests", "lines", "model", "restored")}
                               for a in g["attempts"]]
        title = f"Agent Grow 리포트 {g['grow_id']} — {g.get('agent_id') or '-'}"
        self.sys.store.insert("reports", {"report_id": g["grow_id"], "kind": "grow", "title": title, "ts": g["clock"], "content": content})
        if not (g["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("report", kind="grow", report_id=g["grow_id"], title=title, content=content)


EDGE_KO = {"unknown_code": "미등록 부품 코드", "no_history": "교체 이력 0건 챔버", "unit_mix": "분/시간 단위 혼재",
           "boundary": "분기 경계일 교체", "soft_delete": "소프트 삭제 중복 행", "missing": "사용시간 결측"}


def test_plan(g: dict) -> dict | None:
    """스키마 탐색 결과 → 테스트 계획 (정상 케이스 + 엣지 케이스). 실행·채점은 루프 밖 하네스가 한다."""
    sc = g.get("schema") or {}
    if g.get("agent_id") != "part_history_agent" or not sc.get("normal"):
        return None
    return {"normal": sc["normal"], "edges": {k: v for k, v in (sc.get("edges") or {}).items() if k in EDGE_KO}}


def test_source(plan: dict | None) -> str:
    """생성된 테스트를 코드로 보여주기 위한 소스 (CodeAct 패널 표시용)."""
    if not plan:
        return ""
    e = plan["edges"]
    src = [f"# ── 생성 테스트: 정상 {len(plan['normal']) + 3}건 + 엣지 {len(e)}건 (스키마 탐색 결과에서 도출) ──",
           "def test_normal_usage():                # 정상: 코드 사전에 등재된 Focus Ring 챔버",
           f"    for cid in {plan['normal']}:",
           "        assert usage(cid)['status'] == 'ok'"]
    if "unknown_code" in e:
        src += [f"def test_edge_unknown_code():           # 미등록 부품 코드 {e['unknown_code']['code']}",
                f"    out = usage('{e['unknown_code']['chamber_id']}')     # KeyError 없이 '미해석' 표기",
                "    assert out['status'] == 'ok' and '미해석' in out['part_name']"]
    if "no_history" in e:
        src += ["def test_edge_no_history():             # 교체 이력 0건 챔버",
                f"    assert usage('{e['no_history']['chamber_id']}')['status'] == 'unavailable'"]
    if "unit_mix" in e:
        u = e["unit_mix"]
        src += [f"def test_edge_unit_mix():               # {'/'.join(u.get('min_cols') or ['RMV_USE_MIN'])} 는 분 단위, 출력은 시간",
                f"    out = usage('{u['chamber_id']}', at=교체시각 + 1h)",
                f"    assert abs(out['removed_part_hours'] - {u['rmv_min']} / 60) < 1"]
    if "boundary" in e:
        src += ["def test_edge_quarter_boundary():        # 분기 경계일 교체",
                f"    out = usage('{e['boundary']['chamber_id']}', at=교체 다음날)",
                f"    assert out['installed_at'] == fmt('{e['boundary']['chg_dt']}') and out['signals']['fr_hours'] <= 48"]
    if "soft_delete" in e:
        src += ["def test_edge_soft_deleted_dup():        # DEL_YN='Y' 중복 행 제외",
                f"    out = analyze('ETCH', month='{e['soft_delete']['month']}')",
                "    assert out['n_cases'] == count(DEL_YN='N') and no_duplicate_events(out['cases'])"]
    if "missing" in e:
        src += ["def test_edge_missing_usage():           # 일별 RF 사용 기록 결측 → 보간",
                f"    h = usage('{e['missing']['chamber_id']}')['signals']['fr_hours']",
                "    assert h is not None and 0 < h <= 5000"]
    src += ["# 하네스 불변식(루프 밖 고정, 필수 통과): 단위 범위 · 행 수 대조(legacy_agent 집계) · 기간 경계"]
    return "\n".join(src)


def suite_summary(results: list[dict]) -> str:
    def part(suites, label):
        xs = [r for r in results if r.get("suite") in suites]
        return f"{label} {sum(1 for r in xs if r['ok'])}/{len(xs)}" if xs else ""
    return " · ".join(x for x in (part(("unit", "invariant"), "정상"), part(("edge",), "엣지")) if x)


def test_lines(g: dict, first_fail: dict | None) -> list[str]:
    att = g["attempts"][-1]
    edges = [r for r in att.get("tests") or [] if r.get("suite") == "edge"]
    if not edges:
        return [f"자가 테스트: {len(g['attempts'])}회차 통과" + (f" (1회차 {first_fail['failures'][0][:60]} → {att['note']})" if first_fail else "")]
    normal = [r for r in att["tests"] if r.get("suite") != "edge"]
    out = [f"자가 테스트: 정상 케이스 {len(normal)}건 + 생성 엣지 케이스 {len(edges)}건 ({' · '.join(r['name'].split(': ', 1)[-1] for r in edges)})"]
    for a in g["attempts"]:
        fails = [r for r in a.get("tests") or [] if not r["ok"]]
        tail = f" ({' / '.join(r['name'].split(': ', 1)[-1] + ' → ' + r['detail'] for r in fails)[:150]})" if fails else ""
        fix = f"{a['note'].split(': ', 1)[-1]} → " if a["n"] > 1 and a.get("note") else ""
        total = len(a.get("tests") or [])
        if fails:
            nm = [r for r in a["tests"] if r.get("suite") != "edge"]
            ed = [r for r in a["tests"] if r.get("suite") == "edge"]
            res = (f"정상 {sum(r['ok'] for r in nm)}/{len(nm)} {'통과' if all(r['ok'] for r in nm) else '실패'}, "
                   f"엣지 {sum(r['ok'] for r in ed)}/{len(ed)} {'통과' if all(r['ok'] for r in ed) else '실패'}")
            out.append(f"  - {a['n']}회차: {fix}{res}{tail}")
        else:
            out.append(f"  - {a['n']}회차: {fix}{total}/{total} 통과")
    return out


def _mmss(sec: float) -> str:
    sec = int(round(sec))
    return f"{sec // 60}분 {sec % 60:02d}초"
