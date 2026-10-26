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
                  _redirected: bool = False, version: str | None = None, caller: str | None = None):
        reg = self.sys.registry
        a = reg.agent(agent_id)
        if a is None or a["status"] == "retired":
            out = {"agent_id": agent_id, "version": None, "action": action, "ok": False, "output": None,
                   "error": {"type": "AgentRetired", "message": f"{agent_id}: retired/미등록"}, "violations": [], "elapsed_ms": 0, "io_ms": 0}
            return out["output"] if indirect else out
        if a["status"] == "deprecated" and a.get("replacement") and not _redirected and agent_id not in ctx.overlay and ctx.mode == "ops":
            r = self.run_agent(ctx, a["replacement"], action, inputs, indirect, _redirected=True, caller=caller)
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
        res = self._execute(ctx, agent_id, ver, action, inputs, indirect, caller=caller)
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

    def _execute(self, ctx: RunContext, agent_id: str, ver: str, action: str, inputs: dict, indirect: bool, caller: str | None = None) -> dict:
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
        caller = caller or ("super_agent" if not indirect else (ctx.stack[-2] if len(ctx.stack) > 1 else "super_agent"))
        if not ctx.quiet:
            self.sys.bus.emit("agent_start", agent_id=agent_id, version=ver, action=action, indirect=indirect,
                              caller=caller, request_id=ctx.request_id,
                              inputs=compact_inputs(inputs), tools_allowed=sorted(allowed - {"now", "cache_get", "cache_put"}))
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
            # summary = Agent가 실제로 가져온 값(운영 UI 트레이스·편성 그래프에 "어떤 값을 불러왔는지" 표시), tools = 권한 프록시 도구 원장
            self.sys.bus.emit("agent_end", agent_id=agent_id, version=ver, action=action, ok=out["ok"], indirect=indirect,
                              io_ms=out["io_ms"], tool_calls=out["tool_calls"][:12], audit_id=r.audit_id, request_id=ctx.request_id,
                              error=(r.error or {}).get("message") if r.error else (violations[0]["message"] if violations else None),
                              error_type=(r.error or {}).get("type") if r.error else (violations[0]["type"] if violations else None),
                              status=(r.result or {}).get("status") if r.ok and isinstance(r.result, dict) else None,
                              summary=summarize_output(agent_id, action, r.result if r.ok else None),
                              tools=tool_ledger(rec), inputs=compact_inputs(inputs), elapsed_ms=out["elapsed_ms"],
                              caller=caller, signature=sig,
                              violations=[v.get("message") for v in violations][:3], guard=ctx.guard_blocked, replay=ctx.replay)
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


def compact_inputs(inputs: dict | None, limit: int = 10) -> dict:
    """이벤트용 입력 요약 — 스칼라 값만 (대용량 signals 등은 키 수만)."""
    out = {}
    for k, v in (inputs or {}).items():
        if len(out) >= limit:
            break
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v if not isinstance(v, str) else v[:60]
        elif isinstance(v, dict):
            out[k] = f"{{{len(v)}개 항목}}"
        elif isinstance(v, list):
            out[k] = f"[{len(v)}개]"
    return out


def tool_ledger(rec: list) -> list[dict]:
    """권한 프록시 호출 기록 → 도구별 호출 수·소요(ms)·거부 여부."""
    agg: dict[str, dict] = {}
    for c in rec or []:
        t = c.get("tool")
        a = agg.setdefault(t, {"tool": t, "n": 0, "ms": 0.0, "denied": 0})
        if c.get("denied"):
            a["denied"] += 1
        else:
            a["n"] += 1
            a["ms"] += c.get("ms", 0) or 0
    return [dict(a, ms=round(a["ms"], 1)) for a in agg.values()][:14]


def _fv(v) -> str:
    if isinstance(v, float):
        if v != 0 and abs(v) < 0.001:
            return f"{v:.2e}"
        return f"{v:,.4g}" if abs(v) >= 1000 else f"{v:g}"
    return str(v)


_IND_KO = {"LEAK_RATE": "Leak Rate", "RF_REFL_DELTA": "RF Reflected 변화", "BASE_PRESSURE": "Base Pressure", "RF_STABLE_AT": "RF 안정화 시각",
           "RF_FWD_CV": "RF Forward 변동", "BP_STABLE_MIN": "BP 안정화", "CYCLE_RF_HOURS": "사이클 RF 누적", "CYCLE_DAYS": "사이클 경과",
           "REFL_CYCLE_TREND": "사이클 간 Reflected 추이"}


def _ind_line(ind: dict) -> str:
    name, v, u = ind.get("name"), ind.get("value"), ind.get("unit") or ""
    nm = _IND_KO.get(name, name)
    if name == "RF_REFL_DELTA" and isinstance(v, (int, float)):
        return f"{nm} {v:+.1f}%" + (" (Run Summary 폴백)" if ind.get("source") == "run_summary" else "")
    if name == "BP_STABLE_MIN":
        return f"{nm} {v}분"
    if name == "CYCLE_RF_HOURS" and isinstance(v, (int, float)):
        return f"{nm} {v:,.0f}h" + (f" (시작 {str(ind.get('ref'))[:10]})" if ind.get("ref") else "")
    if u in ("%",):
        return f"{nm} {_fv(v)}%"
    return f"{nm} {_fv(v)} {u}".rstrip()


def summarize_output(agent_id: str, action: str, out) -> list[str]:
    """agent_end 이벤트용 '가져온 값' 요약 — Agent 출력에서 사람이 읽을 핵심 값을 한 줄씩 뽑는다 (최대 8줄)."""
    if out is None:
        return []
    if not isinstance(out, dict):
        return [str(out)[:100]]
    L: list[str] = []
    st = out.get("status")
    if agent_id == "spec_agent" and action == "lookup":
        if st == "ok":
            s = out.get("seasoning") or {}
            L.append(f"절차 {out.get('procedure_id')} · 모델 {out.get('eqp_model')} · Spec {len(out.get('specs') or [])}항목")
            L.append(f"기본 Seasoning {s.get('base_count')}매 (레시피 {s.get('recipe_id')})")
            for x in out.get("specs") or []:
                lo, up, u = x.get("lower"), x.get("upper"), x.get("unit") or ""
                L.append(f"Spec {x.get('item')}: " + (f"{_fv(lo)}~{_fv(up)} {u}" if lo is not None and up is not None else f"≤{_fv(up)} {u}"))
        else:
            L.append(f"기준정보 조회 실패: {out.get('reason') or out.get('error') or st}")
    elif agent_id == "spec_agent" and action == "recommend":
        corr = " ".join(f"{'+' if (c.get('amount') or 0) >= 0 else ''}{c.get('amount')}매[{c.get('lesson_id')}]" for c in out.get("corrections") or [])
        L.append(f"추천 Seasoning {out.get('count')}매 (기본 {out.get('base')}매{(' ' + corr) if corr else ' · 보정 없음'})")
        if out.get("required_est") is not None:
            L.append(f"필요 매수 추정 {out['required_est']}매")
        for x in out.get("extra_steps") or []:
            L.append(f"사전 단계: {x.get('step')} [교훈 {x.get('lesson_id')}]")
        sig = out.get("signals_used") or {}
        if sig:
            L.append("입력 신호: " + ", ".join(f"{k}={_fv(v)}" for k, v in list(sig.items())[:5]))
    else:
        for ind in (out.get("indicators") or [])[:6]:
            if isinstance(ind, dict):
                L.append(_ind_line(ind))
        al = out.get("alarms")
        if isinstance(al, list):
            L.append("PM 후 알람 없음" if not al else f"PM 후 알람 {len(al)}건: " + ", ".join(str(a.get('alarm_code')) for a in al[:3]))
        if out.get("sw_version") or out.get("format"):
            L.append(f"로그 포맷 SW {out.get('sw_version') or out.get('format')}")
        if "n_cases" in out:
            if out.get("n_cases"):
                per = out.get("period") or ["", ""]
                bc = out.get("by_count") or {}
                L.append(f"동일 조건 Qual 이력 {out['n_cases']}회 ({per[0]} ~ {per[1]})")
                try:
                    items = sorted(((int(k), v) for k, v in bc.items()), key=lambda x: x[0])
                except (TypeError, ValueError):
                    items = []
                if items:
                    L.append("매수별 1차 Pass: " + ", ".join(f"{k}매 {v.get('pass')}/{v.get('n')}" for k, v in items[:5]))
                dec = [f"{c}={v.get('meaning')}" for c, v in (out.get("decoded") or {}).items() if isinstance(v, dict) and v.get("source")]
                if dec:
                    L.append("코드값 해석: " + ", ".join(dec[:4]))
            else:
                L.append(f"이력 0건 — {out.get('note') or out.get('absence') or '데이터 부재'}")
        if isinstance(out.get("measurements"), list) and out["measurements"]:
            L.append("측정값 " + ", ".join(f"{m.get('item')} {_fv(m.get('value'))}{m.get('unit') or ''}" for m in out["measurements"][:5]))
        if out.get("part_name") or out.get("installed_at"):
            L.append(f"{out.get('part_name') or out.get('part')} 장착 {str(out.get('installed_at'))[:10]}" + (f" · Lot {out['lot']}" if out.get("lot") else ""))
        if isinstance(out.get("buckets"), list):
            L.append(f"Qual {out.get('n_cases')}건 중 1차 Fail {out.get('n_fail')}건")
            L.append("구간별 Fail율: " + " / ".join(f"{b.get('bucket')} {round((b.get('rate') or 0) * 100)}% ({b.get('fail')}/{b.get('n')})"
                                                  for b in out["buckets"] if b.get("n")))
        if isinstance(out.get("chambers"), list) and "lot" in out:
            L.append(f"Lot {out['lot']}: 장착 챔버 {out.get('n', len(out['chambers']))}개 — " +
                     ", ".join(str(c.get("chamber_id")) for c in out["chambers"][:4]))
        sig = out.get("signals")
        if isinstance(sig, dict) and sig:
            L.append("신호: " + ", ".join(f"{k}={_fv(v)}" for k, v in list(sig.items())[:5]))
        if out.get("unavailable"):
            L.append("확인 불가: " + ", ".join(str(x) for x in out["unavailable"][:4]))
        if out.get("note") and "n_cases" not in out:
            L.append(str(out["note"])[:90])
        if out.get("error"):
            L.append(f"오류: {str(out['error'])[:90]}")
    if not L and st:
        L.append(f"status={st}")
    return L[:8]


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
