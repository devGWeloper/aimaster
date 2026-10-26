"""System — 전체 구성요소 결선 (Store·World·Sandbox·Jev·LLM·Registry·Memory·Runtime·Super Agent·루프·하네스)."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta
from pathlib import Path

from mock_env import config as C
from mock_env.world import World

from .events import EventBus
from .jev import Jev
from .llm import LLMClient
from .memory import Memory
from .registry import Registry
from .runtime import AgentRuntime
from .sandbox import Sandbox
from .store import Store
from .super_agent import SuperAgent

ROOT = Path(__file__).resolve().parent.parent


class Clock:
    """가상 시각 (스토리 진행 시각). 리플레이 시각(replay_clock)은 RunContext가 따로 가진다."""

    def __init__(self, store: Store):
        self.store = store
        self._now = None

    def now(self) -> datetime:
        if self._now is None:
            v = self.store.kv_get("clock")
            self._now = datetime.fromisoformat(v) if v else datetime(2026, 7, 1, 9, 0)
        return self._now

    def set(self, dt: datetime):
        self._now = dt
        self.store.kv_set("clock", dt.isoformat(sep=" "))

    def advance(self, minutes: float = 0, seconds: float = 0, hours: float = 0, days: float = 0):
        self.set(self.now() + timedelta(minutes=minutes, seconds=seconds, hours=hours, days=days))

    def reload(self):
        self._now = None


class Fab:
    def __init__(self, sysm):
        self.sys = sysm

    def init(self):
        rows = []
        for eqp in C.ALL_EQPS:
            for ch in C.CHAMBERS:
                rows.append({"chamber_id": f"{eqp}-{ch}", "state": "RUN", "since": "2026-07-01 00:00:00", "note": "", "thread_id": None})
        self.sys.store.insert_many("fab_state", rows)

    def set_state(self, chamber_id, state, note="", thread_id=None):
        self.sys.store.insert("fab_state", {"chamber_id": chamber_id, "state": state, "since": self.sys.clock.now().strftime("%Y-%m-%d %H:%M:%S"),
                                            "note": note, "thread_id": thread_id})
        self.sys.bus.emit("fab", chamber_id=chamber_id, state=state, note=note)

    def get(self, chamber_id):
        return self.sys.store.one("SELECT * FROM fab_state WHERE chamber_id=?", (chamber_id,))

    def all(self):
        return self.sys.store.all("SELECT * FROM fab_state ORDER BY chamber_id")


class Approvals:
    """사람 승인 패널 — 장비 상태 변경·Agent 정식 승격·retired 전환·진화안 채택·평가 기준 변경."""

    def __init__(self, sysm):
        self.sys = sysm
        self.waiters: dict[str, threading.Event] = {}

    def request(self, kind, title, payload) -> dict:
        rid = self.sys.store.next_id("APR-", 4)
        row = {"request_id": rid, "kind": kind, "title": title, "payload": payload, "status": "pending",
               "requested_ts": self.sys.clock.now().strftime("%Y-%m-%d %H:%M:%S"), "decided_ts": None, "approver": None, "reason": None}
        self.sys.store.insert("approvals", row)
        self.waiters[rid] = threading.Event()
        self.sys.bus.emit("approval", action="requested", **{k: row[k] for k in ("request_id", "kind", "title", "payload", "requested_ts")})
        return row

    def decide(self, rid, approved: bool, approver: str, reason: str = "") -> dict | None:
        row = self.sys.store.one("SELECT * FROM approvals WHERE request_id=?", (rid,))
        if not row or row["status"] != "pending":
            return None
        ts = self.sys.clock.now().strftime("%Y-%m-%d %H:%M:%S")
        self.sys.store.update("approvals", {"request_id": rid}, {"status": "approved" if approved else "rejected",
                                                                 "decided_ts": ts, "approver": approver, "reason": reason})
        self.sys.bus.emit("approval", action="decided", request_id=rid, approved=approved, approver=approver, reason=reason,
                          kind=row["kind"], title=row["title"])
        ev = self.waiters.get(rid)
        if ev:
            ev.set()
        row = self.sys.store.one("SELECT * FROM approvals WHERE request_id=?", (rid,))
        hook = self.sys.approval_hooks.pop(rid, None)
        if hook:
            hook(row)
        return row

    def wait(self, rid, timeout=None) -> dict:
        ev = self.waiters.get(rid)
        if ev:
            while not ev.wait(0.2):
                if self.sys.bus.stop_flag:
                    break
                if timeout is not None:
                    timeout -= 0.2
                    if timeout <= 0:
                        break
        return self.sys.store.one("SELECT * FROM approvals WHERE request_id=?", (rid,))

    def pending(self):
        return self.sys.store.all("SELECT * FROM approvals WHERE status='pending' ORDER BY requested_ts")


class System:
    def __init__(self, runtime_dir: Path | None = None):
        self.root = ROOT
        self.runtime_dir = Path(runtime_dir or ROOT / "runtime")
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.base_policy = json.loads((ROOT / "eval" / "policy.json").read_text(encoding="utf-8"))
        self.store = Store(self.runtime_dir / "agentstore.db")
        self.bus = EventBus()
        self.clock = Clock(self.store)
        self.bus.clock_fn = self.clock.now
        self.world = World(self.runtime_dir)
        self._audit_buf: list[dict] = []
        self._audit_lock = threading.Lock()
        self.sandbox = Sandbox(audit_sink=self._audit)
        self.jev = Jev()
        self.llm = LLMClient()
        self.registry = Registry(self)
        self.memory = Memory(self)
        self.runtime = AgentRuntime(self)
        self.super = SuperAgent(self)
        self.fab = Fab(self)
        self.approvals = Approvals(self)
        self.approval_hooks: dict = {}
        self.hooks: dict[str, list] = {}
        self.policy = self._merged_policy()
        from .loops.l1 import L1
        from .loops.l2_heal import Healer
        from .loops.l2_grow import Factory
        from .loops.l3_evolve import Evolver
        from eval.harness import Harness
        self.l1 = L1(self)
        self.healer = Healer(self)
        self.factory = Factory(self)
        self.evolver = Evolver(self)
        self.harness = Harness(self)
        if not self.registry.agent("super_agent"):
            self.bootstrap()

    # ── 정책 (루프 밖 고정 + 운영자 변경 이력) ────────────────────────
    def _merged_policy(self) -> dict:
        pol = json.loads(json.dumps(self.base_policy))
        for ov in self.store.kv_get("policy_overrides", []) or []:
            sec, key, val = ov["section"], ov["key"], ov["value"]
            pol.setdefault(sec, {})[key] = val
        return pol

    def human_policy_change(self, section, key, value, approver, reason):
        ovs = self.store.kv_get("policy_overrides", []) or []
        ovs.append({"section": section, "key": key, "value": value, "approver": approver, "reason": reason,
                    "ts": self.clock.now().strftime("%Y-%m-%d %H:%M:%S")})
        self.store.kv_set("policy_overrides", ovs)
        self.policy = self._merged_policy()
        self.bus.emit("policy", section=section, key=key, value=value, approver=approver, reason=reason)

    # ── 감사 로그 ───────────────────────────────────────────────────
    def _audit(self, row: dict):
        with self._audit_lock:
            self._audit_buf.append(row)
            if len(self._audit_buf) >= 500:
                buf, self._audit_buf = self._audit_buf, []
            else:
                return
        self.store.insert_many("audit", buf)

    def flush(self):
        with self._audit_lock:
            buf, self._audit_buf = self._audit_buf, []
        self.store.insert_many("audit", buf)
        self.memory.flush()

    # ── 훅 ─────────────────────────────────────────────────────────
    def on(self, name, fn):
        self.hooks.setdefault(name, []).append(fn)

    def events_hook(self, name, **kw):
        for fn in self.hooks.get(name, []):
            try:
                fn(**kw)
            except Exception as e:  # noqa: BLE001
                self.bus.emit("toast", level="error", text=f"hook {name} 오류: {e}")

    # ── KPI ────────────────────────────────────────────────────────
    def kpi(self) -> dict:
        from eval.kpi import compute
        try:
            return compute(self)
        except Exception as e:  # noqa: BLE001
            return {"error": {"value": None, "detail": str(e)}}

    # ── 초기 구축 (2026-07 베이스라인) ───────────────────────────────
    def reset(self):
        self.bus.clear()
        self.store.reset()
        self.world.reset()
        self.runtime.reset()
        self.registry.invalidate()
        self.clock.reload()
        self.sandbox._compiled.clear()
        self.l1 = type(self.l1)(self)
        self.policy = self._merged_policy()
        self.bootstrap()

    def bootstrap(self):
        from .bootstrap import seed_baseline
        self.clock.set(datetime(2026, 7, 1, 9, 0))
        seed_baseline(self)
        self.fab.init()

    # ── 체크포인트 (스토리 챕터 간 점프) ──────────────────────────────
    def checkpoint(self, name: str):
        self.flush()
        d = self.runtime_dir / "checkpoints"
        d.mkdir(exist_ok=True)
        self.store.kv_set("faults", self.world.export_faults())
        self.store.kv_set("guard_stats", self.world.guard_stats)
        self.store.kv_set("rt_call_stats", self.runtime.call_stats[-20000:])
        self.store.kv_set("rt_shadow_log", self.runtime.shadow_log[-3000:])
        self.store.kv_set("heal_recent", self.healer.recent)
        self.store.snapshot_to(d / f"{name}.store.db")
        self.world.snapshot_to(d / f"{name}.legacy.db")

    def has_checkpoint(self, name: str) -> bool:
        d = self.runtime_dir / "checkpoints"
        return (d / f"{name}.store.db").exists() and (d / f"{name}.legacy.db").exists()

    def restore(self, name: str):
        d = self.runtime_dir / "checkpoints"
        self.store.restore_from(d / f"{name}.store.db")
        self.world.restore_from(d / f"{name}.legacy.db")
        self.world.import_faults(self.store.kv_get("faults", {}))
        self.world.guard_stats = self.store.kv_get("guard_stats", self.world.guard_stats)
        self.registry.invalidate()
        self.runtime.reset()
        self.runtime.call_stats = [tuple(x) for x in (self.store.kv_get("rt_call_stats", []) or [])]
        self.runtime.shadow_log = self.store.kv_get("rt_shadow_log", []) or []
        self.healer.recent = self.store.kv_get("heal_recent", {}) or {}
        self.clock.reload()
        self.policy = self._merged_policy()
        self.l1 = type(self.l1)(self)
