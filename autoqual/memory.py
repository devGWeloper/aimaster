"""경험 메모리 — AutoQual 실행 건·Override·실제 결과·교훈(Lesson)·가설·미해결 오차 군집.

조회 키 (eqp_model, chamber_id, pm_type, event_ts). 리플레이 중에는 before_ts(=replay_clock) 이후 레코드를 자동 제외한다.
RAG를 쓰지 않고 정확 일치 조건 조회만 한다(다른 장비·PM 사례 혼입 방지).
"""
from __future__ import annotations

import json
from datetime import datetime


class Memory:
    def __init__(self, sysm):
        self.sys = sysm
        self.store = sysm.store
        self._buffer: list[dict] = []

    @staticmethod
    def _ts(x) -> str:
        return x.strftime("%Y-%m-%d %H:%M:%S") if isinstance(x, datetime) else str(x)

    def record(self, kind: str, content: dict, event_ts, *, eqp_model=None, chamber_id=None, pm_type=None,
               source_case_ids=None, status="active", mid: str | None = None, buffered=False) -> str:
        if mid is None:
            prefix = {"case": "C-", "lesson": "L-", "hypothesis": "H-", "cluster": "U-", "override": "O-"}.get(kind, "M-")
            width = {"case": 5, "cluster": 2}.get(kind, 4)
            mid = self.store.next_id(prefix, width)
        row = {"id": mid, "kind": kind, "event_ts": self._ts(event_ts), "eqp_model": eqp_model, "chamber_id": chamber_id,
               "pm_type": pm_type, "status": status, "content": content, "source_case_ids": source_case_ids or []}
        if buffered:
            self._buffer.append(row)
            if len(self._buffer) >= 300:
                self.flush()
        else:
            self.store.insert("experience", row)
        return mid

    def flush(self):
        if self._buffer:
            self.store.insert_many("experience", self._buffer)
            self._buffer = []

    def update(self, mid: str, **values):
        self.store.update("experience", {"id": mid}, values)

    def get(self, mid: str) -> dict | None:
        return self.store.one("SELECT * FROM experience WHERE id=?", (mid,))

    def search(self, filters: dict, limit: int = 50, before_ts=None) -> list[dict]:
        self.flush()
        sql = "SELECT id, kind, event_ts, eqp_model, chamber_id, pm_type, status, content, source_case_ids FROM experience WHERE 1=1"
        args = []
        for k in ("kind", "eqp_model", "pm_type", "chamber_id", "status"):
            if filters.get(k):
                sql += f" AND {k}=?"
                args.append(filters[k])
        bt = filters.get("before_ts") or before_ts
        if bt:
            sql += " AND event_ts<=?"
            args.append(self._ts(bt))
        sql += " ORDER BY event_ts DESC LIMIT ?"
        args.append(limit)
        return self.store.all(sql, args)

    def lessons(self, statuses=("active",), before_ts=None) -> list[dict]:
        self.flush()
        rows = self.store.all("SELECT * FROM experience WHERE kind='lesson' ORDER BY id")
        if before_ts:
            rows = [r for r in rows if r["event_ts"] <= self._ts(before_ts)]
        return [r for r in rows if statuses is None or r["status"] in statuses]

    def cases(self, start=None, end=None, mode=None, eqp_model=None, pm_type=None) -> list[dict]:
        self.flush()
        sql = "SELECT id, event_ts, eqp_model, chamber_id, pm_type, content FROM experience WHERE kind='case'"
        args = []
        if start:
            sql += " AND event_ts>=?"
            args.append(self._ts(start))
        if end:
            sql += " AND event_ts<=?"
            args.append(self._ts(end))
        if eqp_model:
            sql += " AND eqp_model=?"
            args.append(eqp_model)
        if pm_type:
            sql += " AND pm_type=?"
            args.append(pm_type)
        rows = self.store.all(sql + " ORDER BY event_ts", args)
        if mode:
            rows = [r for r in rows if r["content"].get("mode") == mode]
        return rows

    def count(self, kind: str) -> int:
        return self.store.scalar("SELECT COUNT(*) FROM experience WHERE kind=?", (kind,)) or 0
