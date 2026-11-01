"""Autopilot 스토리 — 시나리오 타임라인(SC-006 → SC-009)을 실제 메커니즘으로 순서대로 실행.

각 챕터는 가상 시각을 진행시키며 배경 운영(가상 엔지니어 요청)을 흘려보내고, 시나리오 사건(요청·장애 주입·야간 진화)을 일으킨다.
사람 승인 지점(장비 Up·정식 승격·진화안 채택·폐기)은 승인 패널에서 멈춘다(설정 시 데모 운영자 자동 승인).
챕터 종료마다 체크포인트를 저장해 원하는 챕터로 바로 이동할 수 있다.
"""
from __future__ import annotations

import threading
import time
import traceback
from datetime import datetime, timedelta

from langgraph.types import Command

from mock_env import config as C

from .events import StoryStopped
from .loops.l3_ops import OpsEvolver
from .loops.replay import ReplayEngine
from .ops import OpsSimulator, RequestRunner
from .tools import P, RunContext, S

D = datetime

# 챕터별 업무 상황 — 화면에서 "이 장면이 현장의 어떤 일인지"를 설명하는 문장 (UI 시나리오 패널·챕터 안내에 표시)
CHAPTER_BIZ = {
    "ch00": "개발자가 만든 기본 Agent 4종으로 출발합니다. 엔지니어가 직접 오가던 세 시스템(기준정보·FDC 로그·레거시 Qual DB)을 Agent 하나씩 맡고, "
            "Super Agent가 이들을 지휘합니다. 여기서부터 Agent가 스스로 늘고, 고치고, 진화합니다.",
    "ch01": "운영 투입 전, 레거시 DB에 쌓인 3년치 Qual 이력 3,000건을 시간순으로 다시 풀어 봅니다. 당시 판단과 실제 결과를 채점하며 숙련자 머릿속에만 있던 "
            "Seasoning 노하우를 교훈(Lesson)으로 뽑아냅니다. 그 시점 이후 데이터는 Time-Travel Guard가 막아 '미래를 보고 맞히는' 일이 없습니다.",
    "ch02": "ETCH-07 B챔버 Wet Clean PM이 끝나 장비가 멈춰 있습니다. 엔지니어가 Spec 조회·FDC 확인·과거 이력 조회에 1.5~2시간 쓰던 준비를 요청 한 줄로 대신하고, "
            "Seasoning 웨이퍼를 몇 장 돌릴지 근거와 함께 추천합니다. 측정 → 결정적 코드 판정 → 사람 승인을 거쳐 장비가 생산에 복귀합니다.",
    "ch03": "'Qual Fail이 교체 부품 사용시간과 관계있나?' — 기존 기능에 없는 질문입니다. 예전이면 IT 개발 요청 후 수 주를 기다리며 엑셀로 수작업했을 일을, "
            "Agent Factory가 새 Agent(부품이력)를 코드로 직접 만들어 수 분 안에 답합니다.",
    "ch04": "장비 SW가 v5.2로 업데이트되며 로그 포맷이 바뀌었습니다. 기존 자동화라면 조용히 멈추거나, 더 나쁘게는 틀린 값을 냈을 상황입니다. "
            "Agent는 추측하지 않고 '확인 불가'로 답한 뒤 자기 파서 코드를 직접 고치고, 같은 문제를 가진 다른 Agent까지 연쇄 복구합니다.",
    "ch05": "엔지니어가 특정 부품 Lot이 어느 챔버에 장착됐는지 한 번 묻습니다. Agent가 새로 만들어져 답하지만 이후로는 쓰이지 않아, 나중에 SC-009에서 폐기 대상이 됩니다.",
    "ch06": "시험 운영(probation) 기간 동안 문제없이 쓰인 부품이력 Agent를 운영자가 검토해 정식 승격합니다. Agent가 만든 기능도 사람 승인 없이는 정식이 되지 않습니다.",
    "ch07": "운영 한 달 동안 엔지니어가 Agent 추천 매수를 바꾼 기록(Override)과 실제 Qual 결과가 쌓였습니다. 결과로 뒷받침된 수정만 골라 학습해, "
            "Focus Ring 사용시간까지 반영하도록 판단 로직을 새 버전으로 진화시킵니다.",
    "ch08": "Agent가 늘면서 같은 FDC 파싱 코드가 여러 곳에 중복되고 응답이 느려졌습니다. 공용 스킬 추출·병합·캐시안을 평가 하네스로 채점하고, "
            "Shadow로 24시간 병행 검증한 뒤에만 운영에 올립니다.",
    "ch09": "레거시 DB 이관 때 일부 기간 데이터가 아예 적재되지 않았습니다. 고칠 수 없는 문제에 예산을 낭비하지 않고 조기 중단해 사람에게 넘기고, "
            "승격 후 Shadow 결과가 어긋나면 관련 Agent를 한꺼번에 이전 버전으로 되돌립니다.",
    "ch10": "Super Agent 자신도 진화합니다. 결과에 기여하지 않던 Agent 호출을 줄이고, 자주 쓰는 편성을 템플릿으로 만들어 같은 일을 더 빠르고 싸게 처리합니다.",
    "ch11": "한 번 만든 기능이 쌓이기만 하면 유지보수 비용이 계속 늘어납니다. 쓰이지 않거나 다른 Agent로 대체된 Agent를 의존성 분석 → 대체 검증 → 폐기 유예 → "
            "사람 승인 → 아카이브 보관 순서로 안전하게 정리합니다.",
}


class Story:
    def __init__(self, sysm):
        self.sys = sysm
        self.runner = RequestRunner(sysm)
        self.sim = OpsSimulator(sysm, self.runner)
        self.ops = OpsEvolver(sysm)
        self.thread: threading.Thread | None = None
        self.running = False
        self.current = None
        self.chapters = [
            ("ch00", "초기 구축", "2026-07-01", "사람이 작성한 베이스라인: super·spec·log·legacy 1.0.0 + 공용 스킬 2종", self.ch_boot),
            ("ch01", "SC-006 이력 리플레이 사전 진화", "2026-08", "3년치 Qual 이력 3,000건을 시간순 재생 — Walk-forward 진화, Time-Travel Guard", self.ch_replay),
            ("ch02", "SC-001 PM 후 AutoQual", "2026-09-03", "요청 한 줄 → Jev 편성 → CodeAct 계획 → 판정 → 사람 승인 Up", self.ch_sc001),
            ("ch03", "SC-002 처음 보는 요청 → Grow", "2026-09-10", "부품 사용시간 분석 — Agent Factory가 part_history_agent 생성", self.ch_sc002),
            ("ch04", "SC-003 로그 포맷 변경 → Heal", "2026-09-17", "장비 SW v5.2 — 확인 불가 응답 후 자기 코드 패치·연쇄 복구", self.ch_sc003),
            ("ch05", "일회성 Lot 추적 → Grow", "2026-09-22", "lot_trace_agent 생성 (이후 미사용 → SC-009 폐기 대상)", self.ch_lot),
            ("ch06", "운영자 승격 승인", "2026-09-24", "part_history_agent 0.1.0 → 1.0.0", self.ch_promote),
            ("ch07", "SC-007 운영 결과 기반 판단 진화", "2026-10-20", "Override·실제 결과 학습 → Focus Ring 보정 (spec_agent 새 버전)", self.ch_sc007),
            ("ch08", "SC-004 구조 진화 (중복·성능)", "2026-11-12", "fdc_toolkit 추출·병합 기각·캐시 → Shadow 24h → 승격", self.ch_sc004),
            ("ch09", "SC-005 복구 불가 중단 + 자동 롤백", "2026-11-14", "레거시 이관 미적재 Heal 조기 중단 / Shadow 불일치 원자적 롤백", self.ch_sc005),
            ("ch10", "SC-008 편성 전략 진화", "2026-12-01", "불필요 호출 제거·템플릿 승격·임계값 재조정 (super_agent)", self.ch_sc008),
            ("ch11", "SC-009 병합·불필요 Agent 폐기", "2026-12-08", "아카이브 병합안 재도전 → Retire(유예·Fallback·승인·아카이브)", self.ch_sc009),
        ]
        sysm.on("heal_reanswer", self.on_heal_reanswer)
        sysm.on("redirect_failed", self.on_redirect_failed)
        self._redirect_heal = set()

    # ── 공통 ───────────────────────────────────────────────────────
    def say(self, text, chapter=None, level="info", **kw):
        self.sys.bus.emit("story", text=text, chapter=chapter or self.current, level=level, **kw)

    def wait_approval(self, apr: dict, auto_note: str = "") -> dict:
        rid = apr["request_id"]
        if (self.sys.store.kv_get("approval_mode", "manual")) == "auto":
            self.sys.bus.emit("approval_countdown", request_id=rid, seconds=round(self.sys.bus.scaled(4.0)))
            self.sys.bus.pace(4.0)
            row = self.sys.store.one("SELECT * FROM approvals WHERE request_id=?", (rid,))
            if row["status"] == "pending":
                self.sys.approvals.decide(rid, True, "운영자(데모 자동 승인)", auto_note or "검토 완료")
        row = self.sys.approvals.wait(rid)
        if row is None or row["status"] == "pending":
            raise StoryStopped()
        return row

    def background(self, until: datetime, label: str):
        start = self.sys.clock.now()
        if until <= start:
            self.sys.clock.set(until)
            return 0
        self.say(f"⏩ 배경 운영 {start:%m-%d %H:%M} → {until:%m-%d %H:%M}: 가상 엔지니어 요청을 Agent가 자율 처리 ({label})", level="ops")
        n = self.sim.run_between(start, until, label=label)
        self.say(f"배경 운영 {n}건 자동 처리 완료", level="ops")
        return n

    def status(self) -> dict:
        st = self.sys.store.kv_get("story", {}) or {}
        return {"chapters": [{"id": c[0], "title": c[1], "date": c[2], "desc": c[3], "biz": CHAPTER_BIZ.get(c[0], ""),
                              "done": c[0] in (st.get("done") or []), "checkpoint": self.sys.has_checkpoint(c[0])} for c in self.chapters],
                "current": self.current, "running": self.running, **st}

    def _mark_done(self, cid):
        st = self.sys.store.kv_get("story", {}) or {}
        done = list(st.get("done") or [])
        if cid not in done:
            done.append(cid)
        st["done"] = done
        st["last"] = cid
        self.sys.store.kv_set("story", st)

    # ── 실행 제어 ──────────────────────────────────────────────────
    def start(self, from_id: str | None = None, to_id: str | None = None):
        if self.running:
            return False
        self.sys.bus.stop_flag = False
        done = (self.sys.store.kv_get("story", {}) or {}).get("done") or []
        if from_id is None and len(done) >= len(self.chapters):
            self.jump("ch00")              # 전 챕터 완료 상태 → 처음부터 다시
            from_id = "ch00"
        self.thread = threading.Thread(target=self._run, args=(from_id, to_id), daemon=True, name="story")
        self.thread.start()
        return True

    def _run(self, from_id, to_id):
        self.running = True
        ids = [c[0] for c in self.chapters]
        st = self.sys.store.kv_get("story", {}) or {}
        done = st.get("done") or []
        start = ids.index(from_id) if from_id else (ids.index(done[-1]) + 1 if done else 0)
        end = ids.index(to_id) if to_id else len(ids) - 1
        try:
            for i in range(start, end + 1):
                cid, title, date, desc, fn = self.chapters[i]
                self.current = cid
                self.sys.bus.emit("chapter", id=cid, title=title, date=date, desc=desc, biz=CHAPTER_BIZ.get(cid, ""), phase="start")
                fn()
                self.sys.flush()
                self._mark_done(cid)
                self.sys.checkpoint(cid)
                self.sys.bus.emit("chapter", id=cid, title=title, date=date, phase="done")
                self.sys.bus.emit("kpi", **self.sys.kpi())
            if end == len(ids) - 1:
                self.say("🎬 타임라인 완료 — 모든 시나리오(SC-001 ~ SC-009)를 Agent가 스스로 수행했습니다.", level="done")
        except StoryStopped:
            self.say("⏸ Autopilot 중단", level="warn")
        except Exception as e:  # noqa: BLE001
            self.say(f"스토리 오류: {e}", level="error")
            self.sys.bus.emit("toast", level="error", text=traceback.format_exc()[-600:])
        finally:
            self.running = False
            self.current = None

    def stop(self):
        self.sys.bus.stop_flag = True
        self.sys.bus.paused.set()

    # ── 시연 — 시나리오 하나를 질문·사건 단위 단계로 진행 ─────────────────
    #   1단계는 매번 시작 직전 체크포인트로 복원(같은 결과 재현), 이후 단계는 이어서 진행.
    #   필요한 체크포인트(ch02·ch03·ch06·ch10)는 prepare_demos()가 최대 속도 완주로 만든다.
    def demos(self):
        return {
            "grow": ("ch03", [self._d_grow_ask, self._d_grow_again]),
            "heal": ("ch04", [self._d_heal_fault, self._d_heal_ask]),
            "evolve": ("ch07", [self._d_evo_ops, self._d_evo_night, self._d_evo_ask]),
            "retire": ("ch11", [self._d_ret_run, self._d_ret_again]),
        }

    def demo_ready(self) -> dict:
        ids = [c[0] for c in self.chapters]
        return {k: self.sys.has_checkpoint(ids[ids.index(ch) - 1]) for k, (ch, _) in self.demos().items()}

    def _roster(self):
        return [{"agent_id": a["agent_id"], "kind": a["kind"], "version": a["active_version"], "status": a["status"]}
                for a in self.sys.registry.snapshot()["agents"]]

    def run_demo(self, demo_id: str, step: int) -> bool:
        ch, steps = self.demos()[demo_id]
        if self.running or not (0 <= step < len(steps)):
            return False
        if step == 0:
            mode = self.sys.store.kv_get("approval_mode", "manual")
            if not self.jump(ch):
                return False
            self.sys.store.kv_set("approval_mode", mode)   # 체크포인트(준비 때 자동 승인)가 아니라 지금 설정을 유지
        self.running = True
        self.current = f"demo:{demo_id}"
        self.sys.bus.stop_flag = False

        def go():
            try:
                if step == 0:
                    self.sys.bus.emit("demo", id=demo_id, step=0, phase="baseline", roster=self._roster(), clock=S(self.sys.clock.now()))
                self.sys.bus.emit("demo", id=demo_id, step=step, phase="start")
                steps[step]()
                self.sys.flush()
                self.sys.bus.emit("demo", id=demo_id, step=step, phase="done", roster=self._roster())
            except StoryStopped:
                self.sys.bus.emit("demo", id=demo_id, step=step, phase="stopped")
            except Exception as e:  # noqa: BLE001
                self.sys.bus.emit("demo", id=demo_id, step=step, phase="error", error=str(e))
                self.sys.bus.emit("toast", level="error", text=traceback.format_exc()[-600:])
            finally:
                self.running = False
                self.current = None
        self.thread = threading.Thread(target=go, daemon=True, name="demo")
        self.thread.start()
        return True

    def prepare_demos(self) -> bool:
        """시연 준비 — 초기 상태부터 SC-008까지 최대 속도·자동 승인으로 완주해 체크포인트를 만든 뒤 설정을 되돌린다."""
        if self.running:
            return False
        bus, kv = self.sys.bus, self.sys.store
        speed, mode = bus.speed, kv.kv_get("approval_mode", "manual")

        def go():
            try:
                bus.speed = 0
                self.jump("ch00")                      # 저장소 초기화 — 승인 모드도 지워지므로 그 뒤에 설정
                kv.kv_set("approval_mode", "auto")
                bus.emit("demo", id="prepare", step=0, phase="start")
                self._run("ch00", "ch10")
                bus.emit("demo", id="prepare", step=0, phase="done", ready=self.demo_ready())
            finally:
                bus.speed = speed
                kv.kv_set("approval_mode", mode)
                self.running = False
        bus.stop_flag = False
        self.running = True
        self.thread = threading.Thread(target=go, daemon=True, name="demo-prepare")
        self.thread.start()
        return True

    def _d_grow_ask(self):
        self.sys.clock.set(D(2026, 9, 10, 10, 30))
        self.say("공정 담당자의 질문: 기존 기능(기준정보·로그·이력)으로는 답할 수 없는 분석입니다.")
        self.runner.submit("지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘", source="user")

    def _d_grow_again(self):
        self.sys.clock.set(D(2026, 9, 10, 15, 0))
        self.say("다른 엔지니어가 비슷한 질문을 합니다 — 이번에는 새로 만들지 않고 방금 추가된 기능을 바로 씁니다.")
        self.runner.submit("지난 분기 ETCH 장비 Qual Fail이랑 Focus Ring 사용시간 관계 다시 분석해줘", source="user")

    def _d_heal_fault(self):
        self.sys.clock.set(D(2026, 9, 17, 10, 32))
        f = self.sys.world.inject_fault("sw_v52", list(C.V52_EQPS), {"from": "2026-09-17 00:00:00", "tz": {"CVD-12": "", "CVD-03": "+09:00", "CVD-08": "+09:00"}},
                                        ts=self.sys.clock.now())
        self.sys.bus.emit("fault", fault_id=f["fault_id"], type="sw_v52", target=list(C.V52_EQPS),
                          text="장비 SW v5.2 업데이트 (CVD-03·08·12) — FDC 로그 컬럼 7개 변경, 시간 형식 YYYYMMDDhhmmss → ISO8601")
        self.say("현장 변화: CVD 장비 3대의 SW가 업데이트되어 로그 형식이 바뀌었습니다. 아무도 코드를 고치지 않은 상태입니다.")

    def _d_heal_ask(self):
        self.sys.clock.set(D(2026, 9, 17, 10, 40))
        self.say("SW가 바뀐 CVD-12에서 AutoQual 요청이 들어옵니다.")
        self.runner.submit("CVD-12 A챔버 RF Generator 교체했어. AutoQual 해줘", source="user", meas_delay=1.0, heal_wait=True)

    def _d_evo_ops(self):
        self.say("한 달 운영: 엔지니어들이 추천 매수를 바꾼 기록(Override)과 실제 Qual 결과가 쌓입니다.")
        self.background(D(2026, 10, 20, 1, 0), "운영 4~7주차")
        ops = [x["content"] for x in self.sys.memory.cases(mode="ops")]
        grp = [c for c in ops if c["eqp_model"] == "ETX-300" and c["pm_type"] == "WET_CLEAN"]
        ov = sum(1 for c in grp if c.get("override"))
        self.say(f"ETX-300 Wet Clean {len(grp)}건 중 엔지니어 Override {ov}건 — 추천이 현장 판단과 자주 어긋납니다.", level="warn")

    def _d_evo_night(self):
        self._sc007_evolve()

    def _d_evo_ask(self):
        self._sc007_followup()

    def _d_ret_run(self):
        self.ch_sc009()

    def _d_ret_again(self):
        self.sys.clock.set(self.sys.clock.now() + timedelta(days=1))
        self.say("정리된 기능이 다시 필요해졌습니다 — 새로 만들기 전에 보관함(아카이브)에서 먼저 찾습니다.")
        self.runner.submit("FRL-2408-117 Lot Focus Ring 장착된 챔버 다시 추적해줘", source="user")

    def jump(self, cid: str) -> bool:
        """해당 챕터 직전 체크포인트로 복원 (이후 start 로 그 챕터부터 실행)."""
        ids = [c[0] for c in self.chapters]
        i = ids.index(cid)
        if i == 0:
            self.sys.reset()
            self.sys.store.kv_set("story", {"done": []})
            return True
        prev = ids[i - 1]
        if not self.sys.has_checkpoint(prev):
            return False
        self.sys.restore(prev)
        st = self.sys.store.kv_get("story", {}) or {}
        st["done"] = ids[:i]
        self.sys.store.kv_set("story", st)
        return True

    # ── 훅 ─────────────────────────────────────────────────────────
    def on_heal_reanswer(self, heal: dict):
        """Heal 완료 → '확인 불가' 항목 재분석 결과를 추가 응답으로 전달하고 진행 중 스레드의 계획을 갱신."""
        if heal.get("replay") or heal.get("status") != "healed":
            return
        for pnd in heal["pending"]:
            rid, tid = pnd.get("request_id"), pnd.get("thread_id")
            if not rid or not pnd.get("inputs"):
                continue
            row = self.sys.store.one("SELECT thread_id, source FROM requests WHERE request_id=?", (rid,)) or {}
            if not tid:
                tid = row.get("thread_id")
            sim = row.get("source") == "sim"          # 배경(가상 엔지니어) 요청의 재응답은 UI 이벤트를 내지 않는다 (요청 자체가 muted)
            ctx = RunContext(self.sys, mode="ops", request_id=rid, quiet=sim)
            r = self.sys.runtime.run_agent(ctx, heal["agent_id"], pnd["action"], dict(pnd["inputs"]))
            if not r["ok"]:
                continue
            out = r["output"]
            from .loops.l1 import _ind_txt
            lines = [_ind_txt(i, []) for i in out.get("indicators", []) if i["name"] not in ("RF_STABLE_AT",)]
            note = ""
            cfg = {"configurable": {"thread_id": tid}}
            try:
                st = self.sys.l1.ops.get_state(cfg).values
                for _ in range(50):
                    st = self.sys.l1.ops.get_state(cfg).values
                    if st.get("synth"):
                        break
                    time.sleep(0.1)
                if st and st.get("synth", {}).get("recommendation") and heal["agent_id"] == "log_agent":
                    spec = (st["exec"]["result"] or {}).get("spec") or {}
                    sig = dict(out.get("signals") or {})
                    sig["month"] = int(pnd["inputs"]["pm_end"][5:7])
                    rec = self.sys.runtime.run_agent(ctx, "spec_agent", "recommend", dict(pnd["inputs"], eqp_model=spec.get("eqp_model"),
                                                                                          seasoning=spec.get("seasoning"), signals=sig))
                    if rec["ok"]:
                        old = st["synth"]["recommendation"]["count"]
                        new = rec["output"]["count"]
                        note = f"→ Seasoning {'기본 매수 유지' if new == old else f'{old}매 → {new}매 수정'} 권장 ({new}매)"
                        syn = dict(st["synth"])
                        syn["recommendation"] = dict(syn["recommendation"], count=new, required_est=rec["output"]["required_est"],
                                                     signals=rec["output"].get("signals_used", {}))
                        exe = dict(st["exec"])
                        res = dict(exe["result"])
                        res["log"] = out
                        exe["result"] = res
                        self.sys.l1.ops.update_state(cfg, {"synth": syn, "exec": exe})
            except Exception as e:  # noqa: BLE001
                self.sys.bus.emit("toast", level="error", text=f"재응답 계획 갱신 실패: {e!r}"[:200])
            if sim:
                continue
            self.sys.bus.emit("response", request_id=rid, thread_id=tid, rtype="reanswer",
                              blocks=[{"kind": "chamber", "title": f"추가 응답 — {heal['heal_id']} 복구 후 재분석 · {heal['agent_id']} {heal.get('new_version')}",
                                       "lines": lines + ([note] if note else [])}], text="\n".join(lines))

    def on_redirect_failed(self, agent_id, replacement, inputs, ctx, result):
        """유예 중 대체 Agent 실패 → 원 Agent Fallback 응답(런타임) + 대체 Agent Heal → 대체 검증 재수행 → 유예 재시작."""
        key = (agent_id, replacement, inputs.get("eqp_group"))
        if key in self._redirect_heal:
            return
        self._redirect_heal.add(key)
        self.say(f"유예 중 리다이렉트 실패: {replacement} — {((result.get('violations') or [{}])[0]).get('message', '')} → deprecated {agent_id}로 Fallback 응답 (사용자 영향 없음)",
                 level="warn")
        v = (result.get("violations") or [{}])[0]
        run = {"agent_id": replacement, "version": result.get("version"), "action": "trend", "error": None,
               "violations": [dict(v, type="Unsupported")], "signature": f"Unsupported:{replacement}:CYCLE_RF_HOURS"}
        state = {"request": {"request_id": ctx.request_id}, "exec": {"req": dict(inputs)}}
        self._pending_redirect = (agent_id, replacement)
        self.sys.healer.trigger(run, state, ctx)

    # ════════════════════════════════════════════════════════════════
    # 챕터
    # ════════════════════════════════════════════════════════════════
    def ch_boot(self):
        if self.sys.registry.agent("super_agent") and self.sys.registry.agent("super_agent")["active_version"] != "1.0.0":
            self.sys.reset()
        self.sys.clock.set(D(2026, 7, 1, 9, 0))
        self.say("초기 구축 (2026-07): 사람이 작성한 베이스라인 Agent 4종과 공용 스킬 2종으로 시작합니다.")
        for a in self.sys.registry.agents(None):
            self.sys.bus.emit("registry", agent_id=a["agent_id"], event="baseline", status=a["status"], note=f"{a['active_version']} 초기 구축")
            self.sys.bus.pace(0.25)
        self.say("Mock Fab: 장비 30대 · 챔버 90개 · PM 8종 · 레거시 Qual 이력 3,000건(2023-07 ~ 2026-06) · 장비 SW 버전별 로그 포맷 3종")

    def ch_replay(self):
        self.sys.clock.set(D(2026, 8, 3, 9, 0))
        self.say("[리플레이 진화 설정] 대상: 전 장비군(ETCH·CVD·PVD) Qual 이력 3,000건 · 진화 기간 2023-07~2025-12(10개 분기) · "
                 "Held-out 2026-01~06 · Time-Travel Guard ON · 시작 버전 전 Agent 1.0.0")
        rep = ReplayEngine(self.sys).run(spotlight_every=110)
        f = rep["final"]
        self.say(f"[Held-out 최종 평가 — 2026 상반기 {f['n']}건] 판정 일치율 {f['before']['accuracy']:.0f}% → {f['after']['accuracy']:.0f}% · "
                 f"1차 Pass 예측 {f['before']['pred_acc']:.0f}% → {f['after']['pred_acc']:.0f}% · 미래 정보 누출 {f['leaks']}건 "
                 f"(Guard 차단·필터 {f['guard_blocked']:,}건)", level="done")
        self.sys.clock.set(D(2026, 8, 31, 18, 0))
        ct = self.sys.registry.agent("chamber_trend_agent")
        if ct and ct["status"] == "probation":
            apr = self.ops.request_promotion("chamber_trend_agent", "리플레이 중 Grow → 진화된 probation Agent, 운영 투입 승인 대상")
            self.say(f"운영 투입 승인 요청: {apr['title']} (승인 패널)", level="approval")
            row = self.wait_approval(apr, "리플레이 진화 리포트 검토 후 운영 투입 승인")
            if row["status"] == "approved":
                self.sys.clock.set(D(2026, 9, 1, 8, 0))
                ch = self.ops.promote("chamber_trend_agent", row["approver"], apr["request_id"])
                self.say(f"운영 투입 승인 — chamber_trend_agent {ch['from']} → {ch['to']}", level="done")
        self.sys.clock.set(D(2026, 9, 1, 8, 0))

    def ch_sc001(self):
        self.background(D(2026, 9, 3, 9, 50), "운영 1~3일차")
        self.sys.clock.set(D(2026, 9, 3, 9, 52))
        self.say("SC-001: 설비 엔지니어가 ETCH-07 B챔버 Wet Clean PM을 마치고 AutoQual을 요청합니다.")
        fixed = {"PARTICLE": (9, "ea"), "ER": (1872.0, "A/min"), "ER_UNIF": (2.1, "%"), "LEAK_RATE": (0.8, "mTorr/min")}
        self.runner.submit("ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘", source="user", fixed_meas=fixed, meas_delay=2.5)

    def ch_sc002(self):
        self.background(D(2026, 9, 10, 10, 20), "운영 1주차")
        self.sys.clock.set(D(2026, 9, 10, 10, 30))
        self.say("SC-002: 공정 담당자가 기존 Agent 능력 밖의 분석을 요청합니다 (레거시 PRT_CHG_HIS는 아직 아무도 읽은 적 없음).")
        job = self.runner.submit("지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘", source="user")
        out = job.get("final") or {}
        res = ((out.get("exec") or {}).get("result") or {}).get("analysis") or {}
        if res.get("status") == "ok":
            b = res["buckets"]
            ratio = (b[-1]["rate"] or 0) / max(0.01, b[0]["rate"] or 0.01)
            hid = self.sys.memory.record("hypothesis", {"text": f"Focus Ring 600h 초과 시 1차 Fail 위험 {ratio:.1f}배", "buckets": b,
                                                        "source": "part_history_agent 0.1.0 (probation)", "status": "검증 대기"},
                                         self.sys.clock.now(), eqp_model="ETX-300", pm_type="WET_CLEAN", status="open")
            self.say(f"결과는 가설 {hid}로 경험 메모리에 등록 — 실제 Qual 결과로 검증 예정 (SC-007)")
            self.sys.store.kv_set("hyp_part", hid)
        apr = self.ops.request_promotion("part_history_agent", "신규 생성 Agent 처리 결과 — 성공 누적 후 정식 승격 검토")
        self.sys.store.kv_set("promotion_part_history", apr["request_id"])
        self.say(f"운영자에게 승격 검토 요청: {apr['title']} (2주 운영 후 결정)", level="approval")

    def ch_sc003(self):
        self.background(D(2026, 9, 17, 10, 25), "운영 2주차")
        self.sys.clock.set(D(2026, 9, 17, 10, 32))
        f = self.sys.world.inject_fault("sw_v52", list(C.V52_EQPS), {"from": "2026-09-17 00:00:00", "tz": {"CVD-12": "", "CVD-03": "+09:00", "CVD-08": "+09:00"}},
                                        ts=self.sys.clock.now())
        self.sys.bus.emit("fault", fault_id=f["fault_id"], type="sw_v52", target=list(C.V52_EQPS),
                          text="장애 주입기: 장비 SW v5.2 업데이트 (CVD-03·08·12) — FDC 로그 컬럼 7개 변경, 시간 YYYYMMDDhhmmss → ISO8601")
        self.say("SC-003: 장비 SW 업데이트로 FDC 로그 포맷이 바뀐 CVD-12에서 AutoQual 요청이 들어옵니다.")
        self.runner.submit("CVD-12 A챔버 RF Generator 교체했어. AutoQual 해줘", source="user", meas_delay=1.0, heal_wait=True)

    def ch_lot(self):
        # SC-003 엣지: 에러 없는 오판 — 단위 변경(mTorr → Torr)으로 파싱은 성공하지만 Leak Rate가 1/1,000로 읽힘
        evs = [t for t, row in self.sys.world.events_between(D(2026, 9, 18, 9, 0), D(2026, 9, 21, 23, 0), splits=["ops"])
               if t.group == "ETCH" and not row.get("TAG")]
        if evs:
            t = evs[0]
            self.background(t.pm_end - timedelta(minutes=1), "운영 3주차")
            cid = f"{t.eqp_id}-{t.chamber}"
            f = self.sys.world.inject_fault("leak_unit_torr", [cid], {}, ts=self.sys.clock.now())
            self.sys.bus.emit("fault", fault_id=f["fault_id"], type="leak_unit_torr", target=[cid],
                              text=f"장애 주입기: {cid} Leak Check 로그 단위 변경 mTorr/min → Torr/min (값 1/1,000 — 파싱은 성공)")
            self.sys.clock.set(t.pm_end + timedelta(minutes=8))
            self.say(f"SC-003 엣지 케이스: {cid}의 Leak 로그 단위가 바뀌어 '에러 없는 오판' 위험 — 사후 검증이 잡아내는지 확인합니다.")
            self.runner.submit(f"{t.eqp_id} {t.chamber}챔버 {C.PM_TYPES[t.pm_type]['name']} PM 끝났어. AutoQual 진행해줘", source="user", heal_wait=True)
        self.background(D(2026, 9, 22, 13, 50), "운영 3주차")
        self.sys.clock.set(D(2026, 9, 22, 14, 0))
        self.say("일회성 요청: 특정 Focus Ring Lot이 장착된 챔버 추적 → 기존 Agent로 불가 → Grow")
        self.runner.submit("FRL-2408-117 Lot Focus Ring 장착된 챔버 추적해줘", source="user")

    def ch_promote(self):
        self.background(D(2026, 9, 24, 9, 0), "운영 3주차")
        self.sys.clock.set(D(2026, 9, 24, 9, 30))
        for d in ((9, 24, 10), (9, 25, 15)):
            self.sys.clock.set(D(2026, d[0], d[1], d[2], 0))
            with self.sys.bus.muted():
                self.runner.submit("FRL-2408-117 Lot Focus Ring 장착 챔버 다시 추적해줘", source="sim", sim={"engineer": "E118", "lead": "E124"})
        self.sys.clock.set(D(2026, 9, 24, 17, 0))
        rid = self.sys.store.kv_get("promotion_part_history")
        a = self.sys.registry.agent("part_history_agent")
        self.say(f"part_history_agent 2주 운영: 직접 호출 {a['direct_calls']}건, 실패 0건 — 운영자 승격 승인 대기")
        row = self.wait_approval({"request_id": rid}, "probation 운영 성공 누적 확인")
        if row["status"] == "approved":
            ch = self.ops.promote("part_history_agent", row["approver"], rid)
            self.say(f"정식 승격: part_history_agent {ch['from']} → {ch['to']} — 이후 Jev 편성 후보에 자동 포함", level="done")

    def ch_sc007(self):
        self.background(D(2026, 10, 20, 1, 0), "운영 4~7주차")
        if self._sc007_evolve():
            self._sc007_followup()

    def _sc007_evolve(self) -> bool:
        self.sys.clock.set(D(2026, 10, 20, 2, 0))
        run_id = self.sys.store.next_id("E-", 2)
        self.say(f"SC-007 [L3 Evolve 야간] 운영 7주간 경험 메모리 분석 — 판단 진화 #{run_id}")
        out = self.ops.judgment_evolve(D(2026, 9, 1), D(2026, 10, 19, 23, 59), run_id)
        if not out.get("best"):
            self.say("채택 후보 없음 — 아카이브 보관", level="warn")
            return False
        self.sys.clock.set(D(2026, 10, 21, 9, 30))
        row = self.wait_approval(out["approval"], "백테스트 결과 검토 — Focus Ring 구간 보정 채택")
        if row["status"] != "approved":
            self.say("운영자 반려 — 진화안 hold 보관, 반려 사유를 다음 진화 재료로 기록", level="warn")
            return False
        ch, new = self.ops.adopt_judgment(out, row["approver"])
        self.say(f"반영: " + ", ".join(f"{c['agent_id']} {c['from']} → {c['to']}" for c in ch) + f" · 교훈 등록 {', '.join(new)} · 가설 검증 완료 · 미해결 군집 해소",
                 level="done")
        cfg = self.sys.evolver.active_config()
        cfg["lessons"] = self.sys.evolver.as_overlay([x["content"] for x in cfg["lessons"]])
        ho = self.sys.harness.evaluate(cfg, self.ops.heldout_cases(), "after-sc007")
        self.sys.store.kv_set("kpi_fp_after", ho["first_pass_rate"])
        self.sys.store.kv_set("kpi_after_sc007", {k: ho[k] for k in ("accuracy", "first_pass_rate", "wafer_usage", "rec_error")})
        return True

    def _sc007_followup(self):
        self.background(D(2026, 10, 22, 13, 20), "판단 진화 후")
        self.sys.clock.set(D(2026, 10, 22, 13, 30))
        self.say("다음 요청: 진화된 로직이 어떤 경험에서 바뀌었는지 근거와 함께 추천합니다.")
        self.runner.submit("ETCH-05 A챔버 Wet Clean PM 끝났어. AutoQual 진행해줘", source="user")

    def ch_sc004(self):
        self.background(D(2026, 11, 12, 1, 30), "운영 8~10주차")
        self.sys.clock.set(D(2026, 11, 12, 2, 0))
        run_id = self.sys.store.next_id("V-", 2)
        self.say(f"SC-004 [L3 Evolve 야간 02:00] Registry 지표 수집 — 구조 진화 #{run_id}")
        out = self.ops.structure_evolve(run_id)
        self.ops.start_shadow(out["shadow"], "pre")
        self.say("채택안 Shadow 운영 24h 시작 (신·구 버전 결과 비교)")
        t0 = self.sys.clock.now()
        self.background(D(2026, 11, 13, 2, 0), "Shadow 24h")
        sm = self.ops.shadow_summary(t0)
        self.sys.clock.set(D(2026, 11, 13, 9, 0))
        line = (f"Shadow 24h {'통과' if not sm['mismatch'] else '불일치'} (요청 {sm['n']}건: " +
                " · ".join(f"{g} {sm['by_group'].get(g, 0)}" for g in ("ETCH", "CVD", "PVD")) + f", 불일치 {sm['mismatch']}건)")
        for aid in out["shadow"]:
            self.sys.registry.update_agent(aid, shadow_version=None, shadow_mode=None)
        if sm["mismatch"]:
            self.say(line + " → 승격 보류, 후보 재평가 대기", level="warn")
            return
        ch = self.ops.promote_shadowed(out["shadow"], run_id, "구조 진화 채택 (fdc_toolkit + 캐시)")
        rep = out["report"]
        rep.update({"shadow": sm, "changes": ch, "status": "promoted"})
        self.ops._report(run_id, "evolve", f"진화 리포트 #{run_id}", rep)
        self.say(line + " → 승격: " + " / ".join(f"{c['agent_id']} {c['from']} → {c['to']}" for c in ch) + " · 승격 후 7일간 직전 버전 Shadow 병행", level="done")
        self.sys.store.kv_set("post_shadow_since", S(self.sys.clock.now()))

    def ch_sc005(self):
        self.background(D(2026, 11, 14, 14, 20), "승격 후 Shadow 병행")
        self.sys.clock.set(D(2026, 11, 14, 14, 30))
        f = self.sys.world.inject_fault("legacy_table_migration", None, {"cutover": "2026-11-14 14:30:00"}, ts=self.sys.clock.now())
        self.sys.bus.emit("fault", fault_id=f["fault_id"], type="legacy_table_migration", target="QUAL_HIS",
                          text="레거시 이력 테이블 QUAL_HIS → QL_HIS_NEW 이관 (신규 테이블 데이터 미적재)")
        self.sys.clock.set(D(2026, 11, 14, 14, 40))
        self.say("SC-005: 레거시 이관으로 이력이 비어 있는 상태에서 PVD-03 C챔버 AutoQual 요청이 들어옵니다.")
        self.runner.submit("PVD-03 C챔버 Target 교체 PM 끝났어. AutoQual 진행해줘", source="user", heal_wait=True)
        since = P(self.sys.store.kv_get("post_shadow_since") or S(self.sys.clock.now() - timedelta(days=2)))
        run_id = self.sys.store.next_id("RB-", 2)
        rep = self.ops.check_post_shadow(run_id, since)
        if not rep:
            self.sys.clock.set(D(2026, 11, 15, 10, 0))
            self.background(D(2026, 11, 16, 10, 0), "승격 후 Shadow 병행")
            rep = self.ops.check_post_shadow(run_id, since)
        if rep:
            self.say(f"[자동 롤백] {rep['cause']} — " + " / ".join(f"{c['agent_id']} {c['from']} → {c['to']}" for c in rep["cascade"]) +
                     f" · 불일치 샘플 {rep['heldout_added']}건 Held-out셋 추가", level="warn")
        self.sys.clock.set(D(2026, 11, 16, 11, 0))
        for fid, fv in list(self.sys.world.faults.items()):
            if fv["type"] == "legacy_table_migration" and fv["active"]:
                self.sys.world.clear_fault(fid)
        self.say("DB 담당자 조치: QL_HIS_NEW 적재 완료 → 레거시 이력 조회 정상화 (장애 해제)")
        self.sys.human_policy_change("shadow", "min_samples_per_group", 10, "운영자", "Shadow 사각지대 재발 방지: 장비군별 최소 10건, 부족 시 리플레이 이력 샘플 보충")
        self.say("운영자 조치: Shadow 통과 조건에 '장비군별 최소 10건, 부족 시 리플레이 이력 샘플로 보충' 추가 (평가 기준은 사람만 변경)", level="approval")
        self.background(D(2026, 11, 20, 2, 0), "롤백 후")
        self.sys.clock.set(D(2026, 11, 20, 2, 30))
        fx = self.ops.fix_and_repromote(self.sys.store.next_id("V-", 2))
        if fx.get("ok"):
            self.say("[후속] fdc_toolkit 1.0.1 (장비군별 단위 메타데이터 기반 정규화) 재평가 통과 → " +
                     " / ".join(f"{c['agent_id']} {c['from']} → {c['to']}" for c in fx["changes"]) + " (결함 버전 번호 재사용 안 함)", level="done")

    def ch_sc008(self):
        self.background(D(2026, 12, 1, 1, 30), "운영 11~13주차")
        self.sys.clock.set(D(2026, 12, 1, 2, 0))
        run_id = self.sys.store.next_id("O-", 2)
        self.say(f"SC-008 [L3 Evolve 야간] 요청 유형별 편성 이력 분석 — 편성 전략 진화 #{run_id}")
        rep = self.ops.orchestration_evolve(D(2026, 11, 17), D(2026, 11, 30, 23, 59), run_id)
        self.say(f"super_agent {rep['change']['from']} → {rep['change']['to']} — 요청당 호출 Agent {rep['calls'][0]} → {rep['calls'][1]}", level="done")

    def ch_sc009(self):
        self.background(D(2026, 12, 8, 1, 30), "편성 진화 후")
        self.sys.clock.set(D(2026, 12, 8, 2, 0))
        run_id = self.sys.store.next_id("V-", 2)
        self.say("SC-009 [L3] SC-004 기각안(병합)을 진화 아카이브에서 재출발")
        m = self.ops.merge_retry(run_id)
        if m.get("ok"):
            self.say("병합 채택: " + " / ".join(f"{c['agent_id']} {c['from']} → {c['to']}" for c in m["changes"]), level="done")
        self.sys.clock.set(D(2026, 12, 9, 2, 0))
        rid = self.sys.store.next_id("R-", 2)
        self.say(f"[Retire 후보 감지 — 2026-12-09 02:00] 폐기 검토 #{rid}")
        scan = self.ops.retire_scan(rid)
        report = {"run_id": rid, "scan": scan["candidates"], "items": []}
        for c in scan["candidates"]:
            aid = c["agent_id"]
            dep = self.ops.analyze_dependency(aid)
            item = {"agent_id": aid, "version": c["version"], "reason": c["reason"], "p": c["p"], "deps": dep["dependents"], "tests": len(dep["unique_test_cases"])}
            agent_calls = [d for d in dep["dependents"] if d["kind"] == "agent_call"]
            if agent_calls and c["indirect_30d"]:
                item["decision"] = "hold"
                item["why"] = f"직접 호출 {c['direct_30d']}건이지만 간접 호출 {c['indirect_30d']}건 ({agent_calls[0]['ref']} 내부 호출) → 미사용 아님, 폐기 보류"
                self.sys.evolver.archive({"cid": f"{rid}-{aid}", "title": f"{aid} 폐기 검토", "target": aid, "genomes": []}, "hold", item["why"], {}, rid, 4)
                self.say(f"{aid}: {item['why']}")
            elif not c["candidate"]:
                continue
            else:
                repl = "log_agent" if aid == "chamber_trend_agent" else None
                if repl:
                    v = self.ops.verify_replacement(aid, repl, rid)
                    item["verify"] = v
                    self.ops._node("verify_replacement", f"대체 검증: {aid} 회귀 {v['total']}건 + 최근 실제 요청 {v['recent']}건 → {repl} 재실행 {v['ok']}/{v['total']} 일치", rid, pace=0.7)
                    if v["ok"] < v["total"]:
                        item["decision"] = "hold"
                        item["why"] = f"대체 검증 불일치 {v['total'] - v['ok']}건 → 폐기 보류"
                        report["items"].append(item)
                        continue
                    moved = self._migrate_tests(aid, repl)
                    item["migrated"] = moved
                    self.ops._node("migrate_tests", f"테스트 이관: {aid} 전용 회귀 케이스 {moved}건 → {repl} 회귀셋 추가", rid, pace=0.5)
                self._deprecate(aid, repl, rid, c["reason"])
                item["decision"] = "deprecated"
                item["grace_until"] = self.sys.registry.agent(aid)["grace_until"]
                self.say(f"{aid} {c['version']} — {c['reason']} → deprecated 전환 (유예 ~{item['grace_until'][:10]}, {('호출은 ' + repl + '로 리다이렉트') if repl else '대체 Agent 없음 — 호출 시 Fallback'})")
            report["items"].append(item)
        self.ops._report(rid, "retire", f"폐기 검토 리포트 #{rid}", report)
        # 유예 기간 이벤트: PVD 사이클 drift 요청 → 리다이렉트 실패 → Fallback → Heal
        self.background(D(2026, 12, 11, 10, 0), "유예 기간")
        self.sys.clock.set(D(2026, 12, 11, 10, 20))
        self.say("유예 기간 이벤트: PVD 챔버 'PM 사이클 간 drift' 요청")
        self.runner.submit("PVD-02 B챔버 PM 사이클 간 ER drift 추이 보여줘", source="user")
        self._wait_heals()
        if self.sys.registry.genome("log_agent") and "pvd_cycle" in self.sys.registry.genome("log_agent")["params"]["features"]:
            v = self.ops.verify_replacement("chamber_trend_agent", "log_agent", rid)
            g = self.sys.registry.agent("chamber_trend_agent")
            new_grace = S(self.sys.clock.now() + timedelta(days=14))
            self.sys.registry.update_agent("chamber_trend_agent", grace_until=new_grace)
            self.sys.registry.lifecycle_event("chamber_trend_agent", "grace_restart", note=f"대체 검증 재수행 {v['ok']}/{v['total']} → 유예 재시작 ~{new_grace[:10]}", ref=rid)
            report["grace_event"] = {"verify": v, "grace_until": new_grace}
            self.say(f"대체 검증 재수행 {v['ok']}/{v['total']} 일치 → chamber_trend_agent 유예 재시작 (~{new_grace[:10]})")
        # 폐기 확정 (운영자 승인)
        self.background(D(2026, 12, 23, 9, 0), "유예 기간")
        self.sys.clock.set(D(2026, 12, 23, 9, 30))
        self._retire_with_approval("lot_trace_agent", rid)
        self.background(D(2026, 12, 28, 9, 0), "유예 기간")
        self.sys.clock.set(D(2026, 12, 28, 9, 30))
        self._retire_with_approval("chamber_trend_agent", rid)
        cands = [a["agent_id"] for a in self.sys.registry.agents("agent") if a["status"] in ("active", "probation")]
        report["final"] = {"candidates": cands, "n": len(cands)}
        self.ops._report(rid, "retire", f"폐기 검토 리포트 #{rid}", report)
        self.say(f"편성 후보 Agent: {len(cands)}개 ({' · '.join(c.replace('_agent', '') for c in cands)}) — 폐기 Agent Genome·테스트·Lineage는 아카이브 보관 (복원 가능)", level="done")

    # ── Retire 헬퍼 ────────────────────────────────────────────────
    def _migrate_tests(self, aid, repl) -> int:
        rows = self.sys.store.all("SELECT * FROM tests WHERE agent_id=?", (aid,))
        n = 0
        for t in rows:
            n += 1
            self.sys.store.insert("tests", {"test_id": f"{t['test_id']}-M", "agent_id": repl, "suite": "regression", "input": t["input"],
                                            "expect": dict(t["expect"], label=t["expect"]["label"] + f" [이관: {aid}]"), "origin": f"migrate:{aid}",
                                            "ts": S(self.sys.clock.now())})
        return n

    def _deprecate(self, aid, repl, ref, reason):
        grace = S(self.sys.clock.now() + timedelta(days=self.sys.policy["retire"]["grace_days"]))
        self.sys.registry.update_agent(aid, status="deprecated", replacement=repl, grace_until=grace)
        self.sys.registry.lifecycle_event(aid, "deprecate", note=f"{reason} — 유예 ~{grace[:10]}, 리다이렉트 → {repl}", ref=ref)

    def _retire_with_approval(self, aid, ref):
        a = self.sys.registry.agent(aid)
        if not a or a["status"] != "deprecated":
            return
        apr = self.sys.approvals.request("retire", f"{aid} {a['active_version']} → retired (폐기 확정)", {
            "agent_id": aid, "version": a["active_version"], "grace_until": a["grace_until"], "replacement": a["replacement"],
            "note": "유예 기간 이상 없음 — 편성·Heal·회귀 대상 제거, Genome·테스트·Lineage 아카이브 보관"})
        self.say(f"폐기 승인 요청: {apr['title']}", level="approval")
        row = self.wait_approval(apr, "유예 기간 이상 없음 확인")
        if row["status"] != "approved":
            return
        g = self.sys.registry.genome(aid)
        arc = self.sys.store.next_id("ARC-", 4)
        self.sys.store.insert("archive", {"archive_id": arc, "candidate_id": f"{aid}@{a['active_version']}", "target": aid, "layer": "④ Agent 구성",
                                          "decision": "retired", "reason": f"폐기 확정 (승인 {row['approver']})", "scores": {}, "code": g["code"],
                                          "ts": S(self.sys.clock.now()), "report_id": ref, "meta": {"title": f"{aid} Genome 보관", "tests": len(self.sys.harness.tests_for(aid))}})
        self.sys.registry.update_agent(aid, status="retired")
        self.sys.registry.lifecycle_event(aid, "retire", note=f"retired (승인 {row['approver']}) — 아카이브 {arc}", ref=ref)
        self.say(f"{aid} {a['active_version']} → retired (운영자 승인 {row['approver']}) · 아카이브 {arc}", level="done")

    def _wait_heals(self, timeout=60):
        t0 = time.time()
        while self.sys.healer.inflight and time.time() - t0 < timeout:
            time.sleep(0.1)
