"""L1 Task Loop (요청 단위) — LangGraph StateGraph.

parse_request → retrieve_memory → jev_route ─(처리 불가)→ grow_subgraph
                                         └(처리 가능)→ plan_codeact → execute_sandbox → observe
observe ─(오류·사후 검증 실패)→ mark_unavailable(L2 Heal 비동기 기동) → synthesize
        ─(외부 장애·목표 미충족, 예산 내)→ plan_codeact
        ─(목표 충족)→ synthesize → respond
respond → await_qual_result(interrupt) → deterministic_judge ─PASS→ approval_gate(interrupt) → apply_state_change → log_experience → END
                                                             └FAIL→ rework_plan → await_qual_result (Fail 3회 누적 시 에스컬레이션)
리플레이 모드: respond → replay_measure → deterministic_judge → compare_actual → END (interrupt 없음)
"""
from __future__ import annotations

import concurrent.futures as cf
import re
import time
from datetime import datetime, timedelta
from typing import Any, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from mock_env import config as C

from ..judge import judge_qual
from ..super_agent import RTYPE_KO, history_suggestion
from ..tools import P, RunContext, S

_POOL = cf.ThreadPoolExecutor(max_workers=8, thread_name_prefix="agent")


class L1State(TypedDict, total=False):
    request: dict
    mode: str
    replay_clock: str | None
    replay: dict
    memory: dict
    route: dict
    plan: dict
    exec: dict
    observe: dict
    synth: dict
    qual: dict
    approval: dict
    budget: dict
    clarify: str | None
    grow: dict
    compare: dict
    done: bool


class L1:
    def __init__(self, sysm):
        self.sys = sysm
        self.ops = self._build("ops").compile(checkpointer=InMemorySaver())
        self.replay = self._build("replay").compile()

    # ── 그래프 ─────────────────────────────────────────────────────
    def _build(self, mode: str):
        g = StateGraph(L1State)
        for name in ("parse_request", "retrieve_memory", "jev_route", "grow_subgraph", "plan_codeact", "execute_sandbox",
                     "observe", "mark_unavailable", "synthesize", "respond", "deterministic_judge", "log_experience"):
            g.add_node(name, getattr(self, name))
        g.add_edge(START, "parse_request")
        g.add_conditional_edges("parse_request", lambda s: "respond" if s.get("clarify") else "retrieve_memory",
                                {"respond": "respond", "retrieve_memory": "retrieve_memory"})
        g.add_edge("retrieve_memory", "jev_route")
        g.add_conditional_edges("jev_route", self._after_route, {"grow": "grow_subgraph", "plan": "plan_codeact"})
        g.add_conditional_edges("grow_subgraph", lambda s: "plan" if s["grow"].get("ok") else "respond",
                                {"plan": "plan_codeact", "respond": "respond"})
        g.add_edge("plan_codeact", "execute_sandbox")
        g.add_edge("execute_sandbox", "observe")
        g.add_conditional_edges("observe", self._after_observe,
                                {"heal": "mark_unavailable", "replan": "plan_codeact", "synth": "synthesize"})
        g.add_edge("mark_unavailable", "synthesize")
        g.add_edge("synthesize", "respond")
        if mode == "ops":
            g.add_node("await_qual_result", self.await_qual_result)
            g.add_node("rework_plan", self.rework_plan)
            g.add_node("approval_gate", self.approval_gate)
            g.add_node("apply_state_change", self.apply_state_change)
            g.add_conditional_edges("respond", self._after_respond_ops, {"await": "await_qual_result", "log": "log_experience", "end": END})
            g.add_edge("await_qual_result", "deterministic_judge")
            g.add_conditional_edges("deterministic_judge", self._after_judge,
                                    {"approve": "approval_gate", "rework": "rework_plan", "wait": "await_qual_result", "log": "log_experience"})
            g.add_edge("rework_plan", "await_qual_result")
            g.add_edge("approval_gate", "apply_state_change")
            g.add_edge("apply_state_change", "log_experience")
        else:
            g.add_node("replay_measure", self.replay_measure)
            g.add_node("compare_actual", self.compare_actual)
            g.add_conditional_edges("respond", lambda s: "measure" if (s.get("synth") or {}).get("recommendation") else "compare",
                                    {"measure": "replay_measure", "compare": "compare_actual"})
            g.add_edge("replay_measure", "deterministic_judge")
            g.add_edge("deterministic_judge", "compare_actual")
            g.add_edge("compare_actual", END)
        g.add_edge("log_experience", END)
        return g

    # ── 헬퍼 ───────────────────────────────────────────────────────
    def _ctx(self, s: L1State) -> RunContext:
        rc = P(s["replay_clock"]) if s.get("replay_clock") else None
        return RunContext(self.sys, mode="replay" if rc else "ops", replay_clock=rc, request_id=s["request"].get("request_id"),
                          quiet=bool(rc) and self.sys.bus.mute_depth > 0)

    def _node(self, s: L1State, node: str, detail: str = "", pace: float = 0.35, **kw):
        if s.get("mode") == "replay" and self.sys.bus.mute_depth:
            return
        self.sys.bus.emit("node", loop="L1", node=node, request_id=s["request"].get("request_id"), detail=detail,
                          thread_id=s["request"].get("thread_id"), **kw)
        self.sys.bus.pace(pace)

    def _thought(self, s: L1State, text: str, kind: str = "think", pace: float = 0.25, **kw):
        if s.get("mode") == "replay" and self.sys.bus.mute_depth:
            return
        self.sys.bus.emit("thought", agent=kw.pop("agent", "super_agent"), text=text, kind=kind,
                          request_id=s["request"].get("request_id"), **kw)
        self.sys.bus.pace(pace)

    # ── 노드: parse_request ────────────────────────────────────────
    def parse_request(self, s: L1State):
        req = dict(s["request"])
        ctx = self._ctx(s)
        now = ctx.clock()
        if not req.get("parsed"):
            p = self.sys.super.parse(req["text"], now, req.get("hint"))
            req.update(p)
            req["parsed"] = True
        ents = req["entities"]
        out: dict[str, Any] = {"request": req, "budget": s.get("budget") or {"replans": 0, "qual_fail": 0, "t0": time.time()}}
        llm_role = self.sys.llm.model_for("summary")
        self._node(s, "parse_request", f"엔티티 추출 ({llm_role})", entities=ents, rtype=req["rtype"])
        if req.get("ambiguous"):
            cands = []
            for eqp in req["ambiguous"]:
                pm = self.sys.world.pm_events(f"{eqp}-{ents.get('chamber', 'A')}", now, 1, ents.get("pm_type"),
                                              since=now - timedelta(hours=24))
                cands.append({"eqp_id": eqp, "today_pm": bool(pm)})
            today = [c["eqp_id"] for c in cands if c["today_pm"]] or [c["eqp_id"] for c in cands]
            j = self.sys.jev.decide("요청 장비는?", "choice", today, {"head": "entity", "scores": {e: 1.0 for e in today}})
            out["clarify"] = (f"'{req['text']}' — 장비가 모호합니다. 당일 PM 이력이 있는 후보: " + ", ".join(today) +
                              f" (Jev 최대 확률 {max(j['probs'].values()):.2f} < 0.90). 어느 장비인가요? 추측으로 계획을 세우지 않습니다.")
            self._thought(s, out["clarify"], "ask")
            return out
        if req["rtype"] in ("autoqual", "judge", "remeasure", "trend") and not ents.get("chamber_id"):
            if req["rtype"] == "trend" and ents.get("eqp_id"):
                pass
            else:
                out["clarify"] = "장비 ID와 챔버를 함께 알려주세요 (예: ETCH-07 B챔버)."
                return out
        if ents.get("chamber_id") and req["rtype"] in ("autoqual", "judge", "remeasure", "trend") and not ents.get("pm_end"):
            pm = self.sys.world.pm_events(ents["chamber_id"], now, 1, ents.get("pm_type") if req["rtype"] == "autoqual" else None)
            if not pm and not s.get("replay"):
                out["clarify"] = f"{ents['chamber_id']}의 최근 PM 이력을 찾지 못했습니다. PM 종류를 확인해 주세요."
                return out
            if pm:
                ents.setdefault("pm_type", pm[0]["pm_type"])
                ents["pm_start"], ents["pm_end"], ents["pm_id"] = pm[0]["pm_start"], pm[0]["pm_end"], pm[0]["pm_id"]
                ents["parts"] = pm[0]["parts"]
        return out

    def retrieve_memory(self, s: L1State):
        req = s["request"]
        ents = req["entities"]
        ctx = self._ctx(s)
        mem = {"lessons": 0, "cases": 0, "templates": 0, "lesson_ids": []}
        if ents.get("eqp_model") and ents.get("pm_type"):
            ls = self.sys.memory.search({"kind": "lesson", "eqp_model": ents["eqp_model"], "pm_type": ents["pm_type"], "status": "active"},
                                        50, before_ts=ctx.clock())
            mem["lessons"] = len(ls)
            mem["lesson_ids"] = [x["id"] for x in ls][:8]
            cs = self.sys.memory.search({"kind": "case", "chamber_id": ents.get("chamber_id"), "pm_type": ents["pm_type"]}, 10,
                                        before_ts=ctx.clock()) if ents.get("chamber_id") else []
            mem["cases"] = len(cs)
        mem["templates"] = self.sys.store.scalar("SELECT COUNT(*) FROM templates WHERE status='active'") or 0
        self._node(s, "retrieve_memory", f"경험 메모리: 교훈 {mem['lessons']}건 · 과거 건 {mem['cases']}건 · 편성 템플릿 {mem['templates']}개",
                   memory=mem)
        return {"memory": mem}

    def jev_route(self, s: L1State):
        req = s["request"]
        t0 = time.perf_counter()
        r = self.sys.super.route(req, self._ctx(s).clock())
        r["elapsed_s"] = round(time.perf_counter() - t0 + 0.04 * (len(r["selected"]) + 3), 2)
        self._node(s, "jev_route", f"Jev 편성 {', '.join(r['selected']) or '-'}", route={
            "selected": r["selected"], "probs": r["routing"]["probs"], "can_handle": r["can_handle"]["probs"]["yes"],
            "escalated": r["escalated"], "skipped": r["skipped"]})
        if s.get("mode") != "replay" or not self.sys.bus.mute_depth:
            self.sys.bus.emit("jev", head="can_handle", question=r["can_handle"]["question"], probs=r["can_handle"]["probs"],
                              answer=r["can_handle"]["answer"], features=r["can_handle"]["features"], request_id=req.get("request_id"))
            self.sys.bus.emit("jev", head="route", question=r["routing"]["question"], probs=r["routing"]["probs"],
                              answer=r["selected"], threshold=r["threshold"], escalated=r["escalated"], request_id=req.get("request_id"))
            self.sys.bus.pace(0.5)
        return {"route": {k: v for k, v in r.items() if k not in ("routing", "can_handle")} |
                {"probs": r["routing"]["probs"], "can_handle_p": r["can_handle"]["probs"]["yes"],
                 "can_handle": r["can_handle"]["answer"], "missing_caps": r["can_handle"]["features"].get("missing", [])}}

    def _after_route(self, s: L1State):
        r = s["route"]
        if r["can_handle"] == "no" and not s.get("grow"):
            return "grow"
        return "plan"

    def grow_subgraph(self, s: L1State):
        res = self.sys.factory.grow(s, self._ctx(s))
        out = {"grow": res}
        if res.get("ok"):
            route = dict(s["route"])
            sel = list(route["selected"])
            if res["agent_id"] not in sel:
                sel.append(res["agent_id"])
            route["selected"] = sel
            route["can_handle"] = "yes"
            out["route"] = route
        return out

    # ── 노드: plan_codeact ─────────────────────────────────────────
    def plan_codeact(self, s: L1State):
        req = s["request"]
        sup = self.sys.super
        budget = dict(s.get("budget") or {})
        if s.get("plan"):
            budget["replans"] = budget.get("replans", 0) + 1
        tmpl, tj = sup.match_template(req, s["route"])
        draft = sup.write_plan(req, s["route"])
        if tmpl:
            plan = {"code": tmpl["plan_code"], "source": "template", "template_id": tmpl["template_id"], "model": None,
                    "latency_s": 0.05, "tokens": 0, "template_p": tj["probs"]["yes"]}
            self.sys.store.con.execute("UPDATE templates SET uses=uses+1 WHERE template_id=?", (tmpl["template_id"],))
        else:
            system = (self.sys.registry.genome("super_agent") or {}).get("prompt", "")
            prompt = (f"요청: {req['text']}\n유형: {req['rtype']}\n엔티티: {req['entities']}\n편성 Agent: {s['route']['selected']}\n"
                      "하위 Agent를 parallel()/call()로 호출하고 결과를 result 변수에 결합하는 Python 실행 계획 코드를 작성하라.")
            code, res = self.sys.llm.generate_code("plan", system, prompt, draft["code"])
            if self.sys.sandbox.check(code):
                code = draft["code"]
            plan = {"code": code, "source": "llm" if res.source == "online" else "llm(playbook)", "model": res.model,
                    "latency_s": res.latency_s, "tokens": res.tokens_in + res.tokens_out,
                    "template_p": tj["probs"]["yes"] if tj else None}
        self._node(s, "plan_codeact", "편성 템플릿 " + plan["template_id"] + " 적용 (LLM 계획 생략)" if tmpl else
                   f"실행 계획 코드 작성 ({plan['model']})", pace=0.2)
        if s.get("mode") != "replay" or not self.sys.bus.mute_depth:
            self.sys.bus.emit("code", agent="super_agent", purpose="실행 계획 (CodeAct)", code=plan["code"], source=plan["source"],
                              model=plan.get("model"), request_id=req.get("request_id"), template_id=plan.get("template_id"))
            self.sys.bus.pace(min(2.2, 0.4 + len(plan["code"]) / 900))
        return {"plan": plan, "budget": budget}

    # ── 노드: execute_sandbox ──────────────────────────────────────
    def execute_sandbox(self, s: L1State):
        ctx = self._ctx(s)
        req = s["request"]
        ents = dict(req["entities"])
        REQ = {k: ents.get(k) for k in ("eqp_id", "chamber_id", "pm_type", "pm_start", "pm_end", "eqp_model", "eqp_group", "lot", "eqp_prefix")}
        REQ = {k: v for k, v in REQ.items() if v is not None}
        if req["rtype"] == "trend":
            REQ["want_trend"] = True
        runs: list[dict] = []
        lat = {"ms": 0.0}
        sequential = ctx.replay

        def call(agent_id, action, inputs):
            r = self.sys.runtime.run_agent(ctx, agent_id, action, dict(inputs))
            runs.append(r)
            lat["ms"] += r.get("io_ms", 0) + r.get("elapsed_ms", 0)
            return r["output"] if r["ok"] else _unavail(r)

        muted = self.sys.bus.mute_depth > 0      # 배경 운영(muted) 요청은 병렬 스레드에서도 UI 이벤트를 내지 않는다 (mute는 스레드 로컬)

        def _run(a, act, inp):
            if muted:
                with self.sys.bus.muted():
                    return self.sys.runtime.run_agent(ctx, a, act, dict(inp))
            return self.sys.runtime.run_agent(ctx, a, act, dict(inp))

        def parallel(*specs):
            if sequential or len(specs) == 1:
                rs = [self.sys.runtime.run_agent(ctx, a, act, dict(inp)) for a, act, inp in specs]
            else:
                futs = [_POOL.submit(_run, a, act, inp) for a, act, inp in specs]
                rs = [f.result() for f in futs]
            runs.extend(rs)
            lat["ms"] += max((r.get("io_ms", 0) + r.get("elapsed_ms", 0)) for r in rs) if rs else 0
            return [r["output"] if r["ok"] else _unavail(r) for r in rs]

        period = req.get("period") or {}
        res = self.sys.sandbox.execute(s["plan"]["code"], "super_agent", (self.sys.registry.agent("super_agent") or {}).get("active_version", "?"),
                                       None, globals_extra={"REQ": REQ, "PERIOD": period, "call": call, "parallel": parallel},
                                       timeout_s=60, replay=ctx.replay, vts=S(ctx.clock()))
        plan_lat = (s["plan"].get("latency_s") or 0) * 1000
        exe = {"ok": res.ok, "error": res.error, "result": res.result if res.ok else None, "audit_id": res.audit_id,
               "runs": [{k: r.get(k) for k in ("agent_id", "version", "action", "ok", "error", "violations", "io_ms", "elapsed_ms",
                                              "signature", "tool_calls", "redirected", "redirected_from")} for r in runs],
               "outputs": {f"{r['agent_id']}:{r['action']}": r.get("output") for r in runs},
               "latency_ms": round(lat["ms"] + plan_lat + 300, 1), "io_total_ms": round(ctx.io_ms, 1),
               "guard_blocked": ctx.guard_blocked, "leaks": ctx.leaks, "req": REQ}
        self._node(s, "execute_sandbox", f"샌드박스 실행 · Agent {len(runs)}회 호출 · 가상 응답 {exe['latency_ms'] / 1000:.1f}s",
                   runs=[{"agent_id": r["agent_id"], "ok": r["ok"], "version": r["version"]} for r in runs], pace=0.3)
        return {"exec": exe}

    # ── 노드: observe ──────────────────────────────────────────────
    def observe(self, s: L1State):
        exe = s["exec"]
        un, heal = [], []
        ext = []
        for r in exe["runs"]:
            if r["ok"]:
                continue
            e = r.get("error") or {}
            if e.get("type") in ("DataTimeout", "TimeoutError"):
                ext.append(r)
                un.append({"agent_id": r["agent_id"], "item": "ALL", "reason": "외부 장애(타임아웃)"})
                continue
            if e.get("type") == "AgentRetired":
                continue
            reason = e.get("message") or "; ".join(v["message"] for v in r.get("violations") or [])
            un.append({"agent_id": r["agent_id"], "item": (r.get("violations") or [{}])[0].get("field") or "ALL", "reason": reason})
            heal.append(r)
        if not exe["ok"] and not exe["runs"]:
            un.append({"agent_id": "super_agent", "item": "PLAN", "reason": (exe.get("error") or {}).get("message")})
        budget = s.get("budget") or {}
        replan = bool(ext) and budget.get("replans", 0) < 1
        obs = {"unavailable": un, "heal": heal, "external": [r["agent_id"] for r in ext], "replan": replan}
        if un:
            self._thought(s, "사후 검증: " + " / ".join(f"{u['agent_id']} {u['item']} 확인 불가 — {u['reason'][:80]}" for u in un), "warn")
        if replan:
            self._thought(s, f"Jev 오류 분류: 외부 장애 → 코드 패치 없이 백오프 재시도 (L1 예산 {budget.get('replans', 0) + 1}/1)", "warn")
            self.sys.clock.advance(seconds=30)
            self.sys.bus.emit("toast", level="warn", text=f"외부 장애 감지 ({', '.join(obs['external'])}) — 백오프 재시도, 운영자 알림")
        self._node(s, "observe", "목표 충족" if not un else f"확인 불가 {len(un)}건", pace=0.2)
        return {"observe": obs}

    def _after_observe(self, s: L1State):
        o = s["observe"]
        if o.get("replan"):
            return "replan"
        if o.get("heal"):
            return "heal"
        return "synth"

    def mark_unavailable(self, s: L1State):
        ctx = self._ctx(s)
        obs = dict(s["observe"])
        tickets = []
        for r in obs["heal"]:
            t = self.sys.healer.trigger(r, s, ctx)
            if t:
                tickets.append(t)
        obs["heal_tickets"] = tickets
        self._node(s, "mark_unavailable", "L2 Heal Loop 기동 (" + ", ".join(t.get("heal_id", "?") for t in tickets) + ")" if tickets else
                   "확인 불가 표시", pace=0.2)
        out = {"observe": obs}
        # 리플레이: Heal은 동기 수행 → 복구되면 해당 건을 재실행해 결과 보완
        if ctx.replay and any(t.get("ok") for t in tickets) and not s.get("budget", {}).get("healed_rerun"):
            plan_state = dict(s)
            plan_state["budget"] = dict(s.get("budget") or {}, healed_rerun=True)
            exe = self.execute_sandbox(plan_state)["exec"]
            out["exec"] = exe
            obs["unavailable"] = [u for u in obs["unavailable"] if not any(r["agent_id"] == u["agent_id"] and r["ok"] for r in exe["runs"])]
            obs["reanswered"] = True
        return out

    # ── 노드: synthesize ───────────────────────────────────────────
    def synthesize(self, s: L1State):
        req = s["request"]
        exe = s["exec"]
        res = exe.get("result") or {}
        rt = req["rtype"]
        blocks = []
        rec_out = None
        route = s["route"]
        probs = route.get("probs", {})
        sup_ver = (self.sys.registry.agent("super_agent") or {}).get("active_version")
        grown = (s.get("grow") or {}).get("agent_id")
        used = [f"{a} {probs.get(a, 0):.2f}" if a != grown else f"{a} (신규 생성)" for a in route["selected"]]
        exc = [f"{a} {probs.get(a, 0):.2f} 제외" for a in route.get("excluded", []) if a in probs and a != grown]
        plan = s["plan"]
        rb = {"kind": "routing", "title": f"Agent 편성 · super_agent {sup_ver}",
              "lines": [f"경로: {'편성 템플릿 ' + plan['template_id'] if plan.get('source') == 'template' else 'Jev'} "
                        f"({' / '.join(used + exc)}) → {len(route['selected'])}개 Agent " + ("병렬 실행" if len(route['selected']) > 1 else "실행"),
                        f"편성 시간: {route.get('elapsed_s', 0.3):.1f}s · 계획: {plan['source']}"]}
        for sk in route.get("skipped", []):
            rb["lines"].append(f"생략: {sk['agent_id']} ({sk['reason']})")
        for e in route.get("escalated", []):
            rb["lines"].append(f"LLM 재검토: {e['agent_id']} p={e['p']:.2f} → {'편입' if e['keep'] else '제외'}")
        blocks.append(rb)
        un = {u["agent_id"]: u for u in (s.get("observe") or {}).get("unavailable", [])}
        tickets = {t.get("agent_id"): t for t in (s.get("observe") or {}).get("heal_tickets", [])}
        ver = {r["agent_id"]: r["version"] for r in exe["runs"]}

        def unavailable_line(agent):
            u = un.get(agent)
            t = tickets.get(agent)
            if not u:
                return None
            msg = "일시 확인 불가"
            if t and t.get("status") in ("running", "queued"):
                msg += f" ({u['reason'][:40]} 감지, 자동 복구 진행 중 · {t.get('heal_id')})"
            elif t and t.get("ok"):
                msg += f" → {t.get('heal_id')} 복구 완료 후 재분석 반영"
            elif u["reason"]:
                msg += f" ({u['reason'][:60]})"
            return msg

        if rt == "autoqual":
            spec = res.get("spec") or {}
            log = res.get("log") or {}
            hist = res.get("hist") or {}
            rec = res.get("recommendation") or {}
            if spec.get("status") == "ok":
                specs = spec["specs"]
                sline = " → ".join(spec["steps"][:1] + ["Seasoning"] + [_spec_txt(x) for x in specs if x["item"] != "LEAK_RATE"])
                blocks.append({"kind": "procedure", "title": f"Qual 절차 · spec_agent {ver.get('spec_agent')}",
                               "lines": [f"모델 {spec['eqp_model']} / PM: {req['entities'].get('pm_type')} → 절차 {spec['procedure_id']}",
                                         sline, f"기본 Seasoning: {spec['seasoning']['base_count']}매 ({spec['seasoning']['recipe_id']})"]})
            else:
                blocks.append({"kind": "procedure", "title": "Qual 절차", "lines": [spec.get("reason") or "기준정보 누락"], "warn": True})
            lines = []
            ul = unavailable_line("log_agent")
            if log.get("status") in ("ok", "partial"):
                for ind in log.get("indicators", []):
                    lines.append(_ind_txt(ind, spec.get("specs", [])))
                al = log.get("alarms") or []
                lines.append("PM 후 알람 없음" if not al else f"PM 후 알람 {len(al)}건: " + ", ".join(a["alarm_code"] for a in al[:3]))
                if log.get("unavailable"):
                    lines.append("확인 불가 항목: " + ", ".join(log["unavailable"]))
            if ul:
                lines.append(f"챔버 로그 분석: {ul}")
            blocks.append({"kind": "chamber", "title": f"챔버 상태 · log_agent {ver.get('log_agent', '-')}", "lines": lines or ["-"],
                           "warn": bool(ul)})
            for extra in ("trend", "part"):
                if res.get(extra):
                    o = res[extra]
                    aid = "chamber_trend_agent" if extra == "trend" else "part_history_agent"
                    ls = [_ind_txt(i, []) for i in o.get("indicators", [])] or [f"{k}: {v}" for k, v in (o.get("signals") or {}).items()]
                    if unavailable_line(aid):
                        ls.append(unavailable_line(aid))
                    blocks.append({"kind": extra, "title": f"{'PM 사이클 추이' if extra == 'trend' else '부품 이력'} · {aid} {ver.get(aid, '-')}",
                                   "lines": ls or ["-"]})
            hl = []
            if hist.get("status") == "ok" and hist.get("n_cases"):
                bc = {int(k): v for k, v in hist["by_count"].items()}
                hl.append(f"동일 챔버 {req['entities'].get('pm_type')} 후 최근 {hist['n_cases']}회 ({hist['period'][0]} ~ {hist['period'][1]}): " +
                          ", ".join(f"{k}매 1차 Pass {v['pass']}/{v['n']} ({v['pass'] / v['n'] * 100:.0f}%)" for k, v in sorted(bc.items())))
                fails = [r for r in hist["recent"] if not r["pass1"]]
                if fails:
                    sig = self._fail_signal_note(fails)
                    if sig:
                        hl.append(sig)
                dec = [f"{c}={v['meaning']}({v['source']})" for c, v in (hist.get("decoded") or {}).items() if v and "추론" in (v.get("source") or "")]
                if dec:
                    hl.append("코드값 해석: " + ", ".join(dec))
            elif hist.get("absence") == "no_history":
                hl.append("동일 조건 과거 이력 없음 (신규 조건) — 이력 기반 보정 없음")
            elif hist:
                hl.append(f"과거 Qual 이력 조회 불가 ({hist.get('note') or '데이터 부재'}) → 기준정보 기본값 기준")
            ul = unavailable_line("legacy_agent")
            if ul:
                hl.append(ul)
            if hl:
                blocks.append({"kind": "history", "title": f"과거 이력 · legacy_agent {ver.get('legacy_agent', '-')}", "lines": hl,
                               "warn": bool(ul) or hist.get("absence") == "data_absent"})
            if rec.get("status") == "ok":
                count = rec["count"]
                corr = rec.get("corrections", [])
                notes = list(rec.get("notes") or [])
                hs = history_suggestion(hist, count)
                conflict = None
                if hs:
                    conflict = f"Agent 결과 상충: 교훈 기반 {count}매 vs {hs['reason']} → 보수적 계획 {hs['count']}매"
                    count = hs["count"]
                mon = {"ETCH": ["Particle", "ER Monitor"], "CVD": ["Particle", "DR Monitor"], "PVD": ["Base Pressure", "Particle", "Rs Monitor"]}
                steps = ["Seasoning " + str(count) + "매"] + mon.get(spec.get("eqp_group"), ["Particle"])
                pre = [x["step"] for x in rec.get("extra_steps", [])]
                lines = [f"Seasoning {count}매 → " + " → ".join(steps[1:])]
                if pre:
                    lines.insert(0, "사전 단계: " + ", ".join(pre))
                if corr:
                    lines.append(f"보정: 기본 {rec['base']}매 " + " ".join(
                        f"{'+' if c['amount'] >= 0 else ''}{c['amount']}매 [교훈 {c['lesson_id']}: {c['reason']}, 원천 이력 {c['sources']}건]" for c in corr))
                else:
                    lines.append(f"보정 없음 (기본 {rec['base']}매)" + (" — 이력 기반 보정 없음, 1차 Fail 가능성 유의" if hist.get("absence") == "data_absent" else ""))
                if rec.get("expired_lessons"):
                    lines.append(f"만료 교훈 {len(rec['expired_lessons'])}건 (레시피 개정으로 적용 조건 불일치)")
                for x in rec.get("extra_steps", []):
                    lines.append(f"절차 교훈 {x['lesson_id']}: {x['reason']}")
                for n in notes:
                    lines.append(n)
                if rec.get("unavailable"):
                    lines.append("보정 입력 확인 불가: " + ", ".join(rec["unavailable"]) + " → 해당 보정 제외, 근거 부족 명시")
                if conflict:
                    lines.append(conflict)
                blocks.append({"kind": "recommendation", "title": "추천", "lines": lines, "count": count})
                rec_out = {"count": count, "required_est": hs["count"] if hs else rec["required_est"], "base": rec["base"],
                           "corrections": corr, "conflict": conflict,
                           "extra_steps": rec.get("extra_steps", []), "wait": any("대기" in x["step"] for x in rec.get("extra_steps", [])),
                           "signals": rec.get("signals_used", {}), "recipe_rev": rec.get("recipe_rev")}
            else:
                blocks.append({"kind": "recommendation", "title": "추천", "lines": ["추천 불가 — 기준정보 확인 필요"], "warn": True})
        elif rt in ("judge", "remeasure"):
            spec = res.get("spec") or {}
            meas = req.get("measurements") or []
            specs = spec.get("specs", [])
            if rt == "remeasure":
                have = {m["item"] for m in meas}
                specs = [x for x in specs if x["item"] in have]
            blocks.append({"kind": "procedure", "title": f"판정 기준 · spec_agent {ver.get('spec_agent')}",
                           "lines": [f"절차 {spec.get('procedure_id')}: " + ", ".join(_spec_txt(x) for x in specs)]})
            if spec.get("status") == "ok" and meas:
                j = judge_qual(spec.get("procedure_id"), specs, meas, self.sys.world.unit_conversions())
                jl = _judge_txt(j, req["entities"].get("chamber_id"), {})
                if rt == "remeasure":
                    jl = [x for x in jl if not x.startswith("승인 요청")] + ["재측정 항목만 판정 (나머지 항목은 기존 측정 결과 유지)"]
                blocks.append({"kind": "judgement", "title": "판정 · judge_qual (결정적 코드)", "lines": jl, "warn": j["result"] != "PASS"})
            h = res.get("hist")
            if h and h.get("n_cases"):
                blocks.append({"kind": "history", "title": f"참고 이력 · legacy_agent {ver.get('legacy_agent')}",
                               "lines": [f"최근 {h['n_cases']}회 이력 조회 (판정에는 미사용)"]})
        elif rt == "history":
            h = res.get("hist") or {}
            if h.get("n_cases"):
                bc = {int(k): v for k, v in h["by_count"].items()}
                blocks.append({"kind": "history", "title": f"과거 이력 · legacy_agent {ver.get('legacy_agent')}",
                               "lines": [f"최근 {h['n_cases']}회 ({h['period'][0]} ~ {h['period'][1]})"] +
                                        [f"{k}매: 1차 Pass {v['pass']}/{v['n']}" for k, v in sorted(bc.items())] +
                                        [f"{r['pm_end'][:10]} {r['n1']}매 {'PASS' if r['pass1'] else 'FAIL ' + (r['fail_items'] or '')} — {r['memo'][:40]}"
                                         for r in h["recent"][:6]]})
            else:
                blocks.append({"kind": "history", "title": "과거 이력", "lines": [h.get("note") or "이력 없음"]})
        elif rt == "trend":
            t = res.get("trend") or {}
            ag = next((r["agent_id"] for r in exe["runs"] if r["action"] == "trend"), "-")
            ls = [_ind_txt(i, []) for i in t.get("indicators", [])] or [t.get("error") or "추이 산출 불가"]
            blocks.append({"kind": "trend", "title": f"PM 사이클 추이 · {ag} {ver.get(ag, '')}", "lines": ls})
        elif rt == "analysis":
            a = res.get("analysis") or {}
            if a.get("status") == "ok":
                per = req.get("period") or {}
                bl = [f"{per.get('label', '')} {req['entities'].get('eqp_prefix', 'ETCH')} Qual {a['n_cases']}건 (1차 Fail {a['n_fail']}건)"]
                bl.append("Focus Ring 사용시간별 1차 Fail율: " + " / ".join(f"{b['bucket']} {b['rate'] * 100:.0f}% ({b['fail']}/{b['n']})"
                                                                  for b in a["buckets"] if b["n"]))
                lo, hi = a["buckets"][0], a["buckets"][-1]
                if lo["rate"] and hi["rate"]:
                    bl.append(f"600h 초과 상태 PM 시 1차 Fail 위험 {hi['rate'] / lo['rate']:.1f}배")
                    bl.append("제안: 600h 초과 챔버는 PM 시 Focus Ring 동시 교체 또는 Seasoning 보정 검토")
                if a.get("unknown_hours"):
                    bl.append(f"사용시간 산출 불가 {a['unknown_hours']}건 (교체 이력 없음) — 분석 제외")
                blocks.append({"kind": "analysis", "title": f"분석 결과 · part_history_agent {ver.get('part_history_agent')}", "lines": bl})
            else:
                blocks.append({"kind": "analysis", "title": "분석 결과", "lines": [a.get("error") or "분석 불가"], "warn": True})
        elif rt == "lot_trace":
            lt = res.get("lot") or {}
            blocks.append({"kind": "analysis", "title": f"Lot 추적 · lot_trace_agent {ver.get('lot_trace_agent')}",
                           "lines": [f"Lot {lt.get('lot')}: 장착 챔버 {lt.get('n', 0)}개"] +
                                    [f"{c['chamber_id']} ({c['installed_at'][:10]} 장착) — 이후 Qual {c['quals_after']}건, 1차 Fail {c['fails_after']}건"
                                     for c in lt.get("chambers", [])]})
        g = s.get("grow") or {}
        if g.get("ok"):
            blocks.insert(1, {"kind": "grow", "title": "Agent 생성 (L2 Grow)", "lines": g.get("lines", [])})
        text = render_blocks(blocks)
        self._node(s, "synthesize", "결과 종합", pace=0.2)
        return {"synth": {"blocks": blocks, "text": text, "recommendation": rec_out}}

    def _fail_signal_note(self, fails: list[dict]) -> str | None:
        ids = [f["qh_seq"] for f in fails]
        if not ids:
            return None
        rows = self.sys.store.all("SELECT content FROM experience WHERE kind='case' AND json_extract(content,'$.actual.qh_seq') IN (" +
                                  ",".join(str(int(i)) for i in ids) + ")")
        vals = [r["content"].get("signals", {}).get("rf_refl_delta_pct") for r in rows]
        vals = [v for v in vals if v is not None]
        if vals and len(vals) == len(ids) and all(v >= 10 for v in vals):
            return f"최근 1차 Fail {len(ids)}건 모두 PM 후 RF Reflected +10% 이상 (경험 메모리 대조)"
        return None

    # ── 노드: respond ──────────────────────────────────────────────
    def respond(self, s: L1State):
        req = s["request"]
        if s.get("clarify"):
            text = s["clarify"]
            blocks = [{"kind": "ask", "title": "확인 질문", "lines": [text]}]
            synth = {"blocks": blocks, "text": text, "recommendation": None}
        elif (s.get("grow") or {}) and not s["grow"].get("ok") and not s.get("synth"):
            g = s["grow"]
            blocks = [{"kind": "grow", "title": "Agent 생성 중단 (L2 Grow 예산 소진)", "lines": g.get("lines", []), "warn": True}]
            synth = {"blocks": blocks, "text": render_blocks(blocks), "recommendation": None}
        else:
            synth = s["synth"]
        if s.get("mode") != "replay":
            self.sys.store.update("requests", {"request_id": req["request_id"]},
                                  {"status": "answered", "response": synth, "rtype": req["rtype"], "entities": req["entities"]})
            self.sys.bus.emit("response", request_id=req["request_id"], thread_id=req.get("thread_id"), blocks=synth["blocks"],
                              text=synth["text"], rtype=req["rtype"], latency_ms=(s.get("exec") or {}).get("latency_ms"))
            self._log_orch(s)
            self.sys.bus.pace(0.6)
            if req["rtype"] == "autoqual" and synth.get("recommendation"):
                self.sys.fab.set_state(req["entities"]["chamber_id"], "QUAL", f"Seasoning {synth['recommendation']['count']}매 계획",
                                       thread_id=req.get("thread_id"))
        return {"synth": synth}

    def _log_orch(self, s: L1State):
        req = s["request"]
        exe = s.get("exec") or {}
        route = s.get("route") or {}
        if not exe:
            return
        direct = sorted({r["agent_id"] for r in exe.get("runs", []) if not r.get("indirect")})
        self.sys.store.insert("orch_log", {"ts": S(self.sys.clock.now()), "request_id": req["request_id"], "request_type": req["rtype"],
                                           "eqp_group": req["entities"].get("eqp_group"), "agents": direct,
                                           "contributions": {}, "plan_source": (s.get("plan") or {}).get("source"),
                                           "latency_ms": exe.get("latency_ms"), "human_confirm": int(bool(req.get("human_confirm"))),
                                           "extra": {"chamber_id": req["entities"].get("chamber_id"), "probs": route.get("probs"),
                                                     "plan_hash": hash(_plan_shape((s.get("plan") or {}).get("code", ""))) % 10 ** 8,
                                                     "outputs": _contrib_view(exe.get("outputs", {})),
                                                     "recommendation": (s.get("synth") or {}).get("recommendation"),
                                                     "recent_fail": req.get("_recent_fail")}}, replace=False)

    def _after_respond_ops(self, s: L1State):
        if s.get("clarify") or not (s.get("synth") or {}).get("recommendation"):
            return "log" if s.get("exec") else "end"
        return "await" if s["request"]["rtype"] == "autoqual" else "log"

    # ── 노드: await_qual_result (interrupt) ────────────────────────
    def await_qual_result(self, s: L1State):
        qual = dict(s.get("qual") or {"attempts": [], "status": "seasoning"})
        rec = s["synth"]["recommendation"]
        plan_count = qual.get("next_count") or rec["count"]
        self._node(s, "await_qual_result", f"Qual 결과 대기 (Seasoning {plan_count}매 → 측정)", pace=0.2)
        payload = interrupt({"kind": "measurement", "chamber_id": s["request"]["entities"]["chamber_id"], "count": plan_count,
                             "attempt": len(qual["attempts"]) + 1, "wait": rec.get("wait"), "request_id": s["request"]["request_id"]})
        qual["pending"] = payload
        qual["status"] = "measuring"
        return {"qual": qual}

    def deterministic_judge(self, s: L1State):
        qual = dict(s.get("qual") or {"attempts": []})
        exe = s.get("exec") or {}
        spec = (exe.get("result") or {}).get("spec") or {}
        payload = qual.get("pending") or {}
        meas = payload.get("measurements", [])
        if s.get("mode") != "replay" and qual.get("partial"):
            have = {m["item"] for m in meas}
            meas = [m for m in qual["partial"] if m["item"] not in have] + meas
        j = judge_qual(spec.get("procedure_id"), spec.get("specs", []), meas, self.sys.world.unit_conversions())
        att = {"count": payload.get("count"), "measurements": meas, "judgement": j, "override": payload.get("override"),
               "wait": payload.get("wait")}
        qual["last"] = att
        if j["result"] in ("PASS", "FAIL"):
            qual["attempts"] = qual.get("attempts", []) + [att]
            qual.pop("partial", None)
        else:
            qual["partial"] = meas
        qual["status"] = "judged"
        if s.get("mode") != "replay":
            self._node(s, "deterministic_judge", f"judge_qual → {j['result']}", judgement=j, pace=0.4)
            self.sys.bus.emit("judge", request_id=s["request"]["request_id"], judgement=j, count=payload.get("count"),
                              chamber_id=s["request"]["entities"].get("chamber_id"))
            self.sys.bus.pace(0.5)
            txt = _judge_txt(j, s["request"]["entities"].get("chamber_id"), payload)
            self.sys.bus.emit("response", request_id=s["request"]["request_id"], thread_id=s["request"].get("thread_id"),
                              blocks=[{"kind": "judgement", "title": "판정 · judge_qual (결정적 코드)", "lines": txt,
                                       "warn": j["result"] != "PASS"}], text="\n".join(txt), rtype="judge")
        return {"qual": qual}

    def _after_judge(self, s: L1State):
        q = s["qual"]
        j = q["last"]["judgement"]["result"]
        if j == "PASS":
            return "approve"
        if j == "FAIL":
            fails = sum(1 for a in q["attempts"] if a["judgement"]["result"] == "FAIL")
            if fails >= self.sys.policy["loop_budget"]["L1"]["max_qual_fail"]:
                return "log"
            return "rework"
        return "wait"

    def rework_plan(self, s: L1State):
        q = dict(s["qual"])
        j = q["last"]["judgement"]
        prev = q["last"].get("count") or s["synth"]["recommendation"]["count"]
        fails = sum(1 for a in q["attempts"] if a["judgement"]["result"] == "FAIL")
        if j["rework_type"] == "reseason":
            nxt, why = prev + 10, f"{', '.join(j['fail_items'])} Fail → Seasoning 부족 계열, 이력 기반 재Seasoning +10매"
        elif j["rework_type"] == "bp_wait":
            nxt, why = prev, "Leak/BP Fail → Base Pressure 안정화 30분 대기 후 재측정"
        else:
            nxt, why = prev, "Particle 단독 Fail → Purge 후 재측정 (매수 유지)"
        q["next_count"] = nxt
        q["status"] = "rework"
        self._node(s, "rework_plan", f"재작업 계획 ({fails}/3): {why}", pace=0.3)
        self.sys.bus.emit("response", request_id=s["request"]["request_id"], thread_id=s["request"].get("thread_id"),
                          blocks=[{"kind": "rework", "title": f"재계획 (1차 Fail 누적 {fails}회, L1 예산 3회)",
                                   "lines": [why, f"다음 시도: Seasoning {nxt}매 → 재측정·재판정"], "warn": True}], text=why, rtype="rework")
        self.sys.fab.set_state(s["request"]["entities"]["chamber_id"], "QUAL", f"재작업 {fails}회차 (Seasoning {nxt}매)",
                               thread_id=s["request"].get("thread_id"))
        return {"qual": q}

    # ── 노드: approval_gate (interrupt, 사람 승인) ─────────────────
    def approval_gate(self, s: L1State):
        ents = s["request"]["entities"]
        apr = dict(s.get("approval") or {})
        if not apr.get("request_id"):
            # interrupt 재개 시 노드가 처음부터 재실행되므로 요청별로 멱등하게 승인 요청을 찾는다
            prev = self.sys.store.one("SELECT * FROM approvals WHERE kind='state_change' AND json_extract(payload,'$.request_id')=? "
                                      "ORDER BY requested_ts DESC LIMIT 1", (s["request"]["request_id"],))
            if prev:
                apr = prev
        if not apr.get("request_id"):
            q = s["qual"]
            ev = {"judgement": q["last"]["judgement"], "count": q["last"].get("count"), "procedure": (s["exec"]["result"].get("spec") or {}).get("procedure_id"),
                  "recommendation": s["synth"]["recommendation"], "attempts": len(q["attempts"])}
            apr = self.sys.approvals.request("state_change", f"{ents['chamber_id']} DOWN → UP 전환", {
                "eqp_id": ents["eqp_id"], "chamber_id": ents["chamber_id"], "from_state": "DOWN", "to_state": "UP", "evidence": ev,
                "request_id": s["request"]["request_id"], "thread_id": s["request"].get("thread_id")})
            self.sys.fab.set_state(ents["chamber_id"], "APPROVAL", "Up 승인 대기", thread_id=s["request"].get("thread_id"))
        self._node(s, "approval_gate", f"승인 대기 {apr['request_id']} (Jev 확신도와 무관하게 사람 승인 필수)", pace=0.2)
        decision = interrupt({"kind": "approval", "approval_id": apr["request_id"], "chamber_id": ents["chamber_id"]})
        apr.update(decision or {})
        return {"approval": apr}

    def apply_state_change(self, s: L1State):
        ents = s["request"]["entities"]
        apr = s["approval"]
        if apr.get("approved"):
            self.sys.fab.set_state(ents["chamber_id"], "RUN", f"Up 전환 (승인 {apr.get('approver')})", thread_id=None)
            line = f"{ents['chamber_id']} DOWN → UP 반영 완료 (승인자 {apr.get('approver')}, {apr.get('decided_ts', '')})"
        else:
            self.sys.fab.set_state(ents["chamber_id"], "DOWN", f"Up 반려: {apr.get('reason')}", thread_id=s["request"].get("thread_id"))
            line = f"승인 반려 — 상태 DOWN 유지 (사유: {apr.get('reason')}), 반려 사유 경험 메모리 기록"
        self._node(s, "apply_state_change", line, pace=0.3)
        self.sys.bus.emit("response", request_id=s["request"]["request_id"], thread_id=s["request"].get("thread_id"),
                          blocks=[{"kind": "state", "title": "장비 상태 변경", "lines": [line], "warn": not apr.get("approved")}],
                          text=line, rtype="state")
        return {"done": True}

    def log_experience(self, s: L1State):
        req = s["request"]
        ents = req["entities"]
        q = s.get("qual") or {}
        rec = (s.get("synth") or {}).get("recommendation")
        if req["rtype"] == "autoqual" and rec:
            first = (q.get("attempts") or [None])[0]
            content = {"mode": "ops", "request_id": req["request_id"], "eqp_id": ents.get("eqp_id"), "chamber_id": ents.get("chamber_id"),
                       "eqp_model": ents.get("eqp_model"), "pm_start": ents.get("pm_start"), "request_ts": req.get("ts") or ents.get("pm_end"),
                       "eqp_group": ents.get("eqp_group"), "pm_type": ents.get("pm_type"), "pm_end": ents.get("pm_end"),
                       "recipe_rev": rec.get("recipe_rev"), "signals": rec.get("signals", {}), "recommendation": rec,
                       "actual": {"n1": first["count"] if first else None,
                                  "pass1": (first["judgement"]["result"] == "PASS") if first else None,
                                  "fail_items": ",".join(first["judgement"]["fail_items"]) if first else None,
                                  "final_count": q["attempts"][-1]["count"] if q.get("attempts") else None,
                                  "final_pass": q["attempts"][-1]["judgement"]["result"] == "PASS" if q.get("attempts") else None,
                                  "attempts": len(q.get("attempts") or []), "eng": (first or {}).get("override", {}) and first["override"].get("engineer") if first else None,
                                  "wait": bool(first and first.get("wait"))},
                       "override": (first or {}).get("override") if first else None,
                       "approval": {k: (s.get("approval") or {}).get(k) for k in ("request_id", "approved", "approver", "reason")},
                       "versions": {r["agent_id"]: r["version"] for r in (s.get("exec") or {}).get("runs", [])},
                       "escalated": bool(q.get("attempts")) and sum(1 for a in q["attempts"] if a["judgement"]["result"] == "FAIL") >= 3}
            self.sys.memory.record("case", content, self.sys.clock.now(), eqp_model=ents.get("eqp_model"), chamber_id=ents.get("chamber_id"),
                                   pm_type=ents.get("pm_type"))
            if content["escalated"]:
                self.sys.bus.emit("response", request_id=req["request_id"], thread_id=req.get("thread_id"),
                                  blocks=[{"kind": "escalate", "title": "엔지니어 에스컬레이션 (L1 예산 소진)",
                                           "lines": ["동일 건 1차 Fail 3회 누적 — 추천 중단", "Wet Clean 재수행·부품 점검 검토 요청"], "warn": True}],
                                  text="에스컬레이션", rtype="escalate")
                self.sys.fab.set_state(ents["chamber_id"], "DOWN", "Fail 3회 — 엔지니어 에스컬레이션", thread_id=None)
        self._node(s, "log_experience", "실행 기록·Override·실제 Qual 결과 → 경험 메모리 (L3 진화 재료)", pace=0.2)
        return {"done": True}

    # ── 리플레이 전용 노드 ─────────────────────────────────────────
    def replay_measure(self, s: L1State):
        rp = s["replay"]
        ctx = RunContext(self.sys, mode="replay", replay_clock=P(rp["meas_ts"]), request_id=s["request"].get("request_id"),
                         quiet=self.sys.bus.mute_depth > 0)
        r = self.sys.runtime.run_agent(ctx, "legacy_agent", "measurements", {"qh_seq": rp["qh_seq"], "meas_seq": 1})
        meas = (r.get("output") or {}).get("measurements", []) if r["ok"] else []
        return {"qual": {"attempts": [], "pending": {"measurements": meas, "count": rp["n1"], "unresolved": (r.get("output") or {}).get("unresolved")},
                         "meas_ok": r["ok"], "meas_version": r.get("version")}}

    def compare_actual(self, s: L1State):
        rp = s["replay"]
        rec = (s.get("synth") or {}).get("recommendation")
        q = s.get("qual") or {}
        j = (q.get("last") or {}).get("judgement") or {}
        n1 = rp["n1"]
        lo, hi = self.sys.policy["lesson"]["physical_seasoning_range"]
        outlier = n1 is None or not (lo <= n1 <= hi)
        pred_pass = (n1 >= rec["required_est"]) if (rec and not outlier) else None
        actual = rp["q1"] == "P"
        pred_ok = (pred_pass == actual) if pred_pass is not None else False
        judge_ok = (j.get("result") == ("PASS" if actual else "FAIL"))
        match = pred_ok and judge_ok
        exe = s.get("exec") or {}
        sig = dict((rec or {}).get("signals") or {})
        content = {"mode": "replay", "qh_seq": rp["qh_seq"], "eqp_id": rp["eqp_id"], "chamber_id": rp["chamber_id"],
                   "eqp_group": rp["eqp_group"], "pm_type": rp["pm_type"], "pm_end": rp["pm_end"], "recipe_rev": (rec or {}).get("recipe_rev"),
                   "signals": sig, "recommendation": rec, "required_est": (rec or {}).get("required_est"),
                   "actual": {"qh_seq": rp["qh_seq"], "n1": n1, "pass1": actual, "fail_items": rp["fail_items"], "final_count": rp["final"],
                              "eng": rp["eng"], "wait": rp["wait"], "memo": rp["memo"]},
                   "judge": {"result": j.get("result"), "hold": [h["item"] for h in j.get("hold", [])], "missing": j.get("missing", [])},
                   "match": {"pred": pred_ok, "judge": judge_ok, "overall": match, "outlier": outlier},
                   "versions": {r["agent_id"]: r["version"] for r in exe.get("runs", [])},
                   "history": {k: v for k, v in ((exe.get("result") or {}).get("hist") or {}).items() if k in ("by_count", "n_cases", "status", "absence", "sufficient_count")},
                   "spec_ref": {"procedure_id": ((exe.get("result") or {}).get("spec") or {}).get("procedure_id")},
                   "unavailable": [u["agent_id"] + ":" + u["item"] for u in (s.get("observe") or {}).get("unavailable", [])],
                   "quarter": rp["quarter"], "split": rp["split"], "latency_ms": exe.get("latency_ms"), "request_ts": rp["request_ts"],
                   "meas_ts": rp["meas_ts"], "pm_start": rp["pm_start"], "eqp_model": rp["eqp_model"], "guard_blocked": exe.get("guard_blocked", 0),
                   "leaks": exe.get("leaks", 0)}
        self.sys.memory.record("case", content, rp["evt_ts"], eqp_model=rp["eqp_model"], chamber_id=rp["chamber_id"],
                               pm_type=rp["pm_type"], buffered=True, mid=f"C-R{rp['qh_seq']}")
        return {"compare": {"pred_ok": pred_ok, "judge_ok": judge_ok, "match": match, "outlier": outlier,
                            "required_est": (rec or {}).get("required_est"), "guard_blocked": exe.get("guard_blocked", 0), "leaks": exe.get("leaks", 0)}}


# ── 렌더링 ─────────────────────────────────────────────────────────
def _unavail(r: dict) -> dict:
    e = r.get("error") or {}
    msg = e.get("message") or "; ".join(v["message"] for v in r.get("violations") or [])
    out = {"status": "unavailable", "error": msg, "unavailable": ["ALL"]}
    if r.get("output") and isinstance(r["output"], dict):
        out = dict(r["output"], status="unavailable", error=msg)
    return out


def _spec_txt(x: dict) -> str:
    nm = {"PARTICLE": "Particle", "ER": "ER", "ER_UNIF": "Unif", "DR": "DR", "THK_UNIF": "THK Unif", "RS_UNIF": "Rs Unif",
          "BASE_PRESSURE": "Base Pressure", "LEAK_RATE": "Leak"}.get(x["item"], x["item"])
    if x.get("lower") is not None and x.get("upper") is not None:
        c = (x["lower"] + x["upper"]) / 2
        return f"{nm}({c:,.0f}±{(x['upper'] - c) / c * 100:.0f}% {x['unit'].replace('A/min', 'Å/min')})"
    up = x.get("upper")
    upt = f"{up:.1e}" if isinstance(up, float) and up < 0.001 else f"{up:g}"
    return f"{nm}(≤{upt}{'' if x['unit'] in ('%',) else ' '}{x['unit'].replace('A/min', 'Å/min')})"


def _ind_txt(ind: dict, specs: list) -> str:
    name, v, u = ind["name"], ind["value"], ind.get("unit") or ""
    sp = {s["item"]: s for s in specs}
    if name == "LEAK_RATE":
        s = sp.get("LEAK_RATE")
        return f"Leak Rate {v:g} {u}" + (f" (Spec ≤{s['upper']:g}) {'정상' if v <= s['upper'] else '초과'}" if s else "")
    if name == "RF_REFL_DELTA":
        src = " (Run Summary 폴백)" if ind.get("source") == "run_summary" else ""
        return f"RF Reflected Power 초기값 PM 전 대비 {v:+.1f}%{src}"
    if name == "BASE_PRESSURE":
        s = sp.get("BASE_PRESSURE")
        return f"Base Pressure {v:.2e} {u}" + (f" (Spec ≤{s['upper']:.1e}) {'정상' if v <= s['upper'] else '이상'}" if s else "")
    if name == "RF_STABLE_AT":
        return f"RF Forward 안정화 시각 {v}"
    if name == "RF_FWD_CV":
        return f"RF Forward 변동 {v:.2f}% ({'안정' if v < 1.0 else '불안정'})"
    if name == "BP_STABLE_MIN":
        return f"Base Pressure 안정화 {v}분" + (" (지연 — 안정화 대기 권장)" if v >= 25 else "")
    if name == "CYCLE_RF_HOURS":
        return f"직전 Wet Clean 이후 RF 누적 {v:,.0f}h" + (f" (사이클 시작 {str(ind.get('ref'))[:10]})" if ind.get("ref") else "")
    if name == "CYCLE_DAYS":
        return f"사이클 경과 {v}일"
    if name == "REFL_CYCLE_TREND":
        return f"사이클 간 PM 직후 RF Reflected 추이 {v:+.1f}%"
    return f"{name} {v} {u}"


def _judge_txt(j: dict, cid: str, payload: dict) -> list[str]:
    nm = {"PARTICLE": "Particle", "ER": "ER", "ER_UNIF": "Unif", "DR": "DR", "THK_UNIF": "THK Unif", "RS_UNIF": "Rs Unif",
          "BASE_PRESSURE": "BP", "LEAK_RATE": "Leak"}
    if j["result"] in ("INCOMPLETE", "HOLD"):
        out = []
        if j["missing"]:
            out.append("미측정 항목: " + ", ".join(j["missing"]) + " → PASS 판정 금지, measuring 상태 유지")
        for h in j["hold"]:
            out.append(f"{nm.get(h['item'], h['item'])} {h['value']}: {h['reason']} → 판정 보류")
        return out
    parts = []
    for d in j["details"]:
        unit = d["unit"].replace("A/min", "Å/min")
        conv = f" (입력 {d['input_value']:g} {d['input_unit']} → 환산)" if d["input_unit"] != d["unit"] else ""
        val = f"{d['value']:.2e}" if isinstance(d["value"], float) and d["value"] < 0.001 else f"{d['value']:,.4g}"
        parts.append(f"{nm.get(d['item'], d['item'])} {val}{unit if unit in ('%',) else ' ' + unit}{conv}{' ✗' if not d['pass'] else ''}")
    out = [" / ".join(parts) + f" → Qual {j['result']}"]
    if j.get("boundary_pass"):
        out.append("경계값 PASS: " + ", ".join(j["boundary_pass"]) + " (Spec 경계 포함 정의대로)")
    if j["result"] == "PASS":
        out.append(f"승인 요청: {cid} DOWN → UP 전환 (승인 패널)")
    else:
        out.append("Fail 항목: " + ", ".join(j["fail_items"]) + f" → rework ({j['rework_type']})")
    return out


def render_blocks(blocks: list[dict]) -> str:
    out = []
    for b in blocks:
        out.append(f"[{b['title']}]")
        out += [f"- {x}" for x in b["lines"]]
        out.append("")
    return "\n".join(out).strip()


def _plan_shape(code: str) -> str:
    body = "\n".join(ln for ln in code.splitlines() if not ln.strip().startswith("#"))
    return re.sub(r'"[A-Z]{3,4}-\d{2}-[ABC]"|\d+', "#", body)


def _contrib_view(outputs: dict) -> dict:
    out = {}
    for k, v in outputs.items():
        if not isinstance(v, dict):
            continue
        if k.startswith("log_agent"):
            out[k] = {"signals": v.get("signals")}
        elif k.startswith("legacy_agent"):
            out[k] = {"by_count": v.get("by_count"), "n": v.get("n_cases")}
        elif k.startswith("spec_agent:recommend"):
            out[k] = {"count": v.get("count"), "corr": [c["lesson_id"] for c in v.get("corrections", [])]}
        elif k.startswith("part_history_agent") or k.startswith("chamber_trend_agent"):
            out[k] = {"signals": v.get("signals")}
    return out
