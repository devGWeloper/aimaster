"""운영 모드 실행기 — 요청 처리(L1 ops 그래프 구동)와 배경 운영 시뮬레이터.

RequestRunner
  - 요청 1건 = 스레드 1개 (챔버 단위 잠금: 진행 중인 챔버로 재요청 시 기존 스레드에 합류)
  - interrupt(measurement): Mock Fab이 Seasoning·측정 수행 후 측정값 전달 (또는 사용자가 채팅으로 입력)
  - interrupt(approval): 승인 패널에서 사람이 승인/반려해야 재개 (자동 승인 없음)
OpsSimulator
  - 운영 기간 PM 이벤트를 시간순으로 재생: 가상 엔지니어 요청, Override 행동, Qual 결과, 교대 리더 승인 → 경험 메모리
"""
from __future__ import annotations

import random
import threading
import time
from datetime import datetime, timedelta

from langgraph.types import Command

from mock_env import config as C
from mock_env.simulator import rng_for

from .tools import P, S


class RequestRunner:
    def __init__(self, sysm):
        self.sys = sysm
        self.threads: dict[str, dict] = {}     # thread_id → {request_id, chamber_id, status}
        self.chamber_lock: dict[str, str] = {}
        self._lock = threading.Lock()
        self.pending_measure: dict[str, dict] = {}   # thread_id → interrupt payload (사용자 측정값 입력 대기)

    def submit(self, text: str, source: str = "user", hint: dict | None = None, sim: dict | None = None, background=False,
               auto_measure=True, approver: str | None = None, fixed_meas: dict | None = None, meas_delay: float = 1.0,
               heal_wait: bool = False) -> dict:
        rid = self.sys.store.next_id("REQ-", 4)
        now = S(self.sys.clock.now())
        tid = f"T-{rid}"
        self.sys.store.insert("requests", {"request_id": rid, "ts": now, "text": text, "status": "new", "thread_id": tid, "source": source})
        if not (self.sys.bus.mute_depth and source == "sim"):
            self.sys.bus.emit("request", request_id=rid, thread_id=tid, text=text, source=source,
                              user=(sim or {}).get("engineer") or ("엔지니어" if source == "user" else "Autopilot"))
        job = {"request_id": rid, "thread_id": tid, "text": text, "source": source, "hint": hint, "sim": sim, "auto_measure": auto_measure,
               "approver": approver, "fixed_meas": fixed_meas, "meas_delay": meas_delay, "status": "running", "heal_wait": heal_wait}
        self.threads[tid] = job
        if background:
            th = threading.Thread(target=self._drive, args=(job,), daemon=True, name=f"req-{rid}")
            th.start()
            job["th"] = th
        else:
            self._drive(job)
        return job

    # ── 구동 ───────────────────────────────────────────────────────
    def _drive(self, job):
        g = self.sys.l1.ops
        cfg = {"configurable": {"thread_id": job["thread_id"]}}
        st = {"request": {"request_id": job["request_id"], "text": job["text"], "thread_id": job["thread_id"], "hint": job.get("hint"),
                          "source": job["source"]}, "mode": "ops"}
        try:
            out = g.invoke(st, cfg)
            while out.get("__interrupt__"):
                iv = out["__interrupt__"][0].value
                if iv["kind"] == "measurement":
                    cid = iv["chamber_id"]
                    with self._lock:
                        holder = self.chamber_lock.get(cid)
                        if holder and holder != job["thread_id"] and holder in self.threads and self.threads[holder]["status"] == "running":
                            pass
                        self.chamber_lock[cid] = job["thread_id"]
                    payload = self._measure(job, iv, g.get_state(cfg).values)
                    if payload is None:
                        job["status"] = "waiting_measure"
                        self.pending_measure[job["thread_id"]] = iv
                        return
                    out = g.invoke(Command(resume=payload), cfg)
                elif iv["kind"] == "approval":
                    dec = self._approval(job, iv)
                    if dec is None:
                        job["status"] = "stopped"
                        return
                    out = g.invoke(Command(resume=dec), cfg)
                else:
                    break
            job["status"] = "done"
            job["final"] = out
            self._finish(job, out)
        except Exception as e:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = repr(e)
            if type(e).__name__ != "StoryStopped":
                self.sys.bus.emit("toast", level="error", text=f"{job['request_id']} 처리 오류: {e!r}"[:200])
            if type(e).__name__ == "StoryStopped":
                raise
        finally:
            with self._lock:
                for k, v in list(self.chamber_lock.items()):
                    if v == job["thread_id"] and job["status"] != "waiting_measure":
                        self.chamber_lock.pop(k, None)

    def resume_with_measurement(self, thread_id: str, measurements: list[dict], count: int | None = None):
        """사용자가 채팅으로 측정값을 입력해 측정 대기 스레드를 재개."""
        job = self.threads.get(thread_id)
        iv = self.pending_measure.pop(thread_id, None)
        if not job or not iv:
            return False
        job["status"] = "running"
        job["manual_meas"] = {"measurements": measurements, "count": count or iv["count"], "wait": iv.get("wait")}
        th = threading.Thread(target=self._resume_manual, args=(job,), daemon=True)
        th.start()
        return True

    def _resume_manual(self, job):
        g = self.sys.l1.ops
        cfg = {"configurable": {"thread_id": job["thread_id"]}}
        payload = job.pop("manual_meas")
        out = g.invoke(Command(resume=payload), cfg)
        job["auto_measure"] = False
        while out.get("__interrupt__"):
            iv = out["__interrupt__"][0].value
            if iv["kind"] == "approval":
                dec = self._approval(job, iv)
                if dec is None:
                    return
                out = g.invoke(Command(resume=dec), cfg)
            else:
                job["status"] = "waiting_measure"
                self.pending_measure[job["thread_id"]] = iv
                return
        job["status"] = "done"
        self._finish(job, out)

    def waiting_thread_for(self, chamber_id: str | None = None) -> str | None:
        for tid, iv in self.pending_measure.items():
            if chamber_id is None or iv["chamber_id"] == chamber_id:
                return tid
        return None

    # ── Mock Fab: Seasoning·측정 ───────────────────────────────────
    def _measure(self, job, iv, values) -> dict | None:
        if not job["auto_measure"]:
            return None
        if job.get("heal_wait") and iv["attempt"] == 1:
            t0 = time.time()
            while self.sys.healer.inflight and time.time() - t0 < 90:
                time.sleep(0.1)
            g = self.sys.l1.ops
            values = g.get_state({"configurable": {"thread_id": job["thread_id"]}}).values
            rec = (values.get("synth") or {}).get("recommendation") or {}
            if rec.get("count"):
                iv = dict(iv, count=rec["count"])
        ents = values["request"]["entities"]
        truth = self.sys.world.event_for(ents["chamber_id"], ents["pm_end"])
        count = iv["count"]
        override = None
        sim = job.get("sim")
        if sim and iv["attempt"] == 1 and sim.get("override"):
            ov = sim["override"](truth, count, values)
            if ov:
                override = ov
                count = ov["count"]
        wait = bool(iv.get("wait"))
        if sim and iv["attempt"] == 1 and sim.get("wait") is not None and not wait:
            wait = sim["wait"]
        fixed = job.get("fixed_meas") if iv["attempt"] == 1 else None
        if truth is None:
            res = {"measurements": {}, "passed": True}
        else:
            res = self.sys.world.run_qual(truth, count, wait, iv["attempt"], fixed)
        dur = round(count * 3.6 + 60)
        if not (self.sys.bus.mute_depth and job["source"] == "sim"):
            self.sys.bus.emit("fab_progress", chamber_id=ents["chamber_id"], request_id=job["request_id"], count=count, attempt=iv["attempt"],
                              minutes=dur, override=override, wait=wait,
                              text=(f"Seasoning {count}매" + (f" (엔지니어 Override: 추천 {iv['count']}매 → {count}매, 사유 '{override['reason']}')" if override else "")
                                    + (" · BP 안정화 30분 대기" if wait else "") + f" → Particle·모니터 측정 (약 {dur // 60}시간 {dur % 60}분)"))
            self.sys.bus.pace(job.get("meas_delay", 1.0))
        self.sys.clock.advance(minutes=dur)
        meas = [{"item": k, "value": v[0], "unit": v[1]} for k, v in (res.get("measurements") or {}).items()]
        job.setdefault("attempts", []).append({"count": count, "res": res, "wait": wait})
        if override and sim:
            override["engineer"] = sim.get("engineer")
        return {"measurements": meas, "count": count, "override": override, "wait": wait}

    def _approval(self, job, iv) -> dict | None:
        rid = iv["approval_id"]
        if job["source"] == "sim":
            approver = (job.get("sim") or {}).get("lead", "교대 리더")
            row = self.sys.approvals.decide(rid, True, approver, "Qual PASS 확인")
            return {"approved": True, "approver": approver, "decided_ts": row["decided_ts"] if row else None}
        mode = self.sys.store.kv_get("approval_mode", "manual")
        if mode == "auto" or job.get("approver"):
            self.sys.bus.emit("approval_countdown", request_id=rid, seconds=4)
            self.sys.bus.pace(4.0)
            row = self.sys.store.one("SELECT * FROM approvals WHERE request_id=?", (rid,))
            if row and row["status"] == "pending":
                self.sys.approvals.decide(rid, True, job.get("approver") or "운영자(데모 자동 승인)", "Qual PASS 근거 확인")
        row = self.sys.approvals.wait(rid)
        if not row or row["status"] == "pending":
            return None
        return {"approved": row["status"] == "approved", "approver": row["approver"], "reason": row["reason"], "decided_ts": row["decided_ts"]}

    def _finish(self, job, out):
        vals = out if isinstance(out, dict) else {}
        q = vals.get("qual") or {}
        ents = (vals.get("request") or {}).get("entities") or {}
        atts = job.get("attempts") or []
        if not atts or not ents.get("chamber_id"):
            return
        truth = self.sys.world.event_for(ents["chamber_id"], ents["pm_end"])
        if truth is None:
            return
        eng = (job.get("sim") or {}).get("engineer") or "E107"
        memo_parts = []
        if atts[0]["wait"]:
            memo_parts.append("BP 안정화 30분 대기 후 진행")
        for i, a in enumerate(atts):
            r = a["res"]
            memo_parts.append(f"{i + 1}차 {'PASS' if r['passed'] else 'NG(' + ','.join(r['fail_items']) + ')'}")
        self.sys.world.append_qual_history(truth, [a["res"] for a in atts], eng, ". ".join(memo_parts), self.sys.clock.now())


class OpsSimulator:
    """운영 기간 배경 요청 생성기 (가상 엔지니어)."""

    def __init__(self, sysm, runner: RequestRunner):
        self.sys = sysm
        self.runner = runner
        self.engineers = [f"E{101 + i}" for i in range(40)]

    def override_fn(self, eng_kind: str, night: bool):
        def fn(truth, count, values):
            r = rng_for("override", truth.event_id)
            ents = values["request"]["entities"]
            if truth.group == "ETCH" and truth.pm_type in ("WET_CLEAN", "QUARTERLY_PM") and (truth.fr_hours or 0) >= 600:
                rec = (values.get("synth") or {}).get("recommendation") or {}
                fr_in = any("L-" in str(c.get("lesson_id")) and "Focus" in c.get("reason", "") for c in rec.get("corrections", []))
                if not fr_in and r.random() < (0.75 if eng_kind == "experienced" else 0.45):
                    return {"count": count + 10, "reason": "Focus Ring 오래 씀"}
            if night and eng_kind == "conservative" and r.random() < 0.5:
                return {"count": count + 10, "reason": "야간이라 여유 있게"}
            if eng_kind == "conservative" and r.random() < 0.08:
                return {"count": count + 5, "reason": "기타(이전 Fail 경험)"}
            return None
        return fn

    def run_between(self, start: datetime, end: datetime, skip_tags=("SC-001", "SC-003", "SC-005", "SC-007-next", "SC-009"),
                    extra_requests=True, label=""):
        evs = [t for t, row in self.sys.world.events_between(start, end, splits=["ops"]) if (row.get("TAG") or "") not in skip_tags]
        bus = self.sys.bus
        bus.emit("ops_batch", phase="start", n=len(evs), start=S(start), end=S(end), label=label)
        done = 0
        for t in evs:
            if self.sys.bus.stop_flag:
                break
            self.sys.clock.set(t.pm_end + timedelta(minutes=8))
            r = rng_for("opsreq", t.event_id)
            night = t.pm_end.hour >= 20 or t.pm_end.hour < 8
            eng = self.engineers[int(r.random() * 40)]
            kind = "experienced" if r.random() < 0.2 else ("conservative" if r.random() < 0.3 else "normal")
            text = f"{t.eqp_id} {t.chamber}챔버 {C.PM_TYPES[t.pm_type]['name']} PM 끝났어. AutoQual 진행해줘"
            sim = {"engineer": eng, "lead": f"E{120 + int(r.random() * 10)}(교대 리더)", "override": self.override_fn(kind, night),
                   "wait": None}
            with bus.muted():
                job = self.runner.submit(text, source="sim", sim=sim)
            out = job.get("final") or {}
            q = out.get("qual") or {}
            rec = (out.get("synth") or {}).get("recommendation") or {}
            att = q.get("attempts") or []
            first = att[0] if att else None
            bus.emit("ops_case", chamber_id=f"{t.eqp_id}-{t.chamber}", pm_type=t.pm_type, count=rec.get("count"),
                     result=(first or {}).get("judgement", {}).get("result"), attempts=len(att), engineer=eng,
                     override=(first or {}).get("override"), versions=None, request_id=job["request_id"],
                     text=f"{t.pm_end:%m-%d %H:%M} {t.eqp_id}-{t.chamber} {C.PM_TYPES[t.pm_type]['name']} → 추천 {rec.get('count')}매"
                          + (f" (Override {first['override']['count']}매)" if first and first.get("override") else "")
                          + f" → {(first or {}).get('judgement', {}).get('result', '-')}" + (f" (재작업 {len(att) - 1}회)" if len(att) > 1 else "")
                          + " → UP 승인")
            # 재측정 판정 요청 (Particle 단독 Fail 시) / 이력 문의
            if extra_requests and first and first["judgement"]["result"] == "FAIL" and set(first["judgement"]["fail_items"]) == {"PARTICLE"}:
                with bus.muted():
                    self.runner.submit(f"{t.eqp_id} {t.chamber}챔버 Particle 재측정 결과 판정해줘: Particle 8ea", source="sim", sim=sim)
            if extra_requests and r.random() < 0.5:
                with bus.muted():
                    self.runner.submit(f"{t.eqp_id} {t.chamber}챔버 Particle 재측정 판정해줘: Particle {int(3 + r.random() * 9)}ea", source="sim", sim=sim)
            done += 1
            if done % 5 == 0:
                bus.emit("ops_batch", phase="progress", done=done, n=len(evs), clock=S(self.sys.clock.now()))
                bus.pace(0.15)
        self.sys.clock.set(end)
        self.sys.flush()
        bus.emit("ops_batch", phase="end", n=done, label=label)
        return done
