"""운영 UI 서버 — FastAPI + SSE.

    python -m ui.server            # http://localhost:8765
    python -m ui.server --port 9000

브라우저는 /api/state 로 스냅샷을 받고 /api/events (SSE) 로 Agent의 모든 사고·행동 이벤트를 실시간 수신한다.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from autoqual.story import Story  # noqa: E402
from autoqual.system import System  # noqa: E402

# 프론트엔드: ui/web (Vite + React + Tailwind + shadcn/ui) 빌드 결과물 dist/ 를 그대로 서빙한다.
#   개발 시 `cd ui/web && npm run dev` (5173, /api 는 8765로 프록시) · 배포 시 `npm run build` → dist/ 커밋
DIST = Path(__file__).resolve().parent / "web" / "dist"

app = FastAPI(title="AutoQual Self-Evolving Agent")
if (DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")
if (DIST / "fonts").exists():
    app.mount("/fonts", StaticFiles(directory=DIST / "fonts"), name="fonts")


@app.middleware("http")
async def no_cache_index(request: Request, call_next):
    """index.html 은 항상 재검증 (해시 붙은 assets/* 는 장기 캐시 가능)."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


SYS: System | None = None
STORY: Story | None = None
_kpi_cache = {"t": 0, "v": None}


def sysm() -> System:
    global SYS, STORY
    if SYS is None:
        SYS = System(
            os.environ.get("AUTOQUAL_RUNTIME") or None
        )  # 실행 상태 디렉터리 (기본 runtime/, 테스트·병행 실행 시 분리 가능)
        STORY = Story(SYS)
    return SYS


def J(x):
    return JSONResponse(json.loads(json.dumps(x, ensure_ascii=False, default=str)))


@app.get("/")
def index():
    if not (DIST / "index.html").exists():
        return JSONResponse(
            {
                "detail": "프론트엔드 빌드가 없습니다. ui/web 에서 `npm install && npm run build` 를 실행하세요."
            },
            status_code=503,
        )
    return FileResponse(DIST / "index.html")


@app.get("/api/health")
def health():
    S = sysm()
    return J(
        {
            "ok": True,
            "clock": S.clock.now().isoformat(sep=" "),
            "story_running": STORY.running,
            "llm": S.llm.describe().get("mode"),
            "frontend": (DIST / "index.html").exists(),
        }
    )


# ── 스냅샷 ─────────────────────────────────────────────────────────
@app.get("/api/state")
def state():
    S = sysm()
    st = S.store
    reg = S.registry.snapshot()
    pend = S.approvals.pending()
    faults = [f for f in S.world.faults.values() if f["active"]]
    rp = st.kv_get("replay_status", {}) or {}
    return J(
        {
            "clock": S.clock.now().isoformat(sep=" "),
            "speed": S.bus.speed,
            "paused": not S.bus.paused.is_set(),
            "approval_mode": st.kv_get("approval_mode", "manual"),
            "llm": S.llm.describe(),
            "jev": {"model": S.jev.model, "calls": S.jev.calls},
            "story": STORY.status(),
            "registry": reg,
            "approvals": pend,
            "faults": faults,
            "replay": rp,
            "replay_rows": st.kv_get("replay_rows", []) or [],
            "after_sc007": st.kv_get("kpi_after_sc007"),
            "fab": S.fab.all(),
            "policy": S.policy,
            "counts": {
                "lessons": S.memory.count("lesson"),
                "cases": S.memory.count("case"),
                "heals": st.scalar("SELECT COUNT(*) FROM reports WHERE kind='heal'"),
                "grows": st.scalar("SELECT COUNT(*) FROM reports WHERE kind='grow'"),
                "evolves": st.scalar(
                    "SELECT COUNT(*) FROM reports WHERE kind IN ('evolve','rollback','retire')"
                ),
                "archive": st.scalar("SELECT COUNT(*) FROM archive"),
                "audit": st.scalar("SELECT COUNT(*) FROM audit"),
                "sandbox": S.sandbox.stats,
                "guard": {
                    k: v for k, v in S.world.guard_stats.items() if k != "blocked_log"
                },
            },
            "last_seq": (S.bus.recent(1) or [{"seq": 0}])[-1]["seq"],
        }
    )


@app.get("/api/events")
def events(request: Request, since: int = 0):
    S = sysm()
    q = S.bus.subscribe()

    def gen():
        try:
            backlog = S.bus.recent(6000, since)
            for e in backlog:
                yield f"data: {json.dumps(e, ensure_ascii=False, default=str)}\n\n"
            last = time.time()
            while True:
                try:
                    e = q.get(timeout=10)
                    yield f"data: {json.dumps(e, ensure_ascii=False, default=str)}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"
                if time.time() - last > 3600 * 6:
                    break
        finally:
            S.bus.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── 스토리 제어 ────────────────────────────────────────────────────
@app.post("/api/story/start")
async def story_start(req: Request):
    body = await req.json() if (await req.body()) else {}
    S = sysm()
    S.bus.paused.set()
    ok = STORY.start(body.get("from"), body.get("to"))
    return J({"ok": ok})


@app.post("/api/story/stop")
def story_stop():
    STORY.stop()
    return J({"ok": True})


@app.post("/api/story/jump")
async def story_jump(req: Request):
    body = await req.json()
    if STORY.running:
        raise HTTPException(
            409, "Autopilot 실행 중에는 이동할 수 없습니다. 먼저 정지하세요."
        )
    ok = STORY.jump(body["id"])
    sysm().bus.emit(
        "story", text=f"⤴ 체크포인트 복원: {body['id']} 직전 상태", level="info"
    )
    return J({"ok": ok})


@app.post("/api/pause")
def pause():
    sysm().bus.paused.clear()
    return J({"paused": True})


@app.post("/api/resume")
def resume():
    sysm().bus.paused.set()
    return J({"paused": False})


@app.post("/api/speed")
async def speed(req: Request):
    body = await req.json()
    sysm().bus.speed = float(body["speed"])
    return J({"speed": sysm().bus.speed})


@app.post("/api/approval_mode")
async def approval_mode(req: Request):
    body = await req.json()
    sysm().store.kv_set("approval_mode", body["mode"])
    return J({"mode": body["mode"]})


@app.post("/api/reset")
def reset():
    if STORY.running:
        raise HTTPException(409, "Autopilot 실행 중")
    S = sysm()
    S.reset()
    S.store.kv_set("story", {"done": []})
    S.bus.emit("story", text="초기화 — 2026-07 베이스라인 상태", level="info")
    return J({"ok": True})


# ── 승인 ───────────────────────────────────────────────────────────
@app.post("/api/approval/{rid}")
async def approve(rid: str, req: Request):
    body = await req.json()
    row = sysm().approvals.decide(
        rid,
        bool(body.get("approved")),
        body.get("approver") or "운영자",
        body.get("reason") or "",
    )
    if not row:
        raise HTTPException(404, "대기 중인 승인 요청이 아닙니다")
    return J(row)


@app.get("/api/approvals")
def approvals():
    return J(
        sysm().store.all("SELECT * FROM approvals ORDER BY requested_ts DESC LIMIT 300")
    )


# ── 채팅 ───────────────────────────────────────────────────────────
@app.post("/api/chat")
async def chat(req: Request):
    body = await req.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "요청 내용을 입력하세요")
    S = sysm()
    p = S.super.parse(text, S.clock.now())
    runner = STORY.runner
    if p["measurements"] and p["rtype"] in ("judge", "remeasure"):
        tid = runner.waiting_thread_for(p["entities"].get("chamber_id"))
        if tid:
            S.bus.emit(
                "request",
                request_id=runner.threads[tid]["request_id"],
                thread_id=tid,
                text=text,
                source="user",
                user="엔지니어",
            )
            runner.resume_with_measurement(tid, p["measurements"])
            return J({"ok": True, "resumed": tid})
    auto = body.get("auto_measure", True)
    job = runner.submit(text, source="user", background=True, auto_measure=auto)
    return J(
        {"ok": True, "request_id": job["request_id"], "thread_id": job["thread_id"]}
    )


@app.get("/api/requests")
def requests_list():
    return J(
        sysm().store.all(
            "SELECT request_id, ts, text, rtype, status, thread_id, source FROM requests WHERE source!='sim' ORDER BY request_id DESC LIMIT 60"
        )
    )


# ── 리포트·Registry·아카이브 ───────────────────────────────────────
@app.get("/api/reports")
def reports(kind: str | None = None):
    st = sysm().store
    sql = (
        "SELECT report_id, kind, title, ts FROM reports"
        + (" WHERE kind=?" if kind else "")
        + " ORDER BY ts DESC"
    )
    return J(st.all(sql, (kind,) if kind else ()))


@app.get("/api/reports/full")
def reports_full(limit: int = 80, kind: str | None = None):
    """리포트 전문 목록 (진화 사건 피드용) — N+1 호출 대신 한 번에."""
    st = sysm().store
    sql = (
        "SELECT * FROM reports"
        + (" WHERE kind=?" if kind else "")
        + " ORDER BY ts DESC LIMIT ?"
    )
    return J(st.all(sql, (kind, limit) if kind else (limit,)))


@app.get("/api/report/{rid}")
def report(rid: str):
    r = sysm().store.one("SELECT * FROM reports WHERE report_id=?", (rid,))
    if not r:
        raise HTTPException(404)
    return J(r)


@app.get("/api/genome/{agent_id}")
def genome(agent_id: str, version: str | None = None):
    S = sysm()
    g = S.registry.genome(agent_id, version)
    if not g:
        raise HTTPException(404)
    a = S.registry.agent(agent_id)
    tests = S.store.all(
        "SELECT test_id, suite, expect, origin FROM tests WHERE agent_id=? ORDER BY test_id",
        (agent_id,),
    )
    return J(
        {
            "agent": a,
            "genome": g,
            "versions": S.registry.versions(agent_id),
            "lineage": S.registry.lineage(agent_id),
            "tests": [
                {
                    "test_id": t["test_id"],
                    "suite": t["suite"],
                    "label": (t["expect"] or {}).get("label"),
                    "origin": t["origin"],
                }
                for t in tests
            ],
        }
    )


@app.get("/api/lineage")
def lineage():
    return J(sysm().registry.lineage())


@app.get("/api/archive")
def archive():
    return J(
        sysm().store.all(
            "SELECT archive_id, candidate_id, target, layer, decision, reason, scores, ts, report_id, meta FROM archive ORDER BY ts DESC, archive_id DESC"
        )
    )


@app.get("/api/archive/{aid}")
def archive_one(aid: str):
    r = sysm().store.one("SELECT * FROM archive WHERE archive_id=?", (aid,))
    if not r:
        raise HTTPException(404)
    return J(r)


@app.get("/api/memory")
def memory(kind: str = "lesson"):
    rows = sysm().store.all(
        "SELECT id, kind, event_ts, eqp_model, pm_type, status, content, source_case_ids FROM experience WHERE kind=? ORDER BY id",
        (kind,),
    )
    for r in rows:
        r["sources"] = len(r.pop("source_case_ids") or [])
    return J(rows)


@app.get("/api/kpi")
def kpi(fresh: int = 0):
    if fresh or time.time() - _kpi_cache["t"] > 20 or _kpi_cache["v"] is None:
        _kpi_cache["v"] = sysm().kpi()
        _kpi_cache["t"] = time.time()
    return J(_kpi_cache["v"])


@app.get("/api/autoqual/cases")
def autoqual_cases(limit: int = 120):
    """운영 기간에 Agent가 처리한 AutoQual 건(경험 메모리 case) — 업무 흐름 화면의 'Qual 처리 이력'."""
    rows = sysm().store.all(
        "SELECT id, event_ts, chamber_id, pm_type, eqp_model, content FROM experience "
        "WHERE kind='case' AND json_extract(content,'$.mode')='ops' ORDER BY event_ts DESC, id DESC LIMIT ?",
        (limit,),
    )
    out = []
    for r in rows:
        c = r["content"] or {}
        a = c.get("actual") or {}
        rec = c.get("recommendation") or {}
        apr = c.get("approval") or {}
        out.append(
            {
                "id": r["id"],
                "ts": r["event_ts"],
                "request_id": c.get("request_id"),
                "chamber_id": r["chamber_id"],
                "pm_type": r["pm_type"],
                "eqp_model": r["eqp_model"],
                "eqp_group": c.get("eqp_group"),
                "pm_end": c.get("pm_end"),
                "count": rec.get("count"),
                "base": rec.get("base"),
                "corrections": [
                    x.get("lesson_id") for x in rec.get("corrections") or []
                ],
                "n1": a.get("n1"),
                "pass1": a.get("pass1"),
                "fail_items": a.get("fail_items"),
                "attempts": a.get("attempts"),
                "final_count": a.get("final_count"),
                "final_pass": a.get("final_pass"),
                "override": c.get("override"),
                "engineer": a.get("eng"),
                "approver": apr.get("approver"),
                "approved": apr.get("approved"),
                "versions": c.get("versions"),
                "escalated": c.get("escalated"),
                "wait": a.get("wait"),
            }
        )
    return J(out)


@app.get("/api/audit")
def audit(limit: int = 80):
    return J(
        sysm().store.all("SELECT * FROM audit ORDER BY rowid DESC LIMIT ?", (limit,))
    )


@app.get("/api/ops")
def ops_summary():
    S = sysm()
    rows = S.store.all(
        "SELECT ts, request_type, eqp_group, agents, latency_ms, plan_source FROM orch_log ORDER BY id DESC LIMIT 400"
    )
    return J(rows)


# ── 장애 주입 (수동) ────────────────────────────────────────────────
@app.post("/api/fault")
async def fault(req: Request):
    body = await req.json()
    S = sysm()
    t = body["type"]
    target = body.get("target")
    params = body.get("params") or {}
    if t == "sw_v52":
        params = {"from": S.clock.now().strftime("%Y-%m-%d 00:00:00"), "tz": {}}
    if t == "legacy_table_migration":
        params = {"cutover": S.clock.now().strftime("%Y-%m-%d %H:%M:%S")}
    f = S.world.inject_fault(t, target, params, ts=S.clock.now())
    S.bus.emit(
        "fault",
        fault_id=f["fault_id"],
        type=t,
        target=target,
        text=f"장애 주입기(수동): {t} → {target}",
    )
    return J(f)


@app.post("/api/fault/{fid}/clear")
def fault_clear(fid: str):
    S = sysm()
    S.world.clear_fault(fid)
    S.bus.emit("fault", fault_id=fid, type="clear", text=f"장애 해제: {fid}")
    return J({"ok": True})


@app.get("/api/graphs")
def graphs():
    """LangGraph 노드·엣지 정의 (루프 트레이스 뷰)."""
    S = sysm()
    out = {}
    for name, g in (
        ("L1", S.l1.ops),
        ("L2-Heal", S.healer.graph),
        ("L2-Grow", S.factory.graph),
    ):
        gg = g.get_graph()
        out[name] = {
            "nodes": [n for n in gg.nodes if not n.startswith("__")],
            "edges": [
                {"from": e.source, "to": e.target, "cond": bool(e.conditional)}
                for e in gg.edges
            ],
        }
    out["L3"] = {
        "nodes": [
            "collect_metrics",
            "jev_need_evolve",
            "mutate",
            "evaluate_harness",
            "select",
            "archive",
            "shadow_run",
            "promote",
            "auto_rollback",
        ],
        "edges": [
            {"from": a, "to": b, "cond": c}
            for a, b, c in [
                ("collect_metrics", "jev_need_evolve", False),
                ("jev_need_evolve", "mutate", True),
                ("mutate", "evaluate_harness", False),
                ("evaluate_harness", "select", False),
                ("select", "archive", False),
                ("archive", "shadow_run", True),
                ("shadow_run", "promote", True),
                ("shadow_run", "auto_rollback", True),
            ]
        ],
    }
    return J(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    sysm()
    print(f"AutoQual 운영 UI → http://{a.host}:{a.port}")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
