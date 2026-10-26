"""History Replay Evolving — 레거시 Qual 이력을 시간순 가상 요청으로 재생 (Walk-forward, Time-Travel Guard).

build_replay_requests → (분기별) set_replay_clock → L1 리플레이 그래프 → compare_actual → 분기 종료 시 L3 Evolve
최근 6개월(Held-out)은 진화 없이 최종 평가만 수행한다.
"""
from __future__ import annotations

import sqlite3
import statistics
from datetime import datetime, timedelta

from mock_env import config as C

from ..tools import P, S

QUARTERS = [(y, q) for y in (2023, 2024, 2025, 2026) for q in (1, 2, 3, 4) if (2023, 3) <= (y, q) <= (2026, 2)]


def qlabel(d: datetime) -> str:
    return f"{d.year} Q{(d.month - 1) // 3 + 1}"


def quarter_end(label: str) -> datetime:
    y, q = int(label[:4]), int(label[-1])
    m = 3 * q
    return (datetime(y + (m == 12), m % 12 + 1, 1) - timedelta(seconds=1))


def build_replay_requests(sysm, start="2023-07-01", end="2026-06-30", heldout_start="2026-01-01") -> list[dict]:
    """레거시 이력 → 시간순 가상 요청. 실제 결과는 참조(actual_outcome_ref)로만 붙이고 비교 시점에 사용한다."""
    lg = sqlite3.connect(f"file:{sysm.world.legacy_path.as_posix()}?mode=ro", uri=True)
    fdc = sqlite3.connect(f"file:{(sysm.root / 'mock_env' / 'data' / 'fdc.db').as_posix()}?mode=ro", uri=True)
    rows = lg.execute("SELECT QH_SEQ, EQP_ID, CHB_ID, PM_TP_CD, PM_END_DT, PROC_ID, SSN_CNT_1, Q1_RSLT_CD, Q1_FAIL_ITM, SSN_CNT_FNL, ENG_ID, "
                      "ACT_MEMO, EVT_TS FROM QUAL_HIS WHERE DEL_YN='N' AND PM_END_DT>=? AND PM_END_DT<=? ORDER BY PM_END_DT",
                      (start.replace("-", "") + "000000", end.replace("-", "") + "235959")).fetchall()
    meas = {r[0]: r[1] for r in lg.execute("SELECT QH_SEQ, MIN(REG_DT) FROM QUAL_MEAS WHERE MEAS_SEQ=1 GROUP BY QH_SEQ")}
    proc_pm = {v["short"]: k for k, v in C.PM_TYPES.items()}
    out = []
    for qh, eqp, chb, pmc, pm_end, proc, n1, q1, fi, fnl, eng, memo, evt in rows:
        ch = {"1": "A", "2": "B", "3": "C"}.get(chb, chb)
        pm_type = proc_pm.get(proc.split("-")[2]) if proc else C.LEGACY_PM_DECODE.get(pmc)
        pe = f"{pm_end[:4]}-{pm_end[4:6]}-{pm_end[6:8]} {pm_end[8:10]}:{pm_end[10:12]}:{pm_end[12:14]}"
        cid = f"{eqp}-{ch}"
        ps = fdc.execute("SELECT PM_START FROM PM_EVENT WHERE CHAMBER_ID=? AND PM_END=?", (cid, pe)).fetchone()
        pm_end_dt = P(pe)
        out.append({"qh_seq": qh, "eqp_id": eqp, "chamber": ch, "chamber_id": cid, "eqp_model": C.EQP_MODEL[eqp], "eqp_group": C.EQP_GROUP[eqp],
                    "pm_type": pm_type, "pm_start": ps[0] if ps else S(pm_end_dt - timedelta(hours=6)), "pm_end": pe,
                    "request_ts": S(pm_end_dt + timedelta(minutes=10)), "meas_ts": meas.get(qh) or evt, "evt_ts": evt, "n1": n1, "q1": q1,
                    "fail_items": fi, "final": fnl, "eng": eng, "memo": memo or "", "wait": "대기" in (memo or "").split("1차")[0],
                    "quarter": qlabel(pm_end_dt), "split": "heldout" if pe >= heldout_start else "evolve",
                    "text": f"{eqp} {ch}챔버 {C.PM_TYPES[pm_type]['name']} PM 끝났어. AutoQual 진행해줘"})
    lg.close()
    fdc.close()
    return out


def replay_state(case: dict) -> dict:
    hint = {k: case[k] for k in ("eqp_id", "chamber", "chamber_id", "pm_type", "pm_start", "pm_end")}
    return {"request": {"request_id": f"RP-{case['qh_seq']}", "text": case["text"], "hint": hint, "source": "replay"},
            "mode": "replay", "replay_clock": case["request_ts"], "replay": case}


class ReplayEngine:
    """SC-006 리플레이 사전 진화 실행기."""

    def __init__(self, sysm):
        self.sys = sysm

    def quarter_metrics(self, quarter: str) -> dict:
        rows = [x["content"] for x in self.sys.memory.cases(mode="replay") if x["content"]["quarter"] == quarter]
        if not rows:
            return {"n": 0}
        truth = self.sys.harness.truth_by_qh()
        n = len(rows)
        acc = sum(c["match"]["overall"] for c in rows) / n * 100
        pred = sum(c["match"]["pred"] for c in rows) / n * 100
        judge = sum(c["match"]["judge"] for c in rows) / n * 100
        errs = [abs((c.get("required_est") or 0) - truth[c["qh_seq"]].R) for c in rows if c["qh_seq"] in truth]
        return {"n": n, "accuracy": round(acc, 1), "pred_acc": round(pred, 1), "judge_acc": round(judge, 1),
                "rec_error": round(statistics.mean(errs), 1) if errs else None,
                "guard_blocked": sum(c.get("guard_blocked", 0) for c in rows), "leaks": sum(c.get("leaks", 0) for c in rows)}

    def run(self, spotlight_every: int = 60, on_quarter=None, until_quarter: str | None = None):
        sysm = self.sys
        bus = sysm.bus
        reqs = build_replay_requests(sysm)
        by_q: dict[str, list] = {}
        for r in reqs:
            by_q.setdefault(r["quarter"], []).append(r)
        quarters = sorted(by_q, key=lambda q: (int(q[:4]), int(q[-1])))
        sysm.store.kv_set("replay_status", {"state": "running", "total": len(reqs), "quarters": quarters})
        bus.emit("replay_progress", phase="start", total=len(reqs), quarters=quarters,
                 evolve=sum(1 for r in reqs if r["split"] == "evolve"), heldout=sum(1 for r in reqs if r["split"] == "heldout"))
        done = 0
        rows_out = []
        for q in quarters:
            cases = by_q[q]
            heldout = cases[0]["split"] == "heldout"
            heals0 = sysm.store.scalar("SELECT COUNT(*) FROM reports WHERE kind='heal'") or 0
            grows0 = sysm.store.scalar("SELECT COUNT(*) FROM reports WHERE kind='grow'") or 0
            bus.emit("replay_progress", phase="quarter_start", quarter=q, split="heldout" if heldout else "evolve", n=len(cases))
            for i, case in enumerate(cases):
                spot = spotlight_every and i % spotlight_every == 0
                sysm.clock.set(P(case["request_ts"]))
                if spot:
                    bus.emit("replay_case", quarter=q, qh_seq=case["qh_seq"], chamber_id=case["chamber_id"], pm_type=case["pm_type"],
                             text=case["text"], replay_clock=case["request_ts"])
                    out = sysm.l1.replay.invoke(replay_state(case))
                    bus.emit("replay_case_done", quarter=q, qh_seq=case["qh_seq"], compare=out.get("compare"), chamber_id=case["chamber_id"],
                             pm_type=case["pm_type"],
                             recommendation=(out.get("synth") or {}).get("recommendation"),
                             text=(out.get("synth") or {}).get("text", "")[:1500], actual={"n1": case["n1"], "q1": case["q1"]})
                else:
                    with bus.muted():
                        sysm.l1.replay.invoke(replay_state(case))
                done += 1
                if done % 20 == 0:
                    g = sysm.world.guard_stats
                    bus.emit("replay_progress", phase="case", done=done, total=len(reqs), quarter=q, replay_clock=case["request_ts"],
                             guard=g["queries_filtered"] + g["blocked_tables"])
                    bus.pace(0.02)
            sysm.flush()
            m = self.quarter_metrics(q)
            heals = (sysm.store.scalar("SELECT COUNT(*) FROM reports WHERE kind='heal'") or 0) - heals0
            evo = None
            run_id = None
            if not heldout:
                qe = quarter_end(q)
                sysm.clock.set(qe)
                run_id = sysm.store.next_id("V-", 2)
                bus.emit("story", text=f"[L3 Evolve] {q} 종료 — 분기 진화 {run_id} (Walk-forward)")
                evo = sysm.evolver.replay_quarter(q, qe, run_id)
                self._save_evolve_report(run_id, q, evo)
            grows = (sysm.store.scalar("SELECT COUNT(*) FROM reports WHERE kind='grow'") or 0) - grows0
            versions = {a["agent_id"]: a["active_version"] for a in sysm.registry.agents(None) if a["active_version"]}
            row = {"quarter": q, "split": "heldout" if heldout else "evolve", **m, "heals": heals, "grows": grows,
                   "adopted": (evo or {}).get("adopted", []), "evolve_id": run_id,
                   "new_lessons": sum(len(((c.get("lessons") or {}).get("new") or [])) for c in (evo or {}).get("candidates", [])),
                   "expired_lessons": sum(len(((c.get("lessons") or {}).get("expired") or [])) for c in (evo or {}).get("candidates", [])),
                   "lessons_active": len(sysm.memory.lessons(("active",))), "versions": versions,
                   "events": self._events(evo, heals0), "clusters": [c["id"] for c in (evo or {}).get("clusters", [])]}
            rows_out.append(row)
            sysm.store.kv_set("replay_rows", rows_out)
            bus.emit("replay_quarter", **row)
            if on_quarter:
                on_quarter(row)
            if until_quarter and q == until_quarter:
                return {"rows": rows_out}
        final = self.final_eval()
        sysm.store.kv_set("replay_status", {"state": "done", "total": len(reqs)})
        rep = {"rows": rows_out, "final": final, "guard": dict(sysm.world.guard_stats, blocked_log=sysm.world.guard_stats["blocked_log"][:30])}
        sysm.store.insert("reports", {"report_id": "REPLAY-01", "kind": "replay", "title": "리플레이 진화 리포트 (SC-006)",
                                      "ts": S(sysm.clock.now()), "content": rep})
        bus.emit("report", kind="replay", report_id="REPLAY-01", title="리플레이 진화 리포트", content={"final": final})
        return rep

    def _events(self, evo, heals0):
        ev = []
        for h in self.sys.store.all("SELECT content FROM reports WHERE kind='heal' ORDER BY report_id")[heals0:]:
            c = h["content"]
            if c.get("status") == "healed":
                ev.append(f"Heal: {c['agent_id']} {c['from_version']}→{c['to_version']} — {(c['attempts'][-1] or {}).get('summary', '')[:34]}")
        if (evo or {}).get("grow") and evo["grow"].get("ok"):
            ev.append(f"Grow: {evo['grow']['agent_id']} {evo['grow']['version']} 생성 (PM 사이클 간 추이 분석이 반복 필요)")
        for c in (evo or {}).get("candidates", []):
            if c["decision"] == "adopt":
                ev.append(f"Evolve: {c['title'][:64]} (" + ", ".join(f"{x['agent_id'].replace('_agent', '')} {x['to']}" for x in c["changes"]) + ")")
        for c in (evo or {}).get("candidates", []):
            ex = ((c.get("lessons") or {}).get("expired") or [])
            if ex:
                ev.append(f"교훈 만료 {len(ex)}건 (적용 조건 불일치) → 재학습")
        return ev

    def _save_evolve_report(self, run_id, q, evo):
        title = f"진화 리포트 #{run_id} — 리플레이 {q}"
        self.sys.store.insert("reports", {"report_id": run_id, "kind": "evolve", "title": title, "ts": S(self.sys.clock.now()),
                                          "content": dict(evo, mode="replay", grow=(evo.get("grow") or {}).get("grow_id"))})
        self.sys.bus.emit("report", kind="evolve", report_id=run_id, title=title,
                          content={"quarter": q, "adopted": evo["adopted"], "candidates": evo["candidates"]})

    def final_eval(self) -> dict:
        """Held-out(2026 H1) — 진화 전(전 Agent 1.0.0) vs 진화 후를 하네스로 같은 건에 대해 재채점."""
        allc = [x["content"] for x in self.sys.memory.cases(mode="replay")]
        cases = [c for c in allc if c["split"] == "heldout"]
        H = self.sys.harness
        base_cfg = {"versions": {"spec_agent": "1.0.0", "log_agent": "1.0.0", "legacy_agent": "1.0.0", "code_value_resolver": "1.0.0",
                                 "legacy_sql_toolkit": "1.0.0"},
                    "lessons": [], "merge": ["log_agent"], "rerun_history": True}
        cfg = self.sys.evolver.active_config()
        cfg["lessons"] = self.sys.evolver.as_overlay([x["content"] for x in cfg["lessons"]])
        before = H.evaluate(base_cfg, cases, "before")
        after = H.evaluate(cfg, cases, "after")
        views = (self.sys.store.kv_get("heldout_views", 0) or 0) + 1
        self.sys.store.kv_set("heldout_views", views)
        g = self.sys.world.guard_stats
        return {"n": len(cases), "before": {k: v for k, v in before.items() if k != "per_group"},
                "after": {k: v for k, v in after.items() if k != "per_group"},
                "replayed": self.quarter_metrics("2026 Q1"), "replayed_q2": self.quarter_metrics("2026 Q2"),
                "leaks": sum(c.get("leaks", 0) for c in allc),
                "guard_blocked": g["queries_filtered"] + g["blocked_tables"], "guard_rows_hidden": g["rows_hidden"],
                "guard_tables": g["blocked_tables"], "heldout_views": views}
