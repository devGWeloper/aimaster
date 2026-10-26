"""L3 Evolve Loop — 변이 → 평가 → 선택 → 보관.

collect_metrics → jev_need_evolve → mutate(최대 3후보, 아카이브 출발점) → evaluate_harness(루프 밖 고정 하네스)
→ select(Evolve셋 개선 & 검증셋 비하락) → archive(채택·기각 모두) → (운영) shadow_run → promote / auto_rollback

진화 대상 5계층: ① 파라미터·교훈 ② 스킬 ③ Agent 코드 ④ Agent 구성(생성·병합·폐기) ⑤ Super Agent 편성 전략
"""
from __future__ import annotations

import json
import statistics
from collections import defaultdict
from datetime import datetime, timedelta

from mock_env import config as C

from ..genomes.build import make_genome
from ..genomes.skills import skill_sources
from ..registry import diff_stats
from ..tools import P, RunContext, S

SEASON_FAIL = {"ER", "ERU", "DR", "THU", "RSU"}
GRID = {"rf_refl_delta_pct": [6, 8, 10, 12, 14], "bp_stable_min": [20, 25, 30], "cycle_rf_hours": [300, 400, 450, 500, 600],
        "fr_hours": [300, 400, 500, 600, 700]}
# 신호 역할 카탈로그: Seasoning 매수 보정에 쓰는 신호 / 절차(대기 단계) 교훈에만 쓰는 신호
SEASON_SIGNALS = {"rf_refl_delta_pct", "cycle_rf_hours", "fr_hours"}
PROCEDURE_SIGNALS = {"bp_stable_min", "month"}
SIG_KO = {"rf_refl_delta_pct": "RF Reflected 증가율", "bp_stable_min": "BP 안정화 시간", "cycle_rf_hours": "직전 Wet Clean 이후 RF 누적",
          "fr_hours": "Focus Ring 사용시간"}
SIG_UNIT = {"rf_refl_delta_pct": "%", "bp_stable_min": "분", "cycle_rf_hours": "h", "fr_hours": "h"}
PM_KO = {k: v["name"] for k, v in C.PM_TYPES.items()}
LAYER_KO = {1: "① 파라미터·교훈", 2: "② 스킬", 3: "③ Agent 코드", 4: "④ Agent 구성", 5: "⑤ 편성 전략"}


class Row:
    __slots__ = ("id", "model", "pm", "recipe", "base", "n1", "pass1", "fails", "sig", "eng", "wait", "month", "qh", "rel", "group",
                 "chamber", "pm_end", "quarter", "leakfail")

    def __init__(self, cid, c):
        self.id = cid
        self.model, self.pm = c["eqp_model"], c["pm_type"]
        rec = c.get("recommendation") or {}
        self.recipe = rec.get("recipe_rev") or c.get("recipe_rev") or "R1"
        self.base = rec.get("base") or C.base_count(self.model, self.pm, P(c["pm_end"]).date())
        a = c["actual"]
        self.n1, self.pass1 = a["n1"], bool(a["pass1"])
        self.fails = set(x for x in (a.get("fail_items") or "").split(",") if x)
        self.sig = dict(c.get("signals") or {})
        self.eng, self.wait = a.get("eng"), bool(a.get("wait"))
        self.month = int(c["pm_end"][5:7])
        self.qh = c.get("qh_seq")
        self.chamber, self.pm_end, self.quarter = c["chamber_id"], c["pm_end"], c.get("quarter")
        self.group = c["eqp_group"]
        ok_n = self.n1 is not None and 3 <= self.n1 <= 120
        self.rel = ok_n and (self.pass1 or bool(self.fails & SEASON_FAIL))
        self.leakfail = bool(self.fails & {"LKR", "BP"})


def cond_match(cond, sig) -> bool:
    if not cond:
        return True
    if "all" in cond:
        return all(cond_match(c, sig) for c in cond["all"])
    v = sig.get(cond["signal"])
    if v is None:
        return False
    if "between" in cond:
        return cond["between"][0] <= v < cond["between"][1]
    op = cond.get("op", ">=")
    t = cond["value"]
    return {">=": v >= t, ">": v > t, "<": v < t, "<=": v <= t, "in": v in t if isinstance(t, list) else False}.get(op, v == t)


class Evolver:
    def __init__(self, sysm):
        self.sys = sysm
        self.cooldown: dict = {}

    # ── 공통 ───────────────────────────────────────────────────────
    def _node(self, node, detail, run_id, pace=0.4, **kw):
        self.sys.bus.emit("node", loop="L3", node=node, run_id=run_id, detail=detail, **kw)
        self.sys.bus.pace(pace)

    def active_config(self) -> dict:
        reg = self.sys.registry
        sup = reg.genome("super_agent")
        lessons = [x for x in self.sys.memory.lessons(("active",))]
        return {"versions": {a["agent_id"]: a["active_version"] for a in reg.agents(None) if a["active_version"]},
                "lessons": lessons, "merge": (sup["params"] or {}).get("merge_signals", ["log_agent"])}

    def features(self, agent_id) -> set:
        g = self.sys.registry.genome(agent_id)
        return set(((g or {}).get("params") or {}).get("features", []))

    def candidate_genome(self, agent_id: str, add: set, remove: set, summary: str, cid: str, kind="minor", skill_override=None):
        reg = self.sys.registry
        g = reg.genome(agent_id)
        feats = (set(g["params"].get("features", [])) | add) - remove
        cand_v = f"{g['version']}+{cid}"
        log = list(g["params"].get("changelog", [])) + [f"{{v}}: {summary}"]
        gen = make_genome(self.sys, agent_id, cand_v, feats, [x.replace("{v}", cand_v) for x in log], skill_override)
        reg.add_genome(agent_id, cand_v, gen["code"], params=dict(gen["params"], changelog=log, summary=summary, kind=kind),
                       deps=gen["deps"], tools=gen["tools"], parent=g["version"], reason="evolve-candidate", ref=cid,
                       status="candidate", prompt=g.get("prompt", ""))
        add_n, rem_n, diff = diff_stats(g["code"], gen["code"])
        return {"agent_id": agent_id, "version": cand_v, "features": sorted(feats), "summary": summary, "kind": kind,
                "diff_add": add_n, "diff_del": rem_n, "diff": diff, "lines": len(gen["code"].splitlines())}

    def promote_candidate(self, cand: dict, ref: str, note: str):
        """후보 Genome을 정식 버전 번호로 재등록하고 활성화 (MINOR/MAJOR)."""
        reg = self.sys.registry
        out = []
        for gd in cand.get("genomes", []):
            aid = gd["agent_id"]
            cur = reg.agent(aid)["active_version"]
            kind = gd.get("kind", "minor")
            if reg.agent(aid)["status"] == "probation" and kind == "minor":
                new_v = reg.next_version(aid, cur, "minor")
            else:
                new_v = reg.next_version(aid, cur, kind)
            cg = reg.genome(aid, gd["version"])
            log = [x.replace("{v}", new_v) for x in cg["params"].get("changelog", [])]
            gen = make_genome(self.sys, aid, new_v, set(cg["params"]["features"]), log, cand.get("skill_override"))
            reg.add_genome(aid, new_v, gen["code"], params=dict(gen["params"], changelog=log), deps=gen["deps"], tools=gen["tools"],
                           parent=cur, reason="evolve", ref=ref, status="candidate", prompt=cg.get("prompt", ""))
            reg.set_genome_status(aid, gd["version"], "adopted")
            reg.activate(aid, new_v, "evolve" if kind == "minor" else "compose", ref=ref, note=note)
            out.append({"agent_id": aid, "from": cur, "to": new_v})
            if aid == "chamber_trend_agent":
                self.sys.harness.capture_trend_golden(aid, new_v)
        for sk in cand.get("skills", []):
            sid, ver = sk["skill_id"], sk["version"]
            if not reg.agent(sid):
                reg.register_agent(sid, "skill", sk.get("name_ko", sid), origin=f"Evolve {ref}")
            prev = (reg.agent(sid) or {}).get("active_version")
            if not reg.genome(sid, ver):
                reg.add_genome(sid, ver, skill_sources()[sid][ver], reason="evolve", ref=ref, status="candidate", parent=prev)
            reg.activate(sid, ver, "evolve", ref=ref, note=sk.get("summary", ""))
            reg.update_agent(sid, status="active")
            out.append({"agent_id": sid, "from": prev, "to": ver})
        if cand.get("super_params"):
            out.append(self.bump_super(cand["super_params"], ref, note))
        return out

    def bump_super(self, params: dict, ref: str, note: str):
        from ..bootstrap import super_code
        reg = self.sys.registry
        g = reg.genome("super_agent")
        new_v = reg.next_version("super_agent", g["version"], "minor")
        p = dict(g["params"] or {})
        p.update(params)
        reg.add_genome("super_agent", new_v, super_code(new_v, p), params=p, prompt=g.get("prompt", ""), parent=g["version"],
                       reason="evolve", ref=ref, status="candidate")
        reg.activate("super_agent", new_v, "evolve", ref=ref, note=note)
        return {"agent_id": "super_agent", "from": g["version"], "to": new_v}

    def archive(self, cand: dict, decision: str, reason: str, scores: dict, ref: str, layer: int):
        aid = self.sys.store.next_id("ARC-", 4)
        code = "\n\n".join(g.get("diff", "") for g in cand.get("genomes", []))
        self.sys.store.insert("archive", {"archive_id": aid, "candidate_id": cand["cid"], "target": cand.get("target"), "layer": LAYER_KO.get(layer, str(layer)),
                                          "decision": decision, "reason": reason, "scores": scores, "code": code[:20000],
                                          "ts": S(self.sys.clock.now()), "report_id": ref,
                                          "meta": {"title": cand["title"], "lessons": [L.get("text") for L in cand.get("new_lessons", [])][:12],
                                                   "genomes": [{k: g[k] for k in ("agent_id", "version", "summary", "diff_add", "diff_del")} for g in cand.get("genomes", [])]}})
        return aid

    # ── 교훈 마이닝 (① 파라미터 계층) ─────────────────────────────────
    def mine_lessons(self, rows: list[Row], feats: set, signals: set, exclude_groups=()) -> list[dict]:
        use_recipe = "recipe_cond" in feats
        allow_neg = "negative" in feats
        groups = defaultdict(list)
        for r in rows:
            groups[(r.model, r.pm, r.recipe if use_recipe else "*")].append(r)
        out = []
        for key, rs in sorted(groups.items(), key=lambda kv: str(kv[0])):
            if (key[0], key[1]) in exclude_groups:
                continue
            rel = [r for r in rs if r.rel]
            if len(rel) < 8:
                continue

            def acc(fn):
                return sum((r.n1 >= r.base + fn(r)) == r.pass1 for r in rel)
            a_base = acc(lambda r: 0)
            fns = []
            conds = []
            for _ in range(2):
                cur = lambda r, fs=tuple(fns): sum(f(r) for f in fs)
                a_cur = acc(cur)
                best = None
                for s in sorted(signals & SEASON_SIGNALS):
                    for t in GRID.get(s, []):
                        S_ = [r for r in rel if r.sig.get(s) is not None and r.sig[s] >= t]
                        if len(S_) < 6 or len({r.eng for r in S_}) < 2:
                            continue
                        for d in (5, 10, 15):
                            fn = lambda r, s=s, t=t, d=d: d if (r.sig.get(s) is not None and r.sig[s] >= t) else 0
                            a = acc(lambda r, fn=fn: cur(r) + fn(r))
                            gain = a - a_cur
                            if gain >= 3 and gain >= 0.2 * len(S_) and (best is None or gain > best[0]):
                                best = (gain, s, t, d, S_, fn)
                if not best:
                    break
                gain, s, t, d, S_, fn = best
                fns.append(fn)
                conds.append({"signal": s, "t": t, "d": d, "rows": S_, "gain": gain})
            cur = lambda r, fs=tuple(fns): sum(f(r) for f in fs)
            a_c = acc(cur)
            d0, a0 = 0, a_c
            for d in [5, 10] + ([-5, -10] if allow_neg else []):
                a = acc(lambda r, d=d: cur(r) + d)
                if a > a0 and a - a_c >= max(2, 0.04 * len(rel)):
                    d0, a0 = d, a
            a0 = a0 - a_c + a_base
            model, pm, rec = key
            if d0:
                src = [r for r in rel]
                txt = (f"{model} {PM_KO[pm]} 기본 {rs[0].base}매 → {rs[0].base + d0}매 " +
                       ("(1차 Pass 포화, 과잉 Seasoning 감축)" if d0 < 0 else "(기본 매수 부족)") + (f" [SSN-{rec}]" if rec != "*" else ""))
                out.append(self._lesson(model, pm, rec, None, d0, txt, src, a0 - a_base))
            for c in conds:
                txt = f"{model} {PM_KO[pm]} 후 {SIG_KO[c['signal']]} {c['t']}{SIG_UNIT[c['signal']]} 이상 → +{c['d']}매" + (f" [SSN-{rec}]" if rec != "*" else "")
                out.append(self._lesson(model, pm, rec, {"signal": c["signal"], "op": ">=", "value": c["t"]}, c["d"], txt, c["rows"], c["gain"]))
        return out

    def mine_procedure(self, rows: list[Row], signals: set) -> list[dict]:
        if "bp_stable_min" in signals:
            S_ = [r for r in rows if (r.sig.get("bp_stable_min") or 0) >= 25]
            cond = {"signal": "bp_stable_min", "op": ">=", "value": 25}
            label = "Leak Check 후 BP 안정화 25분 이상 지연"
        else:
            S_ = [r for r in rows if r.month in (7, 8)]
            cond = {"signal": "month", "op": "in", "value": [7, 8]}
            label = "장마철(7~8월) Leak Check"
        nw = [r for r in S_ if not r.wait]
        w = [r for r in S_ if r.wait]
        if len(nw) < 10 or len(w) < 3:
            return []
        rnw = sum(r.leakfail for r in nw) / len(nw)
        rw = sum(r.leakfail for r in w) / len(w)
        if rnw >= 0.2 and rw <= 0.1:
            txt = f"{label} → Base Pressure 안정화 30분 대기 후 진행 (대기 없음 Leak Fail {rnw * 100:.0f}% vs 대기 {rw * 100:.0f}%)"
            L = self._lesson("*", "*", "*", cond, 0, txt, nw + w, round((rnw - rw) * len(nw)))
            L["kind"] = "procedure"
            L["step"] = "Base Pressure 안정화 30분 대기"
            return [L]
        return []

    @staticmethod
    def _lesson(model, pm, rec, cond, corr, text, rows, gain):
        engs = {r.eng for r in rows}
        return {"eqp_model": model, "pm_type": pm, "recipe_rev": None if rec == "*" else rec, "kind": "seasoning", "condition": cond,
                "correction": corr, "text": text, "support": len(rows), "engineers": len(engs), "gain": gain,
                "source_case_ids": [r.id for r in rows][:200]}

    def lesson_key(self, L) -> str:
        return json.dumps([L["eqp_model"], L["pm_type"], L.get("recipe_rev"), L.get("kind"), L.get("condition"), L.get("correction")], sort_keys=True)

    def as_overlay(self, lessons: list[dict]) -> list[dict]:
        """후보 교훈 → search_experience 결과 형식 (하네스 평가용)."""
        return [{"id": L.get("id", f"L-c{i}"), "kind": "lesson", "status": "active", "eqp_model": L["eqp_model"], "pm_type": L["pm_type"],
                 "content": L, "source_case_ids": L["source_case_ids"]} for i, L in enumerate(lessons)]

    def register_lessons(self, lessons: list[dict], clock: datetime, ref: str, quarter: str) -> dict:
        """채택된 교훈 세트 반영: 동일 교훈은 ID 유지(재검증), 신규 등록, 빠진 교훈은 만료."""
        cur = {self.lesson_key(x["content"]): x for x in self.sys.memory.lessons(("active",))}
        keep, new, expired = [], [], []
        new_keys = set()
        for L in lessons:
            k = self.lesson_key(L)
            new_keys.add(k)
            if k in cur:
                keep.append(cur[k]["id"])
                continue
            content = dict(L, learned_q=quarter, evolve_ref=ref, status="active")
            mid = self.sys.memory.record("lesson", content, clock, eqp_model=L["eqp_model"], pm_type=L["pm_type"],
                                         source_case_ids=L["source_case_ids"])
            L["id"] = mid
            new.append({"id": mid, "text": L["text"], "support": L["support"]})
        for k, x in cur.items():
            if k not in new_keys and not (x["content"].get("pinned")):
                self.sys.memory.update(x["id"], status="expired")
                expired.append({"id": x["id"], "text": x["content"]["text"]})
        return {"kept": keep, "new": new, "expired": expired}

    # ════════════════════════════════════════════════════════════════
    # 리플레이: 분기 종료 L3 Evolve (Walk-forward)
    # ════════════════════════════════════════════════════════════════
    def replay_quarter(self, quarter: str, clock: datetime, run_id: str) -> dict:
        mem = self.sys.memory
        allrows = mem.cases(end=clock, mode="replay")
        rows_c = [x for x in allrows if x["content"].get("split") == "evolve"]
        qs = sorted({x["content"]["quarter"] for x in rows_c})
        window = qs[-4:]
        recent = [x for x in rows_c if x["content"]["quarter"] in window][-1000:]
        val_cut = S(clock - timedelta(days=30))
        mining = [x for x in recent if x["event_ts"] < val_cut]
        val = [x for x in recent if x["event_ts"] >= val_cut]
        M = [Row(x["id"], x["content"]) for x in mining]
        Mc, Vc = [x["content"] for x in mining], [x["content"] for x in val]
        H = self.sys.harness
        base_cfg = self.active_config()
        base_cfg["lessons"] = self.as_overlay([x["content"] for x in base_cfg["lessons"]])
        self._node("collect_metrics", f"{quarter} 종료 — 경험 메모리 {len(recent)}건 (마이닝 {len(mining)} / 검증 {len(val)})", run_id, pace=0.3)
        bE, bV = H.evaluate(base_cfg, Mc, "base"), H.evaluate(base_cfg, Vc, "base")
        qrows = [x["content"] for x in rows_c if x["content"]["quarter"] == quarter]
        mism = [c for c in qrows if not c["match"]["overall"]]
        judge_bad = [c for c in qrows if not c["match"]["judge"]]
        unav_rf = sum(1 for c in qrows if any("log_agent" in u for u in c.get("unavailable", [])) or "rf_refl_delta_pct" not in (c.get("signals") or {}))
        jn = self.sys.jev.decide("이번 분기 진화가 필요한가?", "yes_no", ["yes", "no"],
                                 {"head": "need_evolve", "mismatch_pp": len(mism) / max(1, len(qrows)) * 100, "clusters": 1,
                                  "signal_issues": int(unav_rf > 0), "gap": 0})
        self._node("jev_need_evolve", f"판정 불일치 {len(mism)}/{len(qrows)}건 → Jev 진화 필요 {jn['probs']['yes']:.2f}", run_id, pace=0.3)
        signals = {s for s in GRID if any(s in r.sig for r in M)}
        spec_f, log_f, leg_f = self.features("spec_agent"), self.features("log_agent"), self.features("legacy_agent")
        cands = []
        # (1) 판정 불일치: 레거시 코드값·단위 미해석 → 스킬·legacy 진화 (②③)
        holds = [c for c in judge_bad if c.get("judge", {}).get("hold") or c.get("judge", {}).get("missing")]
        if len(holds) >= 3 and "del_filter" not in leg_f:
            cid = f"{run_id}-A"
            g = self.candidate_genome("legacy_agent", {"del_filter", "typo_filter"}, set(),
                                      "code_value_resolver 1.1.0 적용(미문서화 코드 패턴 추론) + 소프트 삭제·오기록 필터", cid,
                                      skill_override={"code_value_resolver": "1.1.0"})
            self._ensure_skill("code_value_resolver", "1.1.0", run_id)
            cands.append({"cid": cid, "layer": 2, "target": "legacy_agent", "title": "레거시 코드값 해석 스킬 진화 (code_value_resolver 1.1.0)",
                          "why": f"판정 보류·누락 {len(holds)}건: " + ", ".join(sorted({h for c in holds for h in (c['judge'].get('hold') or c['judge'].get('missing'))}))[:80],
                          "genomes": [g], "skills": [{"skill_id": "code_value_resolver", "version": "1.1.0", "summary": "미문서화 코드 패턴 추론"}],
                          "skill_override": {"code_value_resolver": "1.1.0"},
                          "config": {"versions": {"legacy_agent": g["version"], "code_value_resolver": "1.1.0"}}})
        # (2) 교훈 마이닝 (①) + 필요 시 spec 코드 진화 (③)
        need_f = set(spec_f)
        need_f.add("lessons")
        recipes = {r.recipe for r in M}
        if len(recipes) > 1 or (clock.date() >= C.RECIPE_R2_FROM and any(r.recipe == "R1" for r in M)):
            need_f.add("recipe_cond")
        trial = self.mine_lessons(M, need_f | {"negative"}, signals)
        if any(L["correction"] < 0 for L in trial):
            need_f.add("negative")
        proc = self.mine_procedure(M, signals)
        if proc:
            need_f.add("procedure")
        lessons = self.mine_lessons(M, need_f, signals) + proc
        cur_keys = {self.lesson_key(x["content"]) for x in self.sys.memory.lessons(("active",))}
        if lessons and ({self.lesson_key(L) for L in lessons} != cur_keys or need_f != spec_f):
            cid = f"{run_id}-B"
            genomes = []
            ver = {}
            if need_f != spec_f:
                adds = need_f - spec_f
                from ..genomes.agents import SPEC_LOG
                g = self.candidate_genome("spec_agent", adds, set(), " / ".join(SPEC_LOG[a] for a in sorted(adds)), cid)
                genomes.append(g)
                ver["spec_agent"] = g["version"]
            cands.append({"cid": cid, "layer": 1 if not genomes else 3, "target": "spec_agent",
                          "title": "판단 로직 진화: 교훈 세트 갱신" + (f" + spec_agent 코드 ({', '.join(sorted(need_f - spec_f))})" if genomes else ""),
                          "why": f"마이닝 교훈 {len(lessons)}건 (기존 {len(cur_keys)}건)", "genomes": genomes, "new_lessons": lessons,
                          "config": {"versions": ver, "lessons": self.as_overlay(lessons)}})
        # (3) 로그 신호 품질 (③)
        log_cand = self._log_signal_candidate(qrows, M, log_f, signals, run_id)
        if log_cand:
            g = log_cand["genomes"][0]
            M2 = self._rows_with(M, mining, "log_agent", g["version"], "analyze", keep_keys=("month", "recipe_rev", "cycle_rf_hours", "fr_hours"))
            sig2 = {s_ for s_ in GRID if any(s_ in r.sig for r in M2)}
            les2 = self.mine_lessons(M2, need_f, sig2) + self.mine_procedure(M2, sig2)
            log_cand["new_lessons"] = les2
            log_cand["config"]["lessons"] = self.as_overlay(les2)
            cands.append(log_cand)
        # (4) 공용 스킬 추출 (②) — 반복 CodeAct 패턴
        reps = self.sys.store.kv_get("plan_pass_curve_reps", 0) or 0
        reps += len(qrows)
        self.sys.store.kv_set("plan_pass_curve_reps", reps)
        if reps >= 2000 and "pass_curve" not in leg_f and len(cands) < 3:
            cid = f"{run_id}-S"
            self._ensure_skill("seasoning_pass_curve", "1.0.0", run_id)
            g = self.candidate_genome("legacy_agent", {"pass_curve", "del_filter", "typo_filter"}, set(),
                                      "공용 스킬 seasoning_pass_curve 적용 (Super Agent 실행 계획의 매수별 Pass율 집계 코드 반복 → 스킬 추출)", cid,
                                      skill_override={"seasoning_pass_curve": "1.0.0"})
            cands.append({"cid": cid, "layer": 2, "target": "legacy_agent", "title": "공용 스킬 추출: seasoning_pass_curve", "refactor": True,
                          "why": f"실행 계획 코드 내 '매수별 1차 Pass율 집계' 동일 패턴 {reps:,}회 반복", "genomes": [g],
                          "skills": [{"skill_id": "seasoning_pass_curve", "version": "1.0.0", "name_ko": "Seasoning Pass 곡선", "summary": "추출"}],
                          "skill_override": {"seasoning_pass_curve": "1.0.0"},
                          "config": {"versions": {"legacy_agent": g["version"], "seasoning_pass_curve": "1.0.0"}, "rerun_history": True}})
        # (5) 신규 Agent 편성 결합 (⑤) — chamber_trend 신호
        ct = self.sys.registry.agent("chamber_trend_agent")
        if ct and ct["status"] in ("probation", "active") and "chamber_trend_agent" not in base_cfg["merge"] and len(cands) < 3:
            cid = f"{run_id}-O"
            merge = base_cfg["merge"] + ["chamber_trend_agent"]
            sig2 = signals | {"cycle_rf_hours"}
            sigrows = self._with_trend(M, mining)
            lessons2 = self.mine_lessons(sigrows, need_f, sig2) + proc
            cands.append({"cid": cid, "layer": 5, "target": "super_agent", "title": "편성 전략: chamber_trend_agent 신호 결합 (super_agent)",
                          "why": "신규 Agent(PM 사이클 추이) 신호를 실행 계획에 결합", "genomes": [], "new_lessons": lessons2,
                          "super_params": {"merge_signals": merge},
                          "config": {"merge": merge, "lessons": self.as_overlay(lessons2)}})
        # (6) chamber_trend 자체 진화 (③, probation 0.x)
        if ct and ct["status"] == "probation" and "chamber_trend_agent" in base_cfg["merge"] and len(cands) < 3:
            tf = self.features("chamber_trend_agent")
            nxt = "wc_cycle" if "wc_cycle" not in tf else ("interp" if "interp" not in tf else None)
            if nxt:
                cid = f"{run_id}-T"
                msg = {"wc_cycle": "사이클 경계를 '직전 PM'에서 '직전 Wet Clean'으로 수정", "interp": "RF 사용 기록 결측일 평균 보간"}[nxt]
                g = self.candidate_genome("chamber_trend_agent", {nxt}, set(), msg, cid)
                M3 = self._rows_with(M, mining, "chamber_trend_agent", g["version"], "trend")
                les3 = self.mine_lessons(M3, need_f, signals | {"cycle_rf_hours"}) + proc
                cands.append({"cid": cid, "layer": 3, "target": "chamber_trend_agent", "title": f"chamber_trend_agent 코드 진화: {msg}",
                              "why": "사이클 신호 기반 교훈의 잔여 오차 (U-군집)", "genomes": [g], "new_lessons": les3,
                              "config": {"versions": {"chamber_trend_agent": g["version"]}, "lessons": self.as_overlay(les3)}})
        cands = cands[: self.sys.policy["loop_budget"]["L3"]["max_candidates"]]
        self._node("mutate", f"변이 후보 {len(cands)}개: " + " / ".join(c["title"][:40] for c in cands), run_id, pace=0.4,
                   candidates=[{"cid": c["cid"], "title": c["title"], "layer": LAYER_KO[c["layer"]]} for c in cands])
        # 평가
        results = []
        sel = self.sys.policy["selection"]
        for c in cands:
            cfg = json.loads(json.dumps(base_cfg, default=str))
            cfg["versions"].update(c["config"].get("versions", {}))
            for k in ("lessons", "merge", "rerun_history"):
                if k in c["config"]:
                    cfg[k] = c["config"][k]
            e, v = H.evaluate(cfg, Mc, c["cid"]), H.evaluate(cfg, Vc, c["cid"])
            dE = round(e["accuracy"] - bE["accuracy"], 2)
            dV = round(v["accuracy"] - bV["accuracy"], 2) if v.get("n") else 0.0
            dErr = round(e["rec_error"] - bE["rec_error"], 2)
            dW = round(e["wafer_usage"] - bE["wafer_usage"], 2)
            dU = e.get("unavailable", 0) - bE.get("unavailable", 0)
            improve = dE >= sel["min_improvement_pp"] or (dE >= 0 and (dErr <= -0.2 or e["first_pass_rate"] - bE["first_pass_rate"] >= 0.5 or dU < 0))
            if c.get("refactor"):
                improve = dE >= -0.05 and dErr <= 0.05        # 스킬 추출·리팩터링: 정확도 비하락이면 채택 (중복 감소가 목적)
            ok = improve and dV >= -sel["heldout_tolerance_pp"]
            reason = (f"Evolve셋 {dE:+.1f}%p / 검증셋 {dV:+.1f}%p / 추천 오차 {dErr:+.2f}매" + (f" / 확인 불가 {dU:+d}건" if dU else "") + " → " +
                      ("채택" if ok else ("기각 (검증셋 하락)" if improve else "기각 (개선 없음)")))
            results.append({"cand": c, "E": e, "V": v, "dE": dE, "dV": dV, "dErr": dErr, "dW": dW, "ok": ok, "reason": reason})
            self.sys.bus.emit("candidate", run_id=run_id, cid=c["cid"], title=c["title"], layer=LAYER_KO[c["layer"]], dE=dE, dV=dV,
                              accE=e["accuracy"], accV=v.get("accuracy"), ok=ok, reason=reason)
            self._node("evaluate_harness", f"{c['cid']} {c['title'][:36]} — {reason}", run_id, pace=0.35)
        # 교훈 세트 충돌: B와 O 둘 다 통과하면 Evolve 점수 높은 쪽만
        lesson_c = [r for r in results if r["ok"] and r["cand"].get("new_lessons") is not None]
        if len(lesson_c) > 1:
            # 편성 결합 후보(O)는 교훈 재마이닝을 포함하므로 둘 다 통과하면 O에 통합
            o = [r for r in lesson_c if r["cand"]["cid"].endswith(("-O", "-T", "-L"))]
            top = max(r["dE"] for r in lesson_c)
            best = max(o, key=lambda r: r["dE"]) if o and max(r["dE"] for r in o) >= top - 0.5 else max(lesson_c, key=lambda r: r["dE"])
            for r in lesson_c:
                if r is not best:
                    if r["cand"]["cid"].endswith("-B") and r["cand"]["genomes"]:
                        best["cand"]["genomes"] = r["cand"]["genomes"] + best["cand"]["genomes"]
                    r["ok"] = False
                    r["reason"] += " → 동일 교훈 계층 상위 후보에 통합"
        adopted, report_c = [], []
        for r in results:
            c = r["cand"]
            scores = {"evolve": r["E"].get("accuracy"), "valid": r["V"].get("accuracy"), "dE": r["dE"], "dV": r["dV"], "dErr": r["dErr"],
                      "first_pass": r["E"].get("first_pass_rate"), "wafer": r["E"].get("wafer_usage")}
            changes = []
            lesson_res = None
            if r["ok"]:
                changes = self.promote_candidate(c, run_id, c["title"])
                if c.get("new_lessons") is not None:
                    lesson_res = self.register_lessons(c["new_lessons"], clock, run_id, quarter)
                adopted.append(c["cid"])
            else:
                for gd in c.get("genomes", []):
                    self.sys.registry.set_genome_status(gd["agent_id"], gd["version"], "rejected")
                tk = c.get("trigger", c["cid"].split("-")[-1])
                cd = self.sys.store.kv_get("evolve_rejects", {}) or {}
                cd[tk] = cd.get(tk, 0) + 1
                self.sys.store.kv_set("evolve_rejects", cd)
            arc = self.archive(c, "adopt" if r["ok"] else "reject", r["reason"], scores, run_id, c["layer"])
            report_c.append({"cid": c["cid"], "title": c["title"], "layer": LAYER_KO[c["layer"]], "why": c.get("why"), "decision": "adopt" if r["ok"] else "reject",
                             "reason": r["reason"], "scores": scores, "changes": changes, "archive_id": arc,
                             "lessons": lesson_res, "diffs": [{k: g[k] for k in ("agent_id", "summary", "diff_add", "diff_del")} for g in c.get("genomes", [])]})
        self._node("select", f"채택 {len(adopted)} / 기각 {len(cands) - len(adopted)} (Evolve셋 개선 ∧ 검증셋 비하락)", run_id, pace=0.3)
        self._node("archive", "채택·기각 후보 전부 진화 아카이브 보관 (다음 진화 출발점)", run_id, pace=0.2)
        # 미해결 오차 군집 / Grow
        clusters, grow = self._residuals(quarter, clock, run_id, M)
        return {"quarter": quarter, "base": {"E": bE, "V": bV}, "candidates": report_c, "adopted": adopted, "clusters": clusters,
                "grow": grow, "jev": jn["probs"]["yes"]}

    def _ensure_skill(self, sid, ver, ref):
        reg = self.sys.registry
        if not reg.agent(sid):
            reg.register_agent(sid, "skill", {"seasoning_pass_curve": "Seasoning Pass 곡선", "fdc_toolkit": "FDC 툴킷",
                                              "code_value_resolver": "코드값 해석기"}.get(sid, sid), origin=f"Evolve {ref}", status="candidate")
        if not reg.genome(sid, ver):
            reg.add_genome(sid, ver, skill_sources()[sid][ver], reason="evolve-candidate", ref=ref, status="candidate")

    def _rows_with(self, M: list[Row], mining, agent_id: str, version: str, action: str, keep_keys=None) -> list[Row]:
        """후보 Agent 버전의 신호로 마이닝 행을 다시 만든다 (하네스 캐시 재사용) — 신호 정의가 바뀌면 교훈도 재마이닝."""
        by_id = {x["id"]: x["content"] for x in mining}
        cache = self.sys.harness.__dict__.setdefault("_tcache", {})
        out = []
        for r in M:
            c = by_id[r.id]
            if agent_id == "chamber_trend_agent" and not (c["eqp_group"] in ("CVD", "PVD") and c["pm_type"] in ("QUARTERLY_PM", "PUMP_PM", "ALARM_RECOVERY")):
                out.append(r)
                continue
            key = (agent_id, version, action, c["qh_seq"])
            if key not in cache:
                ctx = RunContext(self.sys, mode="replay", replay_clock=P(c["request_ts"]), run_shadow=False, quiet=True, cache_store={})
                inp = {"eqp_id": c["eqp_id"], "chamber_id": c["chamber_id"], "pm_type": c["pm_type"], "pm_start": c["pm_start"],
                       "pm_end": c["pm_end"], "eqp_group": c["eqp_group"], "eqp_model": c["eqp_model"]}
                res = self.sys.runtime._execute(ctx, agent_id, version, action, inp, False)
                cache[key] = (res.get("output") or {}).get("signals") or {}
            r2 = Row(r.id, c)
            base_sig = {k: v for k, v in r.sig.items() if k in (keep_keys or ())} if keep_keys is not None else dict(r.sig)
            r2.sig = dict(base_sig, **cache[key])
            out.append(r2)
        return out

    def _with_trend(self, M: list[Row], mining) -> list[Row]:
        """chamber_trend 신호를 붙인 마이닝 행 (하네스 캐시 재사용)."""
        ver = self.sys.registry.agent("chamber_trend_agent")["active_version"]
        out = []
        by_id = {x["id"]: x["content"] for x in mining}
        for r in M:
            c = by_id[r.id]
            if c["eqp_group"] in ("CVD", "PVD") and c["pm_type"] in ("QUARTERLY_PM", "PUMP_PM", "ALARM_RECOVERY"):
                ctx = RunContext(self.sys, mode="replay", replay_clock=P(c["request_ts"]), run_shadow=False, quiet=True, cache_store={})
                key = ("chamber_trend_agent", ver, "trend", c["qh_seq"])
                cache = self.sys.harness.__dict__.setdefault("_tcache", {})
                if key not in cache:
                    res = self.sys.runtime._execute(ctx, "chamber_trend_agent", ver, "trend",
                                                    {"eqp_id": c["eqp_id"], "chamber_id": c["chamber_id"], "pm_end": c["pm_end"], "eqp_group": c["eqp_group"]}, False)
                    cache[key] = (res.get("output") or {}).get("signals") or {}
                r.sig = dict(r.sig, **cache[key])
            out.append(r)
        return out

    def _cooling(self, trigger: str) -> bool:
        cd = self.sys.store.kv_get("evolve_rejects", {}) or {}
        return cd.get(trigger, 0) >= 2

    def _log_signal_candidate(self, qrows, M, log_f, signals, run_id):
        miss = sum(1 for c in qrows if "rf_refl_delta_pct" not in (c.get("signals") or {}) and c["eqp_group"] != "PVD")
        cid = f"{run_id}-L"
        pick = None
        if "summary" not in log_f and miss >= 2 and not self._cooling("log:summary"):
            pick = ("summary", f"POST_PM 트레이스 미수집으로 RF 지표 확인 불가 {miss}건 → 장비 Run Summary 폴백")
        elif "bp" not in log_f and any(r.leakfail and r.month in (7, 8) for r in M) and not self._cooling("log:bp"):
            pick = ("bp", "장마철 Leak Fail 군집 — Leak 로그의 BP 안정화 시간 신호 추출 (절차 교훈 정밀화)")
        elif "median" not in log_f and not self._cooling("log:median"):
            near = [r for r in M if r.sig.get("rf_refl_delta_pct") is not None and 9 <= r.sig["rf_refl_delta_pct"] <= 13]
            if len(near) >= 6:
                pick = ("median", f"RF Reflected 임계 근처 {len(near)}건 — 초기 구간 스파이크 영향 → 중앙값(스파이크 강건) 집계")
        elif "multirun" not in log_f and not self._cooling("log:multirun"):
            pick = ("multirun", "PM 전 기준값 노이즈 — 직전 생산 Run 2개 중앙값을 기준으로")
        if not pick:
            return None
        g = self.candidate_genome("log_agent", {pick[0]}, set(), pick[1], cid)
        cand = {"cid": cid, "layer": 3, "target": "log_agent", "title": f"log_agent 코드 진화: {pick[1][:50]}", "why": pick[1], "genomes": [g],
                "trigger": f"log:{pick[0]}",
                "config": {"versions": {"log_agent": g["version"]}}}
        return cand

    def _residuals(self, quarter, clock, run_id, M: list[Row]):
        """설명되지 않는 오차 군집 → 미해결 군집 기록 또는 반복 필요 분석 발견 시 Grow."""
        rows = [r for r in M if r.rel]
        cfg_lessons = [x["content"] for x in self.sys.memory.lessons(("active",))]

        def req(r):
            tot = r.base
            for L in cfg_lessons:
                if L.get("kind") == "procedure":
                    continue
                if L["eqp_model"] == r.model and L["pm_type"] == r.pm and (not L.get("recipe_rev") or L["recipe_rev"] == r.recipe) \
                        and cond_match(L.get("condition"), r.sig):
                    tot += L["correction"]
            return tot
        resid = defaultdict(list)
        for r in rows:
            if not r.pass1 and r.n1 >= req(r):
                fam = r.fails & SEASON_FAIL
                item = "ER Uniformity" if fam & {"ER", "ERU"} else ("Rs Uniformity" if "RSU" in fam else ("THK Uniformity" if fam & {"DR", "THU"} else "-"))
                resid[(r.model, r.pm, item)].append(r)
        out, grow = [], None
        existing = {json.dumps(x["content"]["key"]): x for x in self.sys.memory.search({"kind": "cluster"}, 50)}
        for (model, pm, item), rs in sorted(resid.items(), key=lambda kv: -len(kv[1])):
            if len(rs) < 10:
                continue
            key = [model, pm, item]
            grp = [r for r in rows if r.model == model and r.pm == pm]
            lifts = {}
            for s in sorted(GRID):
                vals = [r for r in grp if r.sig.get(s) is not None]
                if len(vals) < 10:
                    continue
                for t in GRID[s]:
                    hi = [r for r in vals if r.sig[s] >= t]
                    lo = [r for r in vals if r.sig[s] < t]
                    if len(hi) >= 5 and len(lo) >= 5:
                        rh = sum(not r.pass1 for r in hi) / len(hi)
                        rl = sum(not r.pass1 for r in lo) / len(lo)
                        lifts[f"{s}≥{t}"] = round(rh / max(rl, 0.02), 2)
            days_lift = self._days_since_wc_lift(grp, clock) if pm in ("QUARTERLY_PM", "PUMP_PM", "ALARM_RECOVERY") and model == "CVX-200" else 0
            if days_lift >= 1.6 and not self.sys.registry.agent("chamber_trend_agent"):
                j = self.sys.jev.decide("반복적으로 필요한 신규 분석인가?", "yes_no", ["yes", "no"],
                                        {"head": "need_grow", "lift": days_lift, "cases": len(rs), "covered": 0})
                if j["answer"] == "yes":
                    self._node("jev_need_grow", f"잔여 오차 군집 {model} {PM_KO[pm]} {len(rs)}건 — 직전 Wet Clean 경과일 lift {days_lift:.1f}배 → "
                               f"PM 사이클 간 추이 분석 반복 필요 (Jev {j['probs']['yes']:.2f}) → L2 Grow", run_id, pace=0.5)
                    ctx = RunContext(self.sys, mode="replay", replay_clock=clock, quiet=True)
                    grow = self.sys.factory.grow(None, ctx, need=["cycle_trend"], reason=f"{quarter} 잔여 오차 군집 {model} {PM_KO[pm]}")
                    continue
            if max(lifts.values(), default=0) >= 2.0:
                continue
            ek = json.dumps(key)
            text = f"{model} {PM_KO[pm]} 후 {item} 1차 Fail {len(rs)}건: 보유 데이터(FDC·Qual 이력)로 설명 불가"
            if ek in existing:
                mid = existing[ek]["id"]
                self.sys.memory.update(mid, content={**existing[ek]["content"], "count": len(rs), "text": text, "updated_q": quarter})
            else:
                mid = self.sys.memory.record("cluster", {"key": key, "count": len(rs), "text": text, "first_q": quarter, "status": "open",
                                                          "lifts_tested": lifts}, clock, eqp_model=model, pm_type=pm,
                                             source_case_ids=[r.id for r in rs])
            out.append({"id": mid, "text": text, "count": len(rs)})
        return out, grow

    def _days_since_wc_lift(self, grp: list[Row], clock) -> float:
        ctx = RunContext(self.sys, mode="replay", replay_clock=clock, quiet=True)
        q = self.sys.world.legacy_query("SELECT EQP_ID, CHB_ID, PM_END_DT FROM QUAL_HIS WHERE PM_TP_CD IN ('W0','W1') AND EQP_ID LIKE 'CVD%' AND DEL_YN='N'",
                                        None, clock, True)
        wc = defaultdict(list)
        for eqp, chb, dt in q["rows"]:
            ch = {"1": "A", "2": "B", "3": "C"}.get(chb, chb)
            wc[f"{eqp}-{ch}"].append(f"{dt[:4]}-{dt[4:6]}-{dt[6:8]}")
        hi, lo = [], []
        for r in grp:
            prev = [d for d in wc.get(r.chamber, []) if d < r.pm_end[:10]]
            if not prev:
                continue
            days = (P(r.pm_end[:10]) - P(max(prev))).days
            (hi if days >= 120 else lo).append(r)
        if len(hi) < 5 or len(lo) < 5:
            return 0.0
        rh = sum(not r.pass1 for r in hi) / len(hi)
        rl = sum(not r.pass1 for r in lo) / len(lo)
        return round(rh / max(rl, 0.02), 2)
