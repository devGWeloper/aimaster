"""이벤트 버스 — 모든 루프·Agent의 사고/행동을 UI(SSE)로 실시간 송출.

emit(type, **data)  : 이벤트 기록 + 구독자 전달
pace(seconds)       : 스토리 재생 속도에 맞춘 시각 연출용 대기 (speed=0 이면 생략)
"""
from __future__ import annotations

import itertools
import queue
import threading
import time
from collections import deque
from datetime import datetime


class EventBus:
    def __init__(self, maxlen: int = 16000):
        self._seq = itertools.count(1)
        self._buf: deque = deque(maxlen=maxlen)
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()
        self.speed = 1.0           # 0 = 최대 속도(연출 대기 없음)
        self.paused = threading.Event()
        self.paused.set()          # set = 진행 중
        self.clock_fn = lambda: None
        self._local = threading.local()   # 스레드별 억제 깊이 (대량 리플레이·배경 운영 시 세부 이벤트 억제)
        self.stop_flag = False

    # ── 송출 ────────────────────────────────────────────────────────
    def emit(self, etype: str, force: bool = False, **data) -> dict | None:
        if self.mute_depth and not force and etype not in ("story", "toast", "kpi", "replay_progress", "replay_quarter",
                                                              "clock", "version", "registry", "fab"):
            return None
        vt = self.clock_fn()
        ev = {"seq": next(self._seq), "type": etype, "vts": vt.isoformat(sep=" ", timespec="seconds") if isinstance(vt, datetime) else vt,
              "wall": time.time(), **data}
        with self._lock:
            self._buf.append(ev)
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(ev)
            except queue.Full:
                pass
        return ev

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=20000)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def recent(self, n: int = 400, since: int = 0) -> list[dict]:
        with self._lock:
            return [e for e in list(self._buf)[-n:] if e["seq"] > since]

    def clear(self):
        with self._lock:
            self._buf.clear()

    # ── 연출 ────────────────────────────────────────────────────────
    @property
    def mute_depth(self) -> int:
        return getattr(self._local, "depth", 0)

    def pace(self, seconds: float):
        self.paused.wait()
        if self.stop_flag:
            raise StoryStopped()
        if self.speed and seconds > 0 and not self.mute_depth:
            end = time.time() + seconds / self.speed
            while time.time() < end:
                if self.stop_flag:
                    raise StoryStopped()
                self.paused.wait()
                time.sleep(min(0.05, max(0.0, end - time.time())))

    class _Mute:
        def __init__(self, bus):
            self.bus = bus

        def __enter__(self):
            self.bus._local.depth = getattr(self.bus._local, "depth", 0) + 1

        def __exit__(self, *a):
            self.bus._local.depth -= 1

    def muted(self):
        return EventBus._Mute(self)


class StoryStopped(Exception):
    pass


class _NullBus(EventBus):
    def emit(self, etype, force=False, **data):
        return None

    def pace(self, seconds):
        return None


NULL_BUS = _NullBus()
