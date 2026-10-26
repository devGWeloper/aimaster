"""Agent 실행 런타임 — Genome 코드를 샌드박스에서 실행하고 결과를 검증한다.

- 버전 해석: 평가 overlay > active. deprecated 는 대체 Agent로 리다이렉트(실패 시 원 Agent Fallback), retired 는 호출 불가
- 사후 검증(루프 밖 고정 규칙): 스키마, 물리적 값 범위, 0건(데이터 부재) → 실패 시 Heal 트리거 대상
- Shadow: 승격 전(후보) / 승격 후(직전 버전)를 병행 실행해 판정 관련 출력 비교
"""
from __future__ import annotations

import time

from .sandbox import Namespace, ToolProxy
from .schemas import validate
from .tools import RunContext, make_tools

RANGE_RULES = {"LEAK_RATE": ("mTorr/min", "LEAK_RATE"), "RF_REFL_DELTA": ("%", "RF_REFL_DELTA")}


class AgentRuntime:
    def __init__(self, sysm):
        self.sys = sysm
        self._skills: dict[tuple, Namespace] = {}
        self.service_cache: dict[str, dict] = {}       # Agent별 캐시 서비스(tools.cache_get/put)
        self.shadow_log: list[dict] = []
        self.call_stats: list[tuple] = []

    def reset(self):
        self._skills.clear()
        self.service_cache.clear()
        self.shadow_log.clear()
        self.call_stats.clear()

    # ── 스킬 ────────────────────────────────────────────────────────
    def _skill(self, sid: str, ver: str) -> Namespace:
        key = (sid, ver)
        ns = self._skills.get(key)
        if ns is None:
            g = self.sys.registry.genome(sid, ver)
            if g is None:
                raise RuntimeError(f"스킬 {sid}@{ver} 없음")
            ns = Namespace(self.sys.sandbox.load_module(g["code"], f"{sid}@{ver}"))
            self._skills[key] = ns
        return ns

    def skills_for(self, genome: dict, ctx: RunContext) -> Namespace:
        deps = dict((genome.get("deps") or {}).get("skills", {}))
        for sid in list(deps):
            ov = ctx.overlay.get(sid)
            if ov:
                deps[sid] = ov
        return Namespace({sid: self._skill(sid, v) for sid, v in deps.items()})

    # ── 실행 ────────────────────────────────────────────────────────
    def run_agent(self, ctx: RunContext, agent_id: str, action: str, inputs: dict, indirect: bool = False,
                  _redirected: bool = False, version: str | None = None):
        reg = self.sys.registry
        a = reg.agent(agent_id)
        if a is None or a["status"] == "retired":
            out = {"agent_id": agent_id, "version": None, "action": action, "ok": False, "output": None,
                   "error": {"type": "AgentRetired", "message": f"{agent_id}: retired/미등록"}, "violations": [], "elapsed_ms": 0, "io_ms": 0}
            return out["output"] if indirect else out
        if a["status"] == "deprecated" and a.get("replacement") and not _redirected and agent_id not in ctx.overlay and ctx.mode == "ops":
            r = self.run_agent(ctx, a["replacement"], action, inputs, indirect, _redirected=True)
            ok = (r.get("status") in ("ok", "partial")) if indirect else r["ok"]
            if ok:
                if not indirect:
                    r["redirected_from"] = agent_id
                self.sys.bus.emit("redirect", agent_id=agent_id, to=a["replacement"], ok=True)
                return r
            self.sys.bus.emit("redirect", agent_id=agent_id, to=a["replacement"], ok=False,
                              error=(r.get("error") or {}).get("message") if not indirect else r.get("error"))
            self.sys.events_hook("redirect_failed", agent_id=agent_id, replacement=a["replacement"], inputs=inputs, ctx=ctx,
                                 result=r)
        ver = version or ctx.overlay.get(agent_id) or a["active_version"]
        res = self._execute(ctx, agent_id, ver, action, inputs, indirect)
        if not res["ok"] and ctx.mode == "ops" and not _redirected:
            # 대체 Agent 실패 시 유예 중(deprecated)인 원 Agent로 Fallback (폐기 과정 요청 실패 0건)
            orig = next((x for x in reg.agents("agent") if x["status"] == "deprecated" and x.get("replacement") == agent_id), None)
            if orig and action == "trend":
                fb = self._execute(ctx, orig["agent_id"], orig["active_version"], action, inputs, indirect)
                self.sys.bus.emit("redirect", agent_id=orig["agent_id"], to=agent_id, ok=False, fallback=fb["ok"],
                                  error=(res.get("output") or {}).get("error") or (res.get("error") or {}).get("message"))
                self.sys.events_hook("redirect_failed", agent_id=orig["agent_id"], replacement=agent_id, inputs=inputs, ctx=ctx, result=res)
                if fb["ok"]:
                    fb["fallback_from"] = agent_id
                    res = fb
        if _redirected:
            res["redirected"] = True
        # Shadow 병행 (운영 모드, 직접·간접 공통)
        if ctx.run_shadow and ctx.mode == "ops" and a.get("shadow_version") and agent_id not in ctx.overlay:
            self._shadow(ctx, a, ver, action, inputs, res)
        if ctx.mode == "ops" and not ctx.quiet:
            reg.record_call(agent_id, indirect)
        if indirect:
            if res["ok"]:
                return res["output"]
            return {"status": "unavailable", "error": (res.get("error") or {}).get("message") or
                    "; ".join(v["message"] for v in res["violations"]), "unavailable": ["ALL"]}
        return res

    def _execute(self, ctx: RunContext, agent_id: str, ver: str, action: str, inputs: dict, indirect: bool) -> dict:
        reg = self.sys.registry
        g = reg.genome(agent_id, ver)
        if g is None:
            return {"agent_id": agent_id, "version": ver, "action": action, "ok": False, "output": None,
                    "error": {"type": "GenomeMissing", "message": f"{agent_id}@{ver} 없음"}, "violations": [], "elapsed_ms": 0, "io_ms": 0}
        rec: list = []
        impl = make_tools(ctx, agent_id)
        cache = (ctx.cache_store.setdefault(agent_id, {}) if ctx.cache_store is not None
                 else self.service_cache.setdefault(agent_id, {}))
        impl["cache_get"] = lambda key: cache.get(key)
        impl["cache_put"] = lambda key, value: cache.__setitem__(key, value)
        allowed = set(g["tools"] or []) | {"now", "cache_get", "cache_put"}
        proxy = ToolProxy(impl, allowed, rec)
        try:
            skills = self.skills_for(g, ctx)
        except Exception as e:  # noqa: BLE001
            return {"agent_id": agent_id, "version": ver, "action": action, "ok": False, "output": None,
                    "error": {"type": "SkillLoadError", "message": str(e)}, "violations": [], "elapsed_ms": 0, "io_ms": 0}
        io0 = ctx.io_ms
        ctx.stack.append(agent_id)
        if not ctx.quiet:
            self.sys.bus.emit("agent_start", agent_id=agent_id, version=ver, action=action, indirect=indirect,
                              caller=ctx.stack[-2] if len(ctx.stack) > 1 else "super_agent", request_id=ctx.request_id)
        t0 = time.perf_counter()
        r = self.sys.sandbox.execute(g["code"], agent_id, ver, "run", (action, inputs, proxy, skills), timeout_s=12.0,
                                     tool_calls=rec, replay=ctx.replay, vts=ctx.clock().strftime("%Y-%m-%d %H:%M:%S"))
        ctx.stack.pop()
        io = ctx.io_ms - io0
        violations = []
        if r.ok:
            ok, msg = validate(agent_id, action, r.result)
            if not ok:
                violations.append({"type": "SchemaViolation", "message": msg, "field": "schema"})
            else:
                violations += self.post_validate(agent_id, action, r.result, inputs)
        sig = None
        if not r.ok:
            e = r.error
            sig = f"{e['type']}:{agent_id}:{e.get('key') or (e.get('message') or '')[:40]}"
        elif violations:
            v = violations[0]
            sig = f"{v['type']}:{agent_id}:{v.get('field')}"
        out = {"agent_id": agent_id, "version": ver, "action": action, "ok": r.ok and not violations,
               "output": r.result if r.ok else None, "error": r.error, "violations": violations,
               "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2), "io_ms": round(io, 1), "audit_id": r.audit_id,
               "tool_calls": [c["tool"] for c in rec], "signature": sig, "indirect": indirect, "stdout": r.stdout}
        ctx.calls.append({k: out[k] for k in ("agent_id", "version", "action", "ok", "io_ms", "indirect", "signature")})
        if ctx.mode == "ops" and ctx.run_shadow:
            self.call_stats.append((ctx.clock().strftime("%Y-%m-%d %H:%M:%S"), agent_id, ver, action, out["io_ms"] + out["elapsed_ms"]))
        if not ctx.quiet:
            self.sys.bus.emit("agent_end", agent_id=agent_id, version=ver, action=action, ok=out["ok"], indirect=indirect,
                              io_ms=out["io_ms"], tool_calls=out["tool_calls"][:12], audit_id=r.audit_id, request_id=ctx.request_id,
                              error=(r.error or {}).get("message") if r.error else (violations[0]["message"] if violations else None),
                              status=(r.result or {}).get("status") if r.ok and isinstance(r.result, dict) else None)
        return out

    # ── 사후 검증 (루프 밖 고정 규칙) ────────────────────────────────
    def post_validate(self, agent_id: str, action: str, out: dict, inputs: dict) -> list[dict]:
        pol = self.sys.policy["post_validation"]
        v = []
        for ind in out.get("indicators", []) or []:
            name, val = ind.get("name"), ind.get("value")
            if not isinstance(val, (int, float)):
                continue
            if name == "LEAK_RATE" and not (pol["LEAK_RATE"][0] <= val <= pol["LEAK_RATE"][1]):
                v.append({"type": "ValueRangeViolation", "field": "LEAK_RATE",
                          "message": f"Leak Rate {val} {ind.get('unit')} — 물리적 범위({pol['LEAK_RATE'][0]}~{pol['LEAK_RATE'][1]}) 밖"})
            if name == "RF_REFL_DELTA" and not (pol["RF_REFL_DELTA"][0] <= val <= pol["RF_REFL_DELTA"][1]):
                v.append({"type": "ValueRangeViolation", "field": "RF_REFL_DELTA", "message": f"RF Reflected 변화율 {val}% 범위 밖"})
            if name == "BASE_PRESSURE" and ind.get("unit") == "Torr" and not (1e-9 <= val <= 1e-2):
                v.append({"type": "ValueRangeViolation", "field": "BASE_PRESSURE", "message": f"Base Pressure {val} Torr 범위 밖"})
        if agent_id == "legacy_agent" and action == "history" and out.get("absence") == "data_absent":
            note = out.get("note") or ""
            v.append({"type": "EmptyResult", "field": "QUAL_HIS", "message": f"조회 0건 — 데이터 부재 ({note})",
                      "migrated": ("이관" in note) or ("QL_HIS_NEW" in note)})
        if action == "trend" and out.get("status") == "unavailable" and out.get("error"):
            v.append({"type": "Unsupported", "field": "CYCLE_RF_HOURS", "message": out["error"], "cycle_boundary": True})
        if agent_id == "part_history_agent":
            h = (out.get("signals") or {}).get("fr_hours")
            if h is not None and not (0 <= h <= pol["SEASONING_HOURS"][1]):
                v.append({"type": "ValueRangeViolation", "field": "fr_hours", "message": f"부품 사용시간 {h}h — 범위(0~5000h) 밖"})
        return v

    # ── Shadow ──────────────────────────────────────────────────────
    def _shadow(self, ctx: RunContext, a: dict, ver: str, action: str, inputs: dict, primary: dict):
        sv = a["shadow_version"]
        sctx = ctx.child(run_shadow=False, quiet=True, overlay={**ctx.overlay, a["agent_id"]: sv})
        g_shadow = self.sys.registry.genome(a["agent_id"], sv)
        if g_shadow:
            for sid, sver in (g_shadow.get("deps") or {}).get("skills", {}).items():
                sctx.overlay.setdefault(sid, sver)
        s = self._execute(sctx, a["agent_id"], sv, action, inputs, False)
        mismatch, detail = compare_outputs(a["agent_id"], primary.get("output"), s.get("output"))
        rec = {"agent_id": a["agent_id"], "primary": ver, "shadow": sv, "mode": a.get("shadow_mode"), "mismatch": mismatch,
               "detail": detail, "group": inputs.get("eqp_group"), "chamber_id": inputs.get("chamber_id"),
               "ts": ctx.clock().strftime("%Y-%m-%d %H:%M:%S"), "request_id": ctx.request_id,
               "primary_io": primary.get("io_ms"), "shadow_io": s.get("io_ms")}
        self.shadow_log.append(rec)
        self.sys.bus.emit("shadow", **{k: rec[k] for k in ("agent_id", "primary", "shadow", "mode", "mismatch", "detail", "group", "chamber_id")})
        self.sys.events_hook("shadow_result", rec=rec)


def compare_outputs(agent_id, a: dict | None, b: dict | None) -> tuple[bool, str]:
    """판정 관련 출력 비교 (지표 값 5% 이상 차이 또는 상태 상이 → 불일치)."""
    if not a or not b:
        return (a is None) != (b is None), "출력 없음"
    if a.get("status") != b.get("status"):
        return True, f"status {a.get('status')} vs {b.get('status')}"
    ia = {i["name"]: i for i in a.get("indicators", []) or []}
    ib = {i["name"]: i for i in b.get("indicators", []) or []}
    for k in set(ia) | set(ib):
        if k in ("RF_STABLE_AT", "RF_FWD_CV"):
            continue
        x, y = ia.get(k, {}).get("value"), ib.get(k, {}).get("value")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            unit = ia.get(k, ib.get(k, {})).get("unit")
            if unit == "%":
                if abs(x - y) > 1.0:
                    return True, f"{k}: {x:g} vs {y:g}"
                continue
            base = max(abs(x), abs(y), 1e-12)
            if abs(x - y) / base > 0.05:
                return True, f"{k}: {x:g} vs {y:g}"
        elif (x is None) != (y is None):
            return True, f"{k}: {x} vs {y}"
    for k in ("count", "required_est"):
        if k in a and a.get(k) != b.get(k):
            return True, f"{k}: {a.get(k)} vs {b.get(k)}"
    return False, ""
