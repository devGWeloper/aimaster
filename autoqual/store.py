"""단일 저장소 — Agent Registry·Lineage·경험 메모리·진화 아카이브·리포트·승인·감사 로그.

설계서는 PostgreSQL 단일 DB를 명시한다. PoC는 동일 스키마를 SQLite(WAL)로 구현했다
(사내 설치 없이 재현 가능, 체크포인트=파일 복사). 모든 레코드에 event_ts(가상 시각)를 둔다.
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents(agent_id TEXT PRIMARY KEY, kind TEXT, name_ko TEXT, protected INTEGER, status TEXT,
    active_version TEXT, shadow_version TEXT, shadow_mode TEXT, shadow_since TEXT, replacement TEXT, grace_until TEXT,
    origin TEXT, created_ts TEXT, last_called_ts TEXT, direct_calls INTEGER DEFAULT 0, indirect_calls INTEGER DEFAULT 0,
    card TEXT);
CREATE TABLE IF NOT EXISTS genomes(agent_id TEXT, version TEXT, status TEXT, code TEXT, prompt TEXT, tools TEXT, tests TEXT,
    params TEXT, metrics TEXT, deps TEXT, parent_version TEXT, reason TEXT, ref TEXT, created_ts TEXT, lines INTEGER,
    PRIMARY KEY(agent_id, version));
CREATE TABLE IF NOT EXISTS lineage(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, from_version TEXT, to_version TEXT,
    kind TEXT, ref TEXT, ts TEXT, note TEXT, diff_add INTEGER, diff_del INTEGER, cascade TEXT);
CREATE TABLE IF NOT EXISTS experience(id TEXT PRIMARY KEY, kind TEXT, event_ts TEXT, eqp_model TEXT, chamber_id TEXT,
    pm_type TEXT, status TEXT, content TEXT, source_case_ids TEXT);
CREATE INDEX IF NOT EXISTS ix_exp ON experience(kind, eqp_model, pm_type, event_ts);
CREATE TABLE IF NOT EXISTS archive(archive_id TEXT PRIMARY KEY, candidate_id TEXT, target TEXT, layer TEXT, decision TEXT,
    reason TEXT, scores TEXT, code TEXT, ts TEXT, report_id TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS reports(report_id TEXT PRIMARY KEY, kind TEXT, title TEXT, ts TEXT, content TEXT);
CREATE TABLE IF NOT EXISTS approvals(request_id TEXT PRIMARY KEY, kind TEXT, title TEXT, payload TEXT, status TEXT,
    requested_ts TEXT, decided_ts TEXT, approver TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS audit(audit_id TEXT PRIMARY KEY, ts TEXT, agent_id TEXT, version TEXT, code_hash TEXT,
    elapsed_ms REAL, ok INTEGER, error TEXT, tool_calls TEXT, blocked TEXT, replay INTEGER);
CREATE TABLE IF NOT EXISTS blacklist(patch_hash TEXT PRIMARY KEY, error_signature TEXT, agent_id TEXT, ts TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS tests(test_id TEXT PRIMARY KEY, agent_id TEXT, suite TEXT, input TEXT, expect TEXT, origin TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS templates(template_id TEXT PRIMARY KEY, request_type TEXT, agents TEXT, plan_code TEXT,
    conditions TEXT, status TEXT, created_ts TEXT, uses INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS orch_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, request_id TEXT, request_type TEXT,
    eqp_group TEXT, agents TEXT, contributions TEXT, plan_source TEXT, latency_ms REAL, human_confirm INTEGER, extra TEXT);
CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY, ts TEXT, text TEXT, rtype TEXT, entities TEXT, status TEXT,
    response TEXT, thread_id TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS fab_state(chamber_id TEXT PRIMARY KEY, state TEXT, since TEXT, note TEXT, thread_id TEXT);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS heal_index(signature TEXT, heal_id TEXT, agent_id TEXT, patch_ref TEXT, ts TEXT);
"""

JSON_COLS = {"tools", "tests", "params", "metrics", "deps", "content", "source_case_ids", "scores", "payload",
             "tool_calls", "agents", "contributions", "entities", "response", "conditions", "card", "meta", "extra",
             "cascade", "value", "input", "expect"}


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self._open()

    def _open(self):
        self.con = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.execute("PRAGMA synchronous=OFF")
        self.con.executescript(SCHEMA)

    def close(self):
        with self.lock:
            self.con.close()

    def reset(self):
        with self.lock:
            self.con.close()
            for suffix in ("", "-wal", "-shm"):
                p = Path(str(self.path) + suffix)
                if p.exists():
                    p.unlink()
            self._open()

    def snapshot_to(self, dst: Path):
        with self.lock:
            self.con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            bk = sqlite3.connect(dst)
            self.con.backup(bk)
            bk.close()

    def restore_from(self, src: Path):
        with self.lock:
            self.con.close()
            for suffix in ("-wal", "-shm"):
                p = Path(str(self.path) + suffix)
                if p.exists():
                    p.unlink()
            shutil.copyfile(src, self.path)
            self._open()

    # ── 기본 연산 ───────────────────────────────────────────────────
    @staticmethod
    def _enc(k, v):
        if k in JSON_COLS and v is not None and not isinstance(v, str):
            return json.dumps(v, ensure_ascii=False, default=str)
        return v

    @staticmethod
    def _dec(row) -> dict | None:
        if row is None:
            return None
        d = dict(row)
        for k, v in d.items():
            if k in JSON_COLS and isinstance(v, str) and v[:1] in "[{\"":
                try:
                    d[k] = json.loads(v)
                except json.JSONDecodeError:
                    pass
        return d

    def insert(self, table: str, row: dict, replace: bool = True):
        cols = list(row)
        sql = f"INSERT {'OR REPLACE ' if replace else ''}INTO {table}({','.join(cols)}) VALUES({','.join('?' * len(cols))})"
        with self.lock:
            cur = self.con.execute(sql, [self._enc(k, row[k]) for k in cols])
            return cur.lastrowid

    def insert_many(self, table: str, rows: list[dict]):
        if not rows:
            return
        cols = list(rows[0])
        sql = f"INSERT OR REPLACE INTO {table}({','.join(cols)}) VALUES({','.join('?' * len(cols))})"
        with self.lock:
            self.con.execute("BEGIN")
            self.con.executemany(sql, [[self._enc(k, r.get(k)) for k in cols] for r in rows])
            self.con.execute("COMMIT")

    def update(self, table: str, key: dict, values: dict):
        sets = ",".join(f"{k}=?" for k in values)
        where = " AND ".join(f"{k}=?" for k in key)
        with self.lock:
            self.con.execute(f"UPDATE {table} SET {sets} WHERE {where}",
                             [self._enc(k, v) for k, v in values.items()] + list(key.values()))

    def one(self, sql: str, args=()) -> dict | None:
        with self.lock:
            return self._dec(self.con.execute(sql, args).fetchone())

    def all(self, sql: str, args=()) -> list[dict]:
        with self.lock:
            return [self._dec(r) for r in self.con.execute(sql, args).fetchall()]

    def scalar(self, sql: str, args=()):
        with self.lock:
            r = self.con.execute(sql, args).fetchone()
            return r[0] if r else None

    # ── KV ─────────────────────────────────────────────────────────
    def kv_get(self, key: str, default=None):
        r = self.one("SELECT value FROM kv WHERE key=?", (key,))
        if r is None:
            return default
        v = r["value"]
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return v
        return v

    def kv_set(self, key: str, value):
        with self.lock:
            self.con.execute("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)", (key, json.dumps(value, ensure_ascii=False, default=str)))

    def next_id(self, prefix: str, width: int = 4, start: int = 1) -> str:
        with self.lock:
            n = self.kv_get(f"seq:{prefix}", start - 1) + 1
            self.kv_set(f"seq:{prefix}", n)
        return f"{prefix}{n:0{width}d}" if width else f"{prefix}{n}"
