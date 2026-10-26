"""Super Agent — 요청 해석·Jev 편성·CodeAct 실행 계획 작성·결과 종합.

- 엔티티 추출(summary 역할 모델 / 오프라인: 규칙 기반 추출기), 모호하면 추측하지 않고 확인 질문
- Jev 편성: p ≥ route_auto 자율, route_escalate~route_auto 는 LLM 재검토, 미만 제외
- 실행 계획: Python 코드(CodeAct)로 하위 Agent 병렬 호출·결과 결합 순서를 작성 → 샌드박스 실행
- 편성 템플릿이 적용 조건과 일치하면 LLM 계획 생략
- 결과 종합: 결론 먼저, 근거(지표·이력·교훈 ID)와 확인 불가 항목을 숨기지 않음
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from mock_env import config as C

PM_KEYWORDS = [
    (r"wet\s*clean|웻\s*클린|습식\s*세정|\bWC\b", "WET_CLEAN"),
    (r"rf\s*gen(erator)?|rf\s*제너레이터|rf\s*발생기|\bRFG\b", "RF_GEN_REPLACE"),
    (r"showerhead|샤워\s*헤드", "SHOWERHEAD_REPLACE"),
    (r"\besc\b", "ESC_REPLACE"),
    (r"target|타겟", "TARGET_REPLACE"),
    (r"pump|펌프", "PUMP_PM"),
    (r"정기\s*pm|분기\s*pm|\bqpm\b|quarterly", "QUARTERLY_PM"),
    (r"알람", "ALARM_RECOVERY"),
]
ITEM_PATTERNS = [
    ("PARTICLE", r"particle\s*[:=]?\s*([\d.]+)\s*(ea|개)?"),
    ("ER_UNIF", r"(?:er\s*)?unif(?:ormity)?\s*[:=]?\s*([\d.]+)\s*(%)?"),
    ("ER", r"\ber\b(?!\s*unif)\s*[:=]?\s*([\d,.]+)\s*(å/min|a/min|nm/min|angstrom/min)?"),
    ("DR", r"\bdr\b\s*[:=]?\s*([\d,.]+)\s*(å/min|a/min|nm/min)?"),
    ("THK_UNIF", r"thk\s*unif\s*[:=]?\s*([\d.]+)\s*(%)?"),
    ("RS_UNIF", r"rs\s*unif\s*[:=]?\s*([\d.]+)\s*(%)?"),
    ("LEAK_RATE", r"leak\s*(?:rate)?\s*[:=]?\s*([\d.]+)\s*(mtorr/min)?"),
    ("BASE_PRESSURE", r"(?:base\s*pressure|\bbp\b)\s*[:=]?\s*([\d.eE+-]+)\s*(torr)?"),
]
UNIT_NORM = {"ea": "ea", "개": "ea", "%": "%", "å/min": "A/min", "a/min": "A/min", "angstrom/min": "A/min", "nm/min": "nm/min",
             "mtorr/min": "mTorr/min", "torr": "Torr"}

CAP_RULES = [  # (패턴, 필요 능력)
    (r"부품.*(사용\s*시간|수명|교체)|사용\s*시간.*부품|focus\s*ring.*시간", {"qual_history", "part_usage"}),
    (r"\blot\b|로트", {"part_lot_trace"}),
    (r"사이클|추이|drift|드리프트", {"cycle_trend"}),
]


class SuperAgent:
    def __init__(self, sysm):
        self.sys = sysm

    @property
    def genome(self):
        return self.sys.registry.genome("super_agent")

    @property
    def params(self) -> dict:
        g = self.genome
        return (g or {}).get("params") or {}

    # ── 1. 요청 해석 ───────────────────────────────────────────────
    def parse(self, text: str, now: datetime, hint: dict | None = None) -> dict:
        t = text.strip()
        low = t.lower()
        ent: dict = {}
        ambiguous = []
        m = re.search(r"\b(ETCH|CVD|PVD)[-\s]?(\d{1,2})\b", t, re.I)
        if m:
            ent["eqp_id"] = f"{m.group(1).upper()}-{int(m.group(2)):02d}"
        else:
            m2 = re.search(r"(\d{1,2})\s*호기", t)
            if m2:
                n = int(m2.group(1))
                cands = [f"{g}-{n:02d}" for g in ("ETCH", "CVD", "PVD") if f"{g}-{n:02d}" in C.EQP_MODEL]
                if len(cands) == 1:
                    ent["eqp_id"] = cands[0]
                else:
                    ambiguous = cands
        mc = re.search(r"\b([ABC])\s*챔버|챔버\s*([ABC])\b|\b(?:ETCH|CVD|PVD)-\d{2}-([ABC])\b|\b([ABC])\s*(?:ch|chamber)\b", t, re.I)
        if mc:
            ent["chamber"] = next(g for g in mc.groups() if g).upper()
        for pat, pm in PM_KEYWORDS:
            if re.search(pat, t, re.I):
                ent["pm_type"] = pm
                break
        meas = []
        for item, pat in ITEM_PATTERNS:
            mm = re.search(pat, low, re.I)
            if mm:
                raw = mm.group(1).replace(",", "")
                try:
                    v = float(raw)
                except ValueError:
                    continue
                unit = UNIT_NORM.get((mm.group(2) or "").lower())
                meas.append({"item": item, "value": v, "unit": unit})
        caps = set()
        for pat, need in CAP_RULES:
            if re.search(pat, t, re.I):
                caps |= need
        rtype = "autoqual"
        if meas and not re.search(r"autoqual|오토\s*퀄|진행해", low):
            rtype = "remeasure" if (re.search(r"재측정", t) and len(meas) == 1) else "judge"
        elif "part_lot_trace" in caps:
            rtype = "lot_trace"
        elif "cycle_trend" in caps and not re.search(r"autoqual|진행", low):
            rtype = "trend"
        elif re.search(r"분석|관계|상관|영향", t):
            rtype = "analysis"
        elif re.search(r"이력|지난|최근.*건", t) and not re.search(r"autoqual|오토\s*퀄", low):
            rtype = "history"
        period = None
        if re.search(r"지난\s*분기", t):
            q = (now.month - 1) // 3
            y = now.year if q > 0 else now.year - 1
            q = q if q > 0 else 4
            start = datetime(y, 3 * (q - 1) + 1, 1)
            end = (datetime(y + (1 if q == 4 else 0), (3 * q) % 12 + 1, 1) - timedelta(seconds=1))
            period = {"label": f"{y} Q{q}", "start": start.strftime("%Y-%m-%d"), "end": end.strftime("%Y-%m-%d")}
        lot = re.search(r"\b([A-Z]{2,4}L-\d{4}-\d{3})\b", t)
        if lot:
            ent["lot"] = lot.group(1)
        grp = re.search(r"\b(ETCH|CVD|PVD)\s*장비", t)
        if grp:
            ent["eqp_prefix"] = grp.group(1)
        if hint:
            ent.update({k: v for k, v in hint.items() if v})
        if ent.get("eqp_id"):
            ent["eqp_model"] = C.EQP_MODEL.get(ent["eqp_id"])
            ent["eqp_group"] = C.EQP_GROUP.get(ent["eqp_id"])
            if ent.get("chamber"):
                ent["chamber_id"] = f"{ent['eqp_id']}-{ent['chamber']}"
        return {"text": t, "rtype": rtype, "entities": ent, "measurements": meas, "required_caps": sorted(caps),
                "period": period, "ambiguous": ambiguous}

    # ── 2. 편성 ─────────────────────────────────────────────────────
    def agent_cards(self, include_probation=True) -> list[dict]:
        cards = []
        for a in self.sys.registry.agents("agent"):
            if a["status"] in ("retired", "deprecated", "candidate") or not a["active_version"]:
                continue
            if a["status"] == "probation" and not include_probation:
                continue
            if (a.get("card") or {}).get("route_excluded"):
                continue
            c = dict(a.get("card") or {})
            c.update({"agent_id": a["agent_id"], "status": a["status"], "version": a["active_version"]})
            cards.append(c)
        return cards

    def capabilities(self) -> set:
        caps = set()
        for c in self.agent_cards():
            caps |= set(c.get("caps", []))
        return caps

    def required_caps(self, req: dict) -> list[str]:
        caps = set(req.get("required_caps") or [])
        base = {"autoqual": {"procedure", "seasoning_reco", "fdc_trace", "qual_history"}, "judge": {"procedure"},
                "remeasure": {"procedure"}, "history": {"qual_history"}, "trend": {"cycle_trend"}, "analysis": {"qual_history"},
                "lot_trace": {"part_lot_trace"}}.get(req["rtype"], set())
        return sorted(caps | base)

    def route(self, req: dict, clock=None) -> dict:
        pol = self.sys.policy["jev"]
        p = self.params
        thr_auto = p.get("route_auto", pol["route_auto"])
        cards = self.agent_cards()
        ents = req["entities"]
        rq = {"rtype": req["rtype"], "eqp_group": ents.get("eqp_group"), "pm_type": ents.get("pm_type"), "text": req["text"]}
        can = self.sys.jev.decide("기존 Agent 조합으로 이 요청을 처리할 수 있는가?", "yes_no", ["yes", "no"],
                                  {"head": "can_handle", "required_caps": self.required_caps(req), "available_caps": sorted(self.capabilities())})
        routing = self.sys.jev.decide("이 요청에 필요한 Agent는?", "multi_choice", [c["agent_id"] for c in cards],
                                      {"head": "route", "request": rq, "cards": cards, "threshold": pol["route_escalate"]})
        selected, escalated, excluded = [], [], []
        for c in cards:
            pa = routing["probs"].get(c["agent_id"], 0)
            if pa >= thr_auto:
                selected.append(c["agent_id"])
            elif pa >= pol["route_escalate"]:
                escalated.append(c["agent_id"])
            else:
                excluded.append(c["agent_id"])
        # LLM 에스컬레이션(재검토): 요청에 필요한 능력을 실제로 제공하는 Agent만 편입
        need = set(self.required_caps(req))
        lesson_sig = set()
        if ents.get("eqp_model") and ents.get("pm_type"):
            for L in self.sys.memory.search({"kind": "lesson", "eqp_model": ents["eqp_model"], "pm_type": ents["pm_type"], "status": "active"},
                                            100, before_ts=clock):
                cond = (L["content"] or {}).get("condition") or {}
                for cc in cond.get("all", [cond]):
                    if cc.get("signal"):
                        lesson_sig.add(cc["signal"])
        review = []
        for a in escalated:
            card = next(c for c in cards if c["agent_id"] == a)
            fits = (not card.get("groups") or rq["eqp_group"] in card["groups"]) and (not card.get("pm_types") or rq["pm_type"] in card["pm_types"])
            by_cap = bool(set(card.get("caps", [])) & need)
            by_sig = bool(set(card.get("signals", [])) & lesson_sig) and a in self.params.get("merge_signals", ["log_agent"])
            keep = fits and (by_cap or by_sig)
            review.append({"agent_id": a, "keep": keep, "p": routing["probs"][a],
                           "why": "필요 능력 제공" if by_cap else ("적용 교훈 입력 신호 제공" if by_sig else "요청과 무관")})
            (selected if keep else excluded).append(a)
        # 편성 전략(진화 대상): 기여도 낮은 호출 생략 규칙
        skipped = []
        for rule in p.get("skip_rules", []):
            if req["rtype"] in rule.get("rtypes", []) and rule["agent_id"] in selected:
                if rule.get("unless") == "recent_fail" and req.get("_recent_fail"):
                    continue
                selected.remove(rule["agent_id"])
                skipped.append({"agent_id": rule["agent_id"], "rule": rule["id"], "reason": rule["reason"]})
        order = ["spec_agent", "log_agent", "legacy_agent"]
        selected.sort(key=lambda a: (order.index(a) if a in order else 9, a))
        return {"can_handle": can, "routing": routing, "selected": selected, "escalated": review, "excluded": excluded,
                "skipped": skipped, "threshold": thr_auto}

    # ── 3. 실행 계획 (CodeAct) ──────────────────────────────────────
    def match_template(self, req: dict, route: dict):
        for t in self.sys.store.all("SELECT * FROM templates WHERE status='active'"):
            cond = t["conditions"] or {}
            type_match = 1.0 if req["rtype"] == t["request_type"] else 0.0
            cm = 1.0
            if cond.get("pm_types") and req["entities"].get("pm_type") not in cond["pm_types"]:
                cm = 0.0
            extra = 1.0 if re.search(r"교체.*(동시|함께)|동시.*교체|\+", req["text"]) and req["entities"].get("pm_type") == "WET_CLEAN" else 0.0
            j = self.sys.jev.decide("편성 템플릿 적용 조건과 일치하는가?", "yes_no", ["yes", "no"],
                                    {"head": "template_match", "type_match": type_match, "cond_match": cm, "extra_parts": extra})
            if j["answer"] == "yes" and set(t["agents"]) <= set(route["selected"]) | {"spec_agent"}:
                return t, j
            if type_match:
                return None, j
        return None, None

    def write_plan(self, req: dict, route: dict) -> dict:
        ents = req["entities"]
        sel = route["selected"]
        rt = req["rtype"]
        merge = self.params.get("merge_signals", ["log_agent"])
        lines = [f"# [CodeAct 실행 계획] {RTYPE_KO.get(rt, rt)} — {ents.get('chamber_id') or ents.get('eqp_prefix') or ''} / {ents.get('pm_type') or ''}".rstrip(" /"),
                 "req = REQ"]
        if rt in ("autoqual",):
            par = [a for a in sel if a in ("spec_agent", "log_agent", "legacy_agent", "chamber_trend_agent", "part_history_agent")]
            actions = {"spec_agent": "lookup", "log_agent": "analyze", "legacy_agent": "history", "chamber_trend_agent": "trend",
                       "part_history_agent": "usage"}
            names = {"spec_agent": "spec", "log_agent": "log", "legacy_agent": "hist", "chamber_trend_agent": "trend", "part_history_agent": "part"}
            lines.append(", ".join(names[a] for a in par) + (", " if len(par) == 1 else "") + " = parallel(")
            for a in par:
                inp = "dict(req, at=req['pm_end'], part='FOCUS_RING')" if a == "part_history_agent" else "req"
                lines.append(f'    ("{a}", "{actions[a]}", {inp}),')
            lines.append(")")
            lines.append('signals = dict(log.get("signals", {}))' if "log_agent" in par else "signals = {}")
            if "chamber_trend_agent" in par and "chamber_trend_agent" in merge:
                lines.append('signals.update(trend.get("signals", {}))')
            if "part_history_agent" in par:
                lines.append('signals.update(part.get("signals", {}))')
            lines.append('signals["month"] = int(req["pm_end"][5:7])')
            lines.append('if spec.get("status") == "ok":')
            lines.append('    rec = call("spec_agent", "recommend", dict(req, eqp_model=spec["eqp_model"], seasoning=spec["seasoning"], signals=signals))')
            lines.append("else:")
            lines.append('    rec = {"status": "unavailable", "unavailable": ["RECOMMENDATION"]}')
            out = ", ".join(f'"{names[a]}": {names[a]}' for a in par)
            lines.append(f'result = {{{out}, "recommendation": rec, "signals": signals}}')
        elif rt in ("judge", "remeasure"):
            with_hist = "legacy_agent" in sel
            lines.append("spec, hist = parallel(" if with_hist else "spec, = parallel(")
            lines.append('    ("spec_agent", "lookup", req),')
            if with_hist:
                lines.append('    ("legacy_agent", "history", req),')
            lines.append(")")
            lines.append('result = {"spec": spec' + (', "hist": hist' if with_hist else "") + "}")
        elif rt == "history":
            lines.append('hist, = parallel(("legacy_agent", "history", dict(req, limit=12)),)')
            lines.append('result = {"hist": hist}')
        elif rt == "trend":
            agent = "chamber_trend_agent" if "chamber_trend_agent" in sel else ("log_agent" if "log_agent" in sel else sel[0] if sel else "log_agent")
            lines.append(f'trend, = parallel(("{agent}", "trend", req),)')
            lines.append('result = {"trend": trend}')
        elif rt in ("analysis",):
            if "part_history_agent" in sel:
                lines.append('ana = call("part_history_agent", "analyze", dict(req, start=PERIOD["start"], end=PERIOD["end"]))')
                lines.append('result = {"analysis": ana}')
            else:
                lines.append('hist, = parallel(("legacy_agent", "history", req),)')
                lines.append('result = {"hist": hist}')
        elif rt == "lot_trace":
            lines.append('lot = call("lot_trace_agent", "trace", req)')
            lines.append('result = {"lot": lot}')
        code = "\n".join(lines) + "\n"
        return {"code": code, "agents": sel}


RTYPE_KO = {"autoqual": "PM 후 AutoQual", "judge": "Qual 판정", "remeasure": "재측정 판정", "history": "이력 분석",
            "analysis": "신규 분석", "trend": "PM 사이클 추이", "lot_trace": "부품 Lot 추적"}


def history_suggestion(hist: dict, count: int) -> dict | None:
    """레거시 이력과 추천이 상충하면 보수적(더 많은) 매수와 근거를 제시."""
    if not hist or hist.get("status") not in ("ok",) or not hist.get("by_count"):
        return None
    bc = {int(k): v for k, v in hist["by_count"].items()}
    lower = {k: v for k, v in bc.items() if k <= count}
    lo_n = sum(v["n"] for v in lower.values())
    lo_p = sum(v["pass"] for v in lower.values())
    if lo_n >= 3 and lo_p / lo_n <= 0.5:
        higher = sorted(k for k, v in bc.items() if k > count and v["n"] >= 2 and v["pass"] / v["n"] >= 0.8)
        if higher:
            return {"count": higher[0], "reason": f"동일 챔버·PM 이력: {count}매 이하 1차 Pass {lo_p}/{lo_n}, {higher[0]}매 "
                                                   f"{bc[higher[0]]['pass']}/{bc[higher[0]]['n']}"}
    return None
