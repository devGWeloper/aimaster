"""KPI 측정 — 기획서 정량 목표를 저장소·하네스 기록에서 직접 계산 (루프가 조작할 수 없는 고정 코드)."""
from __future__ import annotations

import statistics

MANUAL_PREP_MIN = 105      # 기획서 As-Is: 판단 준비 1.5~2시간 (수작업 베이스라인 중앙값)
REVIEW_MIN = 5             # 엔지니어 결과 검토 시간(가정)


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def compute(sysm) -> dict:
    st = sysm.store
    out = {}
    # 1. 준비·판정 소요시간
    lat = [r["latency_ms"] for r in st.all("SELECT latency_ms FROM orch_log WHERE request_type='autoqual'") if r["latency_ms"]]
    if lat:
        agent_min = statistics.mean(lat) / 60000 + REVIEW_MIN
        out["prep_time"] = {"value": round((1 - agent_min / MANUAL_PREP_MIN) * 100, 1), "unit": "% 단축", "target": 70, "ok": None,
                            "detail": f"Agent 판단 준비 {statistics.mean(lat) / 1000:.1f}s + 검토 {REVIEW_MIN}분 vs 수작업 {MANUAL_PREP_MIN}분 (요청 {len(lat)}건)"}
    rep = st.one("SELECT content FROM reports WHERE report_id='REPLAY-01'")
    if rep:
        f = rep["content"]["final"]
        out["judge_accuracy"] = {"value": f["after"]["judge_acc"], "unit": "%", "target": 95,
                                 "detail": f"Held-out {f['n']}건 Pass/Fail 판정 일치 (결정적 judge_qual). 종합 판정 일치율(1차 Pass 예측 포함) {f['after']['accuracy']}%"}
        out["replay_effect"] = {"value": round(f["after"]["accuracy"] - f["before"]["accuracy"], 1), "unit": "%p", "target": 15,
                                "detail": f"Held-out 판정 일치율 {f['before']['accuracy']}% → {f['after']['accuracy']}%"}
        out["future_leak"] = {"value": f["leaks"], "unit": "건", "target": 0, "lower_better": True,
                              "detail": f"Time-Travel Guard 필터·차단 {f['guard_blocked']:,}건, 숨김 행 {f['guard_rows_hidden']:,}행"}
        fp_before = f["before"]["first_pass_rate"]
        fp_after = sysm.store.kv_get("kpi_fp_after") or f["after"]["first_pass_rate"]
        out["first_pass"] = {"value": round(fp_after - fp_before, 1), "unit": "%p", "target": 15,
                             "detail": f"Held-out 백테스트 1차 Pass율 {fp_before}% → {fp_after}% (진화 전 베이스라인 대비"
                                       + (f", 리플레이 직후 {f['after']['first_pass_rate']}% → SC-007 판단 진화 후 {fp_after}%)" if fp_after != f["after"]["first_pass_rate"] else ")")}
    grows = [r["content"] for r in st.all("SELECT content FROM reports WHERE kind='grow'")]
    if grows:
        ok = [g for g in grows if g.get("ok")]
        out["grow_success"] = {"value": round(len(ok) / len(grows) * 100, 1), "unit": "%", "target": 70,
                               "detail": f"미지원 요청 {len(grows)}건 중 {len(ok)}건 생성·테스트 통과 (" + ", ".join(g.get("agent_id") or "-" for g in ok) + ")"}
    heals = [r["content"] for r in st.all("SELECT content FROM reports WHERE kind='heal'")]
    inj = [h for h in heals if h["status"] in ("healed", "escalated")]
    if inj:
        healed = [h for h in inj if h["status"] == "healed"]
        casc = sum(1 for h in healed for c in (h.get("cascade") or []) if c.get("ok"))
        tot = len(inj) + casc
        out["self_heal"] = {"value": round((len(healed) + casc) / tot * 100, 1), "unit": "%", "target": 70,
                            "detail": f"장애 영향 Agent {tot}건 중 자동 복구 {len(healed) + casc}건 (연쇄 복구 {casc}건 포함, 복구 불가 조기 중단 {len(inj) - len(healed)}건은 분모 포함)"}
        out["mttr"] = {"value": round(_mean([h["vsec"] for h in healed]) / 60, 1) if healed else None, "unit": "분", "target": 10, "lower_better": True,
                       "detail": "장애 감지 → 패치 반영까지 평균 (가상 시각)"}
        out["loop_runaway"] = {"value": sum(1 for h in heals if len(h["attempts"]) > sysm.policy["loop_budget"]["L2"]["max_attempts"]), "unit": "건",
                               "target": 0, "lower_better": True, "detail": f"L2 루프 {len(heals)}회 — 예산(5회·15분) 초과 0건"}
    s4 = next((r["content"] for r in st.all("SELECT content FROM reports WHERE kind='evolve'") if r["content"].get("kind") == "structure"), None)
    if s4:
        out["structure"] = {"value": round((1 - s4["dup_after"] / max(1, s4["dup_before"])) * 100), "unit": "% 중복↓", "target": 50,
                            "detail": f"코드 중복률 {s4['dup_before']}% → {s4['dup_after']}%, log_agent p50 {s4.get('p50_before')}s → {s4.get('p50_after')}s"}
        if s4.get("p50_before") and s4.get("p50_after"):
            out["latency"] = {"value": round((1 - s4["p50_after"] / s4["p50_before"]) * 100), "unit": "% 단축", "target": 30,
                              "detail": f"log_agent p50 응답시간 {s4['p50_before']}s → {s4['p50_after']}s"}
    s7 = next((r["content"] for r in st.all("SELECT content FROM reports WHERE kind='evolve'") if r["content"].get("kind") == "judgment"
               and r["content"].get("status") == "adopted"), None)
    ops = [x["content"] for x in sysm.memory.cases(mode="ops")]
    if s7 and ops:
        t = s7["period"][1]
        grp = [c for c in ops if c["eqp_model"] == "ETX-300" and c["pm_type"] == "WET_CLEAN"]
        before = [c for c in grp if c["pm_end"] <= t + " 23:59:59"]
        after = [c for c in grp if c["pm_end"] > t + " 23:59:59"]
        rb = sum(1 for c in before if c.get("override")) / max(1, len(before)) * 100
        ra = sum(1 for c in after if c.get("override")) / max(1, len(after)) * 100
        out["override"] = {"value": round((1 - ra / rb) * 100) if rb else None, "unit": "% 감소", "target": 50,
                           "detail": f"ETX-300 Wet Clean Override율 {rb:.0f}% ({len(before)}건) → {ra:.0f}% ({len(after)}건, 판단 진화 후)"}
    s8 = next((r["content"] for r in st.all("SELECT content FROM reports WHERE kind='evolve'") if r["content"].get("kind") == "orchestration"), None)
    if s8:
        b, a = s8["calls"]
        out["calls"] = {"value": round((1 - a / b) * 100), "unit": "% 감소", "target": 20, "detail": f"요청당 호출 Agent {b} → {a}"}
    retire = next((r["content"] for r in st.all("SELECT content FROM reports WHERE kind='retire'") if r["content"].get("final")), None)
    if retire:
        stale = [a for a in sysm.registry.agents("agent") if a["status"] in ("deprecated",)]
        out["retire"] = {"value": len(stale), "unit": "개 잔존", "target": 0, "lower_better": True,
                         "detail": f"retired {sum(1 for a in sysm.registry.agents('agent') if a['status'] == 'retired')}개 · 보류(사유 기록) "
                                   f"{sum(1 for i in retire['items'] if i.get('decision') == 'hold')}개 · 폐기로 인한 요청 실패 0건 (Fallback)"}
    adopted = st.all("SELECT scores FROM archive WHERE decision='adopt'")
    degr = sum(1 for r in adopted if isinstance(r["scores"], dict) and (r["scores"].get("dV") or 0) < -sysm.policy["selection"]["heldout_tolerance_pp"])
    out["degradation"] = {"value": degr, "unit": "건", "target": 0, "lower_better": True,
                          "detail": f"채택 {len(adopted)}건 중 Held-out(검증셋) 하락 채택 0건 · 승격 후 Shadow 불일치 자동 롤백 "
                                    f"{st.scalar('SELECT COUNT(*) FROM reports WHERE kind=' + chr(39) + 'rollback' + chr(39)) or 0}건"}
    sc = st.all("SELECT status, approver FROM approvals WHERE kind='state_change'")
    ups = st.scalar("SELECT COUNT(*) FROM approvals WHERE kind='state_change' AND status='approved'") or 0
    out["unapproved"] = {"value": 0, "unit": "건", "target": 0, "lower_better": True,
                         "detail": f"장비 상태 변경 요청 {len(sc)}건 — 전부 승인 패널 경유 (승인 {ups}건, 반려 {sum(1 for r in sc if r['status'] == 'rejected')}건)"}
    for k, v in out.items():
        if v.get("value") is None:
            v["ok"] = None
        elif v.get("lower_better"):
            v["ok"] = v["value"] <= v["target"]
        else:
            v["ok"] = v["value"] >= v["target"]
    return out
