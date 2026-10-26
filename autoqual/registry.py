"""Agent Registry — Genome(코드·프롬프트·툴·테스트·지표·버전) 저장, 생명주기, Lineage.

생명주기: probation → active → deprecated → retired (retired → probation 복원 가능, 하드 삭제 없음)
버전 규칙: 0.x.y probation / 1.0.0 첫 active / PATCH=Heal / MINOR=Evolve / MAJOR=구성 변경 / 롤백 시 결함 번호 재사용 안 함
"""
from __future__ import annotations

import difflib
from datetime import datetime


def vt(v: str) -> tuple:
    core = v.split("+")[0]
    return tuple(int(x) for x in core.split(".")) + ((1,) if "+" in v else (0,))


def vs(t: tuple) -> str:
    return ".".join(str(x) for x in t)


def diff_stats(a: str, b: str) -> tuple[int, int, str]:
    d = list(difflib.unified_diff((a or "").splitlines(), (b or "").splitlines(), "before", "after", lineterm="", n=2))
    add = sum(1 for x in d if x.startswith("+") and not x.startswith("+++"))
    rem = sum(1 for x in d if x.startswith("-") and not x.startswith("---"))
    return add, rem, "\n".join(d[:400])


class Registry:
    def __init__(self, sysm):
        self.sys = sysm
        self.store = sysm.store
        self._cache: dict[tuple, dict] = {}

    def _now(self) -> str:
        return self.sys.clock.now().strftime("%Y-%m-%d %H:%M:%S")

    def invalidate(self):
        self._cache.clear()

    # ── Agent ──────────────────────────────────────────────────────
    def register_agent(self, agent_id, kind, name_ko, protected=False, origin="초기 구축", card=None, status="active"):
        self.store.insert("agents", {"agent_id": agent_id, "kind": kind, "name_ko": name_ko, "protected": int(protected),
                                     "status": status, "active_version": None, "origin": origin, "created_ts": self._now(),
                                     "direct_calls": 0, "indirect_calls": 0, "card": card or {}})
        self.invalidate()

    def agent(self, agent_id) -> dict | None:
        return self.store.one("SELECT * FROM agents WHERE agent_id=?", (agent_id,))

    def agents(self, kind: str | None = "agent", statuses=None) -> list[dict]:
        rows = self.store.all("SELECT * FROM agents" + (" WHERE kind=?" if kind else "") + " ORDER BY created_ts, agent_id",
                              (kind,) if kind else ())
        if statuses:
            rows = [r for r in rows if r["status"] in statuses]
        return rows

    def update_agent(self, agent_id, **values):
        self.store.update("agents", {"agent_id": agent_id}, values)
        self.invalidate()

    # ── Genome ─────────────────────────────────────────────────────
    def add_genome(self, agent_id, version, code, *, params=None, deps=None, tools=None, tests=None, prompt="",
                   parent=None, reason="", ref="", status="candidate", metrics=None):
        self.store.insert("genomes", {"agent_id": agent_id, "version": version, "status": status, "code": code, "prompt": prompt,
                                      "tools": tools or [], "tests": tests or [], "params": params or {}, "metrics": metrics or {},
                                      "deps": deps or {}, "parent_version": parent, "reason": reason, "ref": ref,
                                      "created_ts": self._now(), "lines": len(code.splitlines())})
        self._cache.pop((agent_id, version), None)
        return version

    def genome(self, agent_id, version: str | None = None) -> dict | None:
        if version is None:
            a = self.agent(agent_id)
            if not a or not a["active_version"]:
                return None
            version = a["active_version"]
        key = (agent_id, version)
        g = self._cache.get(key)
        if g is None:
            g = self.store.one("SELECT * FROM genomes WHERE agent_id=? AND version=?", key)
            if g:
                self._cache[key] = g
        return g

    def versions(self, agent_id) -> list[dict]:
        rows = self.store.all("SELECT agent_id, version, status, parent_version, reason, ref, created_ts, lines FROM genomes WHERE agent_id=?",
                              (agent_id,))
        return sorted(rows, key=lambda r: vt(r["version"]))

    def set_genome_status(self, agent_id, version, status):
        self.store.update("genomes", {"agent_id": agent_id, "version": version}, {"status": status})
        self._cache.pop((agent_id, version), None)

    def next_version(self, agent_id, base: str, kind: str) -> str:
        used = {r["version"] for r in self.versions(agent_id)}
        M, m, p = vt(base)[:3]
        if kind == "patch":
            cand = (M, m, p + 1)
        elif kind == "minor":
            cand = (M, m + 1, 0)
        elif kind == "major":
            cand = (M + 1, 0, 0)
        elif kind == "promote":
            cand = (1, 0, 0) if M == 0 else (M, m + 1, 0)
        else:
            raise ValueError(kind)
        while vs(cand) in used:
            cand = (cand[0], cand[1], cand[2] + 1) if kind == "patch" else (cand[0], cand[1] + 1, 0) if kind in ("minor", "promote") else (cand[0] + 1, 0, 0)
        return vs(cand)

    def activate(self, agent_id, version, kind, ref="", note="", cascade=None):
        a = self.agent(agent_id)
        prev = a["active_version"] if a else None
        g_prev = self.genome(agent_id, prev) if prev else None
        g_new = self.genome(agent_id, version)
        add, rem, diff = diff_stats(g_prev["code"] if g_prev else "", g_new["code"] if g_new else "")
        if prev and prev != version:
            self.set_genome_status(agent_id, prev, "rolled_back" if kind == "rollback_from" else "superseded")
        self.set_genome_status(agent_id, version, "active")
        self.update_agent(agent_id, active_version=version)
        self.store.insert("lineage", {"agent_id": agent_id, "from_version": prev, "to_version": version, "kind": kind, "ref": ref,
                                      "ts": self._now(), "note": note, "diff_add": add, "diff_del": rem, "cascade": cascade or []}, replace=False)
        # diff 본문은 흐름 화면 CodeAct 패널에서 진화·롤백 코드 변경을 보여주는 용도 (heal은 패치 diff가 code 이벤트로 이미 나감)
        self.sys.bus.emit("version", agent_id=agent_id, from_version=prev, to_version=version, kind=kind, ref=ref, note=note,
                          diff_add=add, diff_del=rem, diff=diff[:6000] if kind in ("evolve", "compose", "rollback", "promote") else None)
        return {"agent_id": agent_id, "from": prev, "to": version, "diff_add": add, "diff_del": rem}

    def lineage(self, agent_id=None) -> list[dict]:
        if agent_id:
            return self.store.all("SELECT * FROM lineage WHERE agent_id=? ORDER BY id", (agent_id,))
        return self.store.all("SELECT * FROM lineage ORDER BY id")

    def lifecycle_event(self, agent_id, kind, note="", ref=""):
        a = self.agent(agent_id)
        self.store.insert("lineage", {"agent_id": agent_id, "from_version": a["active_version"], "to_version": a["active_version"],
                                      "kind": kind, "ref": ref, "ts": self._now(), "note": note, "diff_add": 0, "diff_del": 0,
                                      "cascade": []}, replace=False)
        self.sys.bus.emit("registry", agent_id=agent_id, event=kind, status=a["status"], note=note)

    # ── 호출 통계 ──────────────────────────────────────────────────
    def record_call(self, agent_id, indirect: bool):
        col = "indirect_calls" if indirect else "direct_calls"
        with self.store.lock:
            self.store.con.execute(f"UPDATE agents SET {col}={col}+1, last_called_ts=? WHERE agent_id=?", (self._now(), agent_id))

    def dependents_of_skill(self, skill_id: str, version: str | None = None) -> list[dict]:
        out = []
        for a in self.agents("agent"):
            g = self.genome(a["agent_id"])
            if g and skill_id in (g["deps"] or {}).get("skills", {}):
                if version is None or g["deps"]["skills"][skill_id] == version:
                    out.append({"agent_id": a["agent_id"], "version": g["version"]})
        return out

    def snapshot(self) -> dict:
        out = []
        for a in self.agents(None):
            g = self.genome(a["agent_id"]) if a["active_version"] else None
            out.append({**{k: a[k] for k in ("agent_id", "kind", "name_ko", "protected", "status", "active_version", "shadow_version",
                                             "shadow_mode", "replacement", "grace_until", "origin", "created_ts", "last_called_ts",
                                             "direct_calls", "indirect_calls")},
                        "lines": g["lines"] if g else 0, "deps": g["deps"] if g else {}, "card": a["card"],
                        "versions": [{"version": v["version"], "status": v["status"], "reason": v["reason"], "ts": v["created_ts"]}
                                     for v in self.versions(a["agent_id"])]})
        return {"agents": out}
