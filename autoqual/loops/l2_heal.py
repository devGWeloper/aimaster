"""L2 Heal Loop (이벤트 단위, 최대 5회·15분) — LangGraph StateGraph.

jev_classify_error → diagnose_codeact → write_patch → check_blacklist → run_regression
  ─(전부 통과)→ register_version → cascade → reanswer_pending → END
  ─(실패)→ blacklist_patch → (예산 내) write_patch / (복구 불가·예산 소진) escalate_operator
외부 장애는 코드 패치 없이 백오프 재시도·운영자 알림. 동일 오류 시그니처는 Heal 1건만 수행(중복 기동 방지).
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from ..genomes.build import make_genome
from ..genomes.playbook import diagnosis_code, heal_candidates
from ..jev import ERROR_TYPES
from ..registry import diff_stats
from ..sandbox import ToolProxy, canonical_hash
from ..tools import P, RunContext, S, make_tools

LABEL = {"포맷 변경": "로그 형식 변경 감지", "스키마 변경": "스키마 변경 감지", "기준정보 누락": "기준정보 누락",
         "로직 오류": "로직 오류", "외부 장애": "외부 장애", "복구 불가": "복구 불가"}


class HealState(TypedDict, total=False):
    heal: dict


class Healer:
    def __init__(self, sysm):
        self.sys = sysm
        self.inflight: dict[str, dict] = {}       # signature → heal
        self.recent: dict[str, dict] = {}         # signature → 최근 종료 heal (중단 시 재기동 억제)
        self.locks: dict[str, threading.Lock] = {}
        self._lock = threading.Lock()
        g = StateGraph(HealState)
        for n in ("jev_classify_error", "diagnose_codeact", "write_patch", "check_blacklist", "run_regression", "register_version",
                  "blacklist_patch", "cascade", "reanswer_pending", "escalate_operator"):
            g.add_node(n, getattr(self, n))
        g.add_edge(START, "jev_classify_error")
        g.add_conditional_edges("jev_classify_error", lambda s: "escalate" if s["heal"].get("external") else "diagnose",
                                {"escalate": "escalate_operator", "diagnose": "diagnose_codeact"})
        g.add_edge("diagnose_codeact", "write_patch")
        g.add_conditional_edges("write_patch", lambda s: "escalate" if s["heal"].get("no_candidate") else "check",
                                {"escalate": "escalate_operator", "check": "check_blacklist"})
        g.add_conditional_edges("check_blacklist", lambda s: "skip" if s["heal"].get("blocked") else "test",
                                {"skip": "blacklist_patch", "test": "run_regression"})
        g.add_conditional_edges("run_regression", lambda s: "ok" if s["heal"].get("tests_ok") else "fail",
                                {"ok": "register_version", "fail": "blacklist_patch"})
        g.add_conditional_edges("blacklist_patch", self._after_fail, {"retry": "write_patch", "escalate": "escalate_operator"})
        g.add_edge("register_version", "cascade")
        g.add_edge("cascade", "reanswer_pending")
        g.add_edge("reanswer_pending", END)
        g.add_edge("escalate_operator", END)
        self.graph = g.compile()

    # ── 진입 ───────────────────────────────────────────────────────
    def trigger(self, run: dict, state: dict, ctx: RunContext) -> dict | None:
        sig = run.get("signature") or f"unknown:{run['agent_id']}"
        agent = self.sys.registry.agent(run["agent_id"])
        req = (state or {}).get("request") or {}
        pending = {"request_id": req.get("request_id"), "thread_id": req.get("thread_id"), "agent_id": run["agent_id"],
                   "action": run["action"], "inputs": (state.get("exec") or {}).get("req") if state else None}
        with self._lock:
            h = self.inflight.get(sig)
            if h and h["status"] in ("running", "queued"):
                h["pending"].append(pending)
                self.sys.bus.emit("heal", heal_id=h["heal_id"], event="dedupe", signature=sig,
                                  text=f"동일 오류 시그니처 Heal 진행 중 — 요청 {req.get('request_id')} 대기열 합류 (중복 기동 없음)")
                return {"heal_id": h["heal_id"], "status": "queued", "agent_id": run["agent_id"], "label": h.get("label")}
            last = self.recent.get(sig)
            if last and last["status"] in ("escalated", "external") and abs((ctx.clock() - P(last["clock"])).total_seconds()) < 3 * 86400:
                last["suppressed"] = last.get("suppressed", 0) + 1
                return {"heal_id": last["heal_id"], "status": "suppressed", "agent_id": run["agent_id"],
                        "label": f"{last['heal_id']} 중단 이력 — 재기동 억제(운영자 확인 대기)"}
            hid = self.sys.store.next_id("HEAL-", 3)
            num = int(hid.split("-")[1])
            err = run.get("error") or (run.get("violations") or [{}])[0]
            h = {"heal_id": hid, "num": num, "agent_id": run["agent_id"], "version": run["version"], "signature": sig,
                 "error": dict(err or {}), "violations": run.get("violations") or [], "action": run["action"],
                 "inputs": pending["inputs"] or {}, "clock": S(ctx.clock()), "replay": ctx.replay, "pending": [pending],
                 "attempts": [], "status": "running", "vsec": 0.0, "tokens": 0, "started": self.sys.clock.now().isoformat(sep=" "),
                 "wall0": time.time(), "agent_status": agent["status"] if agent else None}
            self.inflight[sig] = h
        if ctx.replay:
            self._run(h)
            return {"heal_id": hid, "status": h["status"], "ok": h["status"] == "healed", "agent_id": run["agent_id"], "label": h.get("label")}
        th = threading.Thread(target=self._run, args=(h,), daemon=True, name=f"heal-{hid}")
        th.start()
        h["thread"] = th
        return {"heal_id": hid, "status": "running", "agent_id": run["agent_id"], "label": "자동 복구 진행 중"}

    def _run(self, h: dict):
        lock = self.locks.setdefault(h["agent_id"], threading.Lock())
        with lock:
            try:
                self._emit_node(h, "start", f"L2 Heal Loop 진입 — {h['agent_id']} {h['version']} · {h['signature']}")
                out = self.graph.invoke({"heal": h})
                h.update(out["heal"])
            except Exception as e:  # noqa: BLE001
                h["status"] = "error"
                self.sys.bus.emit("toast", level="error", text=f"Heal {h['heal_id']} 내부 오류: {e}")
        with self._lock:
            self.inflight.pop(h["signature"], None)
            self.recent[h["signature"]] = {"heal_id": h["heal_id"], "status": h["status"], "clock": h["clock"]}
        h.pop("thread", None)
        self.sys.events_hook("heal_done", heal=h)

    # ── 헬퍼 ───────────────────────────────────────────────────────
    def _ctx(self, h, **kw) -> RunContext:
        return RunContext(self.sys, mode="replay" if h["replay"] else "ops", replay_clock=P(h["clock"]) if h["replay"] else None,
                          run_shadow=False, quiet=True, **kw)

    def _emit_node(self, h, node, detail, pace=0.35, **kw):
        if h["replay"] and self.sys.bus.mute_depth:
            return
        self.sys.bus.emit("node", loop="L2", node=node, heal_id=h["heal_id"], agent_id=h["agent_id"], detail=detail, **kw)
        self.sys.bus.pace(pace)

    def _budget(self, h) -> dict:
        b = self.sys.policy["loop_budget"]["L2"]
        return {"attempts": len(h["attempts"]), "max_attempts": b["max_attempts"], "minutes": round(h["vsec"] / 60, 1),
                "max_minutes": b["max_minutes"], "tokens": h["tokens"], "max_tokens": b["max_tokens"]}

    def _tick(self, h, sec):
        h["vsec"] += sec
        if not (h["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("budget", loop="L2", heal_id=h["heal_id"], **self._budget(h))

    # ── 노드 ───────────────────────────────────────────────────────
    def jev_classify_error(self, s):
        h = s["heal"]
        e = h["error"]
        ctxf = {"head": "classify_error", "error": {"type": e.get("type"), "message": e.get("message")},
                "migrated": bool(e.get("migrated")), "source_stale": bool(e.get("migrated"))}
        j = self.sys.jev.decide("오류 유형은?", "choice", ERROR_TYPES, ctxf)
        top = max(j["probs"].values())
        h["classification"] = {"type": j["answer"], "p": round(top, 2), "probs": j["probs"]}
        if top < self.sys.policy["jev"]["error_confidence"] and e.get("type") not in ("EmptyResult",):
            self._emit_node(h, "jev_classify_error", f"분류 확신도 {top:.2f} < 0.70 → LLM 에스컬레이션: 진단 코드 먼저 실행 후 재분류")
            diag = self._diagnose(h, "포맷 변경")
            hc = bool(diag.get("unknown")) or bool(diag.get("unit_token") and diag["unit_token"] != "mTorr/min")
            j = self.sys.jev.decide("오류 유형은? (진단 후 재분류)", "choice", ERROR_TYPES, dict(ctxf, header_changed=hc))
            top = max(j["probs"].values())
            h["classification"] = {"type": j["answer"], "p": round(top, 2), "probs": j["probs"], "reclassified": True}
            h["diag"] = diag
        h["label"] = LABEL.get(h["classification"]["type"], "오류 감지")
        self._tick(h, 2)
        if not (h["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("jev", head="classify_error", question="오류 유형 분류", probs=h["classification"]["probs"],
                              answer=h["classification"]["type"], heal_id=h["heal_id"])
        self._emit_node(h, "jev_classify_error", f"오류 유형: {h['classification']['type']} (Jev {h['classification']['p']:.2f})", pace=0.5)
        if h["classification"]["type"] == "외부 장애":
            h["external"] = True
        hist = self.sys.store.all("SELECT * FROM heal_index WHERE signature=? ORDER BY ts DESC", (h["signature"],))
        if hist:
            h["history_hits"] = [x["heal_id"] for x in hist]
            self._emit_node(h, "heal_history", f"Heal 이력 조회: 동일 시그니처 {', '.join(h['history_hits'])} — 해당 패치는 현재 버전에 이미 반영됨 → 신규 진단")
        return {"heal": h}

    def _diagnose(self, h, cls) -> dict:
        code = diagnosis_code(cls, h["error"])
        inp = h["inputs"] or {}
        pm_end = P(inp.get("pm_end") or h["clock"])
        pm_start = P(inp.get("pm_start") or S(pm_end - timedelta(hours=8)))
        ctx = self._ctx(h)
        rec = []
        proxy = ToolProxy(make_tools(ctx, h["agent_id"]), set(make_tools(ctx, h["agent_id"]).keys()) - {"call_agent"}, rec)
        g = {"tools": proxy, "EQP": inp.get("eqp_id"), "CID": inp.get("chamber_id"), "START": S(pm_start - timedelta(hours=8)),
             "END": S(pm_end)}
        r = self.sys.sandbox.execute(code, "healer", "1.0", None, globals_extra=g, timeout_s=20, replay=h["replay"], vts=h["clock"])
        if not (h["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("code", agent="healer", purpose=f"{h['heal_id']} 진단 (CodeAct)", code=code, heal_id=h["heal_id"],
                              output=_short(r.result if r.ok else r.error), model=self.sys.llm.model_for("codegen"))
        return r.result if r.ok and isinstance(r.result, dict) else {"error": (r.error or {}).get("message")}

    def diagnose_codeact(self, s):
        h = s["heal"]
        if "diag" not in h:
            h["diag"] = self._diagnose(h, h["classification"]["type"])
        d = h["diag"]
        if d.get("new_header"):
            cause = f"FDC 로그 헤더 변경: '{d['new_header'][:60]}' (시간 표기 {d.get('time_sample')}, {d.get('tz')})"
        elif d.get("unit_token"):
            cause = f"Leak Check 단위 토큰 '{d['unit_token']}' (값 {d.get('value')}) — 파싱은 성공했지만 단위 미해석 (에러 없는 오판)"
        elif d.get("candidates") is not None:
            cause = "이력 테이블 상태: " + " / ".join(f"{c['table']} {c['rows']}행{' (폐기)' if c['deprecated'] else ''}" for c in d["candidates"])
        else:
            cause = (h["error"].get("message") or "")[:100]
        h["cause"] = cause
        sl = d.get("slicing") or {}
        if sl.get("total_rows"):
            # 로그 원문 전체가 아니라 슬라이스만 관찰 — 헤더 종류 + 오류 지점 전후 + Run별 샘플
            h["slicing"] = (f"PM 전후 FDC 트레이스 {sl['runs']} Run 약 {sl['total_rows']:,}행 중 헤더 {sl['headers']}종 + 오류 지점 전후 각 "
                            f"{sl['around'] // 2}행 + Run별 샘플 {sl['sample'] // max(1, sl['runs'])}행만 추출 → LLM 관찰값 {sl['observed']}행 (원문의 {sl['ratio']}%)")
            self._emit_node(h, "diagnose_codeact", "로그 슬라이싱: " + h["slicing"], pace=0.5)
        self._tick(h, 25)
        self._emit_node(h, "diagnose_codeact", "진단: " + cause, pace=0.6)
        return {"heal": h}

    def write_patch(self, s):
        h = s["heal"]
        g = self.sys.registry.genome(h["agent_id"], h["version"])
        feats = set((g["params"] or {}).get("features", []))
        cands = h.get("cands")
        if cands is None:
            cands = heal_candidates(h["agent_id"], feats, h["classification"]["type"], h["error"], h.get("diag") or {})
            h["cands"] = cands
        idx = len(h["attempts"])
        if idx >= len(cands):
            h["no_candidate"] = True
            h["escalate_reason"] = "추가 패치 후보 없음"
            return {"heal": h}
        c = cands[idx]
        reg = self.sys.registry
        new_v = reg.next_version(h["agent_id"], h["version"], "patch")
        if h["attempts"]:
            new_v = h["attempts"][-1]["version"]
        log = list((g["params"] or {}).get("changelog", [])) + [f"{new_v}: Heal {h['heal_id']} — {c['summary']}"]
        gen = make_genome(self.sys, h["agent_id"], new_v, c["features"], log)
        prompt = (f"[Heal 패치 작성] Agent {h['agent_id']} {h['version']}\n오류: {h['error']}\n진단: {h.get('diag')}\n"
                  f"블랙리스트 패치 해시: {[a['hash'] for a in h['attempts']]}\n이전 시도 실패: {[a.get('failures') for a in h['attempts']]}\n"
                  f"현재 코드:\n{g['code']}\n수정된 전체 코드를 출력하라.")
        code, res = self.sys.llm.generate_code("codegen", "AutoQual Healer: 자기 코드 패치 작성(원본 로그 수정 금지, 회귀 통과 필수)", prompt, gen["code"])
        gen["code"] = code
        add, rem, diff = diff_stats(g["code"], code)
        att = {"n": idx + 1, "version": new_v, "summary": c["summary"], "features": sorted(c["features"]), "hash": canonical_hash(code),
               "diff_add": add, "diff_del": rem, "model": res.model, "source": res.source, "genome": gen, "diff": diff}
        h["attempts"].append(att)
        h["tokens"] += res.tokens_in + res.tokens_out
        self._tick(h, res.latency_s)
        h.pop("blocked", None)
        if not (h["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("code", agent="healer", purpose=f"{h['heal_id']} 패치 {idx + 1}회차 — {c['summary']}", code=diff, diff=True,
                              heal_id=h["heal_id"], model=res.model, source=res.source)
        self._emit_node(h, "write_patch", f"패치 {idx + 1}회차 작성 (+{add} / -{rem} lines, {res.model})", pace=0.8)
        return {"heal": h}

    def check_blacklist(self, s):
        h = s["heal"]
        att = h["attempts"][-1]
        hit = self.sys.store.one("SELECT * FROM blacklist WHERE patch_hash=?", (att["hash"],))
        if hit:
            h["blocked"] = True
            att["result"] = "blacklisted"
            self._emit_node(h, "check_blacklist", f"블랙리스트 일치 (정규화 AST 해시 {att['hash'][:10]}) — 동일 패치 재시도 차단")
        else:
            self._emit_node(h, "check_blacklist", f"블랙리스트 통과 (AST 해시 {att['hash'][:10]})", pace=0.2)
        return {"heal": h}

    def run_regression(self, s):
        h = s["heal"]
        att = h["attempts"][-1]
        reg = self.sys.registry
        gen = att["genome"]
        reg.add_genome(h["agent_id"], att["version"], gen["code"], params=gen["params"], deps=gen["deps"], tools=gen["tools"],
                       parent=h["version"], reason="heal", ref=h["heal_id"], status="candidate",
                       prompt=(reg.genome(h["agent_id"], h["version"]) or {}).get("prompt", ""))
        # 1) 재현 테스트: 실패했던 입력을 패치 버전으로 재실행
        ctx = self._ctx(h, overlay={h["agent_id"]: att["version"]})
        rr = self.sys.runtime._execute(ctx, h["agent_id"], att["version"], h["action"], h["inputs"], False)
        repro_ok = rr["ok"]
        repro_note = ""
        if repro_ok and h["agent_id"] == "legacy_agent":
            out = rr.get("output") or {}
            last = (out.get("recent") or [{}])[0].get("pm_end")
            if not out.get("n_cases") or not last or (P(h["clock"]) - P(last)).days > 400:
                repro_ok, repro_note = False, f"대체 소스 결과 {out.get('n_cases', 0)}건, 최신 {last or '-'} — 신선도 불변식 위반(400일 초과)"
        if not repro_ok and not repro_note:
            repro_note = (rr.get("error") or {}).get("message") or "; ".join(v["message"] for v in rr.get("violations") or [])
        # 2) 신규 포맷 샘플 (벤더 샘플/진단 결과 기반)
        new_cases = self._new_format_cases(h)
        self._emit_node(h, "run_regression", f"재현 테스트 {'통과' if repro_ok else '실패'}" + (f" ({repro_note[:70]})" if repro_note else "") +
                        f" → 회귀 테스트 실행 (기존 {len(self.sys.harness.tests_for(h['agent_id']))} + 신규 포맷 {len(new_cases)})", pace=0.3)
        progress = {"n": 0}

        def on_case(c, ok, why):
            progress["n"] += 1
            if not (h["replay"] and self.sys.bus.mute_depth) and (progress["n"] % 6 == 0 or not ok):
                self.sys.bus.emit("tests", heal_id=h["heal_id"], agent_id=h["agent_id"], version=att["version"], n=progress["n"],
                                  ok=ok, case=c["test_id"], label=c["expect"].get("label"), why=why)
                self.sys.bus.pace(0.05)

        res = self.sys.harness.run_tests(h["agent_id"], att["version"], extra=new_cases, on_case=on_case) if repro_ok else \
            {"passed": 0, "failed": 1, "total": 1, "failures": [{"case": "repro", "label": "재현 테스트", "error": repro_note}], "by_suite": {}}
        old_n = sum(v[1] for k, v in res["by_suite"].items() if k == "regression")
        new_n = sum(v[1] for k, v in res["by_suite"].items() if k == "new_format")
        att["tests"] = {"passed": res["passed"], "total": res["total"], "failures": res["failures"][:6], "old": old_n, "new": new_n}
        att["new_cases"] = new_cases
        h["tests_ok"] = repro_ok and res["failed"] == 0
        att["result"] = "pass" if h["tests_ok"] else "fail"
        self._tick(h, 8 + 1.6 * res["total"])
        fails = "; ".join(f"{f.get('label') or f['case']}: {f['error'][:50]}" for f in res["failures"][:2])
        self._emit_node(h, "run_regression", f"회귀 {res['passed']}/{res['total']} 통과" + ("" if h["tests_ok"] else f" — 실패: {fails}"), pace=0.6)
        return {"heal": h}

    def _new_format_cases(self, h) -> list[dict]:
        from eval.testcases import format_cases
        d = h.get("diag") or {}
        head = d.get("new_header", "")
        if h["agent_id"] == "log_agent" and head.startswith("TIME;RFFWD"):
            from mock_env import config as C
            return format_cases(self.sys, "3.8", sorted(C.OLD_SW_EQPS), 6, "T-LOG-V38-", "new_format", h["heal_id"],
                                since="2023-07-01", until=min(h["clock"], "2024-02-14"))
        if h["agent_id"] in ("log_agent", "chamber_trend_agent") and head.startswith("ts,"):
            from mock_env import config as C
            cs = format_cases(self.sys, "5.2", C.V52_EQPS, 6, "T-LOG-V52-", "new_format", h["heal_id"], since="2025-06-01", until="2026-06-30")
            for c in cs:
                c["input"]["force_format"] = "5.2"
                c["agent_id"] = h["agent_id"]
                c["expect"]["label"] += " [SW v5.2 벤더 샘플]"
            return cs if h["agent_id"] == "log_agent" else []
        return []

    def register_version(self, s):
        h = s["heal"]
        att = h["attempts"][-1]
        reg = self.sys.registry
        a = reg.agent(h["agent_id"])
        reg.activate(h["agent_id"], att["version"], "heal", ref=h["heal_id"], note=att["summary"])
        if a["status"] == "probation":
            pass
        for c in att.get("new_cases") or []:
            c2 = dict(c)
            c2["suite"] = "regression" if c["suite"] == "new_format" else c["suite"]
            self.sys.store.insert("tests", {"test_id": c2["test_id"], "agent_id": h["agent_id"], "suite": c2["suite"], "input": c2["input"],
                                            "expect": c2["expect"], "origin": h["heal_id"], "ts": self.sys.clock.now().strftime("%Y-%m-%d %H:%M:%S")})
        self.sys.store.insert("heal_index", {"signature": h["signature"], "heal_id": h["heal_id"], "agent_id": h["agent_id"],
                                             "patch_ref": f"{h['agent_id']}@{att['version']}", "ts": h["clock"]})
        h["status"] = "healed"
        h["new_version"] = att["version"]
        self._tick(h, 6)
        self._emit_node(h, "register_version", f"반영: {h['agent_id']} {h['version']} → {att['version']} (변경 이력 기록)", pace=0.5)
        return {"heal": h}

    def cascade(self, s):
        """같은 결함 코드(복제 파서 등)를 가진 다른 Agent를 찾아 Heal 이력 패치를 재사용해 연쇄 복구."""
        h = s["heal"]
        h["cascade"] = []
        att = h["attempts"][-1]
        if h["agent_id"] != "log_agent" or not (h.get("diag") or {}).get("new_header"):
            return {"heal": h}
        reg = self.sys.registry
        for a in reg.agents("agent"):
            if a["agent_id"] == h["agent_id"] or a["status"] in ("retired",):
                continue
            g = reg.genome(a["agent_id"])
            if not g or "def parse_v4" not in g["code"]:
                continue
            feats = set((g["params"] or {}).get("features", []))
            new_parser = {"v52"} if "v52" in att["features"] else ({"v3"} if "v3" in att["features"] else set())
            if new_parser <= feats:
                continue
            t0 = h["vsec"]
            probes = att.get("new_cases") or []
            if probes:
                pc = probes[0]["input"]
                probe_inp, pclock, pfmt = dict(pc["inputs"]), P(pc["clock"]), pc.get("force_format")
            else:
                probe_inp, pclock, pfmt = dict(h["inputs"]), P(h["clock"]), None
            ctx = RunContext(self.sys, mode="test", replay_clock=pclock, run_shadow=False, quiet=True, force_format=pfmt)
            r = self.sys.runtime._execute(ctx, a["agent_id"], g["version"], "trend", probe_inp, False)
            same = (not r["ok"]) and (r.get("error") or {}).get("key") == h["error"].get("key")
            if not same:
                continue
            new_v = reg.next_version(a["agent_id"], g["version"], "patch")
            log = list((g["params"] or {}).get("changelog", [])) + [f"{new_v}: Heal {h['heal_id']} 패치 재사용 (동일 오류 시그니처) — 복제 파서에 SW 포맷 분기 추가"]
            gen = make_genome(self.sys, a["agent_id"], new_v, feats | new_parser, log)
            reg.add_genome(a["agent_id"], new_v, gen["code"], params=gen["params"], deps=gen["deps"], tools=gen["tools"], parent=g["version"],
                           reason="heal", ref=h["heal_id"], status="candidate", prompt=g.get("prompt", ""))
            res = self.sys.harness.run_tests(a["agent_id"], new_v)
            ctx2 = RunContext(self.sys, mode="test", replay_clock=pclock, run_shadow=False, quiet=True, force_format=pfmt,
                              overlay={a["agent_id"]: new_v})
            rr = self.sys.runtime._execute(ctx2, a["agent_id"], new_v, "trend", probe_inp, False)
            res["passed"] += 1 if rr["ok"] else 0
            res["total"] += 1
            ok = res["failed"] == 0 and rr["ok"]
            add, rem, _ = diff_stats(g["code"], gen["code"])
            h["vsec"] += 80
            item = {"agent_id": a["agent_id"], "from": g["version"], "to": new_v if ok else None, "tests": f"{res['passed']}/{res['total']}",
                    "ok": ok, "vsec": round(h["vsec"] - t0), "diff_add": add, "diff_del": rem,
                    "why": "동일 오류 시그니처 (리플레이 중 생성 시 log_agent 파서를 복제 보유)"}
            if ok:
                reg.activate(a["agent_id"], new_v, "heal", ref=h["heal_id"], note=f"{h['heal_id']} 패치 재사용 (연쇄 복구)")
            h["cascade"].append(item)
            self._emit_node(h, "cascade", f"연쇄 복구: {a['agent_id']} {g['version']} → {new_v if ok else '실패'} (Heal 이력 패치 재사용, 회귀 {item['tests']})", pace=0.6)
        return {"heal": h}

    def reanswer_pending(self, s):
        h = s["heal"]
        self._report(h)
        self.sys.events_hook("heal_reanswer", heal=h)
        n = len([p for p in h["pending"] if p.get("request_id")])
        self._emit_node(h, "reanswer_pending", f"'확인 불가' 항목 재분석 → 추가 응답 {n}건" if n else "Heal 완료", pace=0.3)
        if not (h["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("toast", level="ok", text=f"Self-Healing {h['heal_id']}: {h['agent_id']} {h['version']} → {h['new_version']} "
                                                        f"({len(h['attempts'])}회 / {_mmss(h['vsec'])})")
        return {"heal": h}

    def blacklist_patch(self, s):
        h = s["heal"]
        att = h["attempts"][-1]
        if att.get("result") != "blacklisted":
            self.sys.store.insert("blacklist", {"patch_hash": att["hash"], "error_signature": h["signature"], "agent_id": h["agent_id"],
                                                "ts": h["clock"], "reason": "; ".join(f["error"][:60] for f in (att.get("tests") or {}).get("failures", [])[:2])})
            self.sys.registry.set_genome_status(h["agent_id"], att["version"], "rejected")
            self._emit_node(h, "blacklist_patch", f"{att['n']}회차 패치 기각 → 블랙리스트 등록 (해시 {att['hash'][:10]})", pace=0.4)
        return {"heal": h}

    def _after_fail(self, s):
        h = s["heal"]
        b = self.sys.policy["loop_budget"]["L2"]
        n = len(h["attempts"])
        if n >= b["max_attempts"] or h["vsec"] / 60 >= b["max_minutes"] or h["tokens"] >= b["max_tokens"]:
            h["escalate_reason"] = f"예산 소진 ({n}/{b['max_attempts']}회, {h['vsec'] / 60:.1f}/{b['max_minutes']}분)"
            return "escalate"
        if h["error"].get("type") == "EmptyResult" and n >= 3:
            j = self.sys.jev.decide("복구 불가인가?", "yes_no", ["yes", "no"],
                                    {"head": "unrecoverable", "failed_attempts": n, "all_alternatives_empty": 1, "source_stale": 1})
            h["unrecoverable_p"] = j["probs"]["yes"]
            if j["answer"] == "yes":
                h["classification"]["type"] = "복구 불가"
                h["escalate_reason"] = f"Jev 복구 불가 재분류 ({j['probs']['yes']:.2f}) — 예산 소진 전 조기 중단"
                if not (h["replay"] and self.sys.bus.mute_depth):
                    self.sys.bus.emit("jev", head="unrecoverable", question="복구 불가인가?", probs=j["probs"], answer=j["answer"], heal_id=h["heal_id"])
                return "escalate"
        return "retry"

    def escalate_operator(self, s):
        h = s["heal"]
        if h.get("external"):
            h["status"] = "external"
            h["escalate_reason"] = "외부 장애 — 코드 패치 없이 백오프 재시도, 운영자 알림 (멀쩡한 코드 수정 0건)"
        else:
            h["status"] = "escalated"
        self._report(h)
        self._emit_node(h, "escalate_operator", f"운영자 에스컬레이션: {h.get('escalate_reason')}", pace=0.5)
        if not (h["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("toast", level="warn", text=f"Heal {h['heal_id']} 중단 — {h['agent_id']}: {h.get('escalate_reason')}")
        return {"heal": h}

    def _report(self, h):
        att = h["attempts"][-1] if h["attempts"] else {}
        content = {"heal_id": h["heal_id"], "num": h["num"], "agent_id": h["agent_id"], "from_version": h["version"],
                   "to_version": h.get("new_version"), "status": h["status"], "signature": h["signature"],
                   "classification": h.get("classification"), "cause": h.get("cause"), "slicing": h.get("slicing"), "diag": _short(h.get("diag"), 1200),
                   "attempts": [{k: a.get(k) for k in ("n", "version", "summary", "hash", "diff_add", "diff_del", "result", "tests", "model", "source")}
                                for a in h["attempts"]],
                   "diff": att.get("diff", ""), "vsec": round(h["vsec"]), "mttr": _mmss(h["vsec"]), "tokens": h["tokens"],
                   "cascade": h.get("cascade", []), "pending": len(h["pending"]), "escalate_reason": h.get("escalate_reason"),
                   "replay": h["replay"], "clock": h["clock"], "error": {k: h["error"].get(k) for k in ("type", "message", "key", "field")},
                   "unrecoverable_p": h.get("unrecoverable_p"), "history_hits": h.get("history_hits")}
        title = f"Self-Healing 리포트 #{h['num']} — {h['agent_id']}"
        self.sys.store.insert("reports", {"report_id": h["heal_id"], "kind": "heal", "title": title, "ts": h["clock"], "content": content})
        if not (h["replay"] and self.sys.bus.mute_depth):
            self.sys.bus.emit("report", kind="heal", report_id=h["heal_id"], title=title, content=content)


def _short(x, n=600):
    s = str(x)
    return s if len(s) <= n else s[:n] + "…"


def _mmss(sec: float) -> str:
    sec = int(round(sec))
    return f"{sec // 60}분 {sec % 60:02d}초"
