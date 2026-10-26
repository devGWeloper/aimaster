"""도구(Function) 구현 — 설계서 '도구 명세' 대응.

Agent 코드는 권한 프록시를 통해 이 도구들만 호출할 수 있다. 데이터 도구는 모두
effective clock(리플레이: replay_clock / 운영: 세계 현재 시각) 이하 데이터만 돌려주며,
리플레이 중에는 반환값의 시각 필드를 다시 검사해 미래 정보 누출을 감시한다.
가상 지연(ms)은 Mock FDC/EES/MES 서버 응답시간 모델이다(응답시간 KPI 산출용).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from mock_env.world import DataTimeout, GuardBlocked

IO_COST_MS = {"lookup_equipment": 60, "query_spec_db": 180, "get_pm_event": 150, "read_fdc_trace": 2300,
              "read_fdc_trace_per": 90, "read_fdc_summary": 900, "read_alarm_log": 1100, "inspect_legacy_schema": 600,
              "query_legacy_db": 420, "resolve_code_value": 80, "search_experience": 90, "unit_factor": 5}

TS_FIELDS = ("run_ts", "ts", "pm_end", "event_ts", "RUN_TS", "EVT_TS", "REG_DT")


def P(s) -> datetime:
    if isinstance(s, datetime):
        return s
    s = str(s).replace("T", " ")[:19]
    if len(s) == 10:
        s += " 00:00:00"
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def S(d: datetime) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S")


@dataclass
class RunContext:
    sys: object
    mode: str = "ops"                     # ops | replay | eval | test
    replay_clock: datetime | None = None
    request_id: str | None = None
    overlay: dict = field(default_factory=dict)       # agent_id -> version (평가·Shadow용)
    lesson_overlay: list | None = None                # 후보 교훈 세트 (평가용)
    run_shadow: bool = True
    io_ms: float = 0.0
    leaks: int = 0
    guard_blocked: int = 0
    calls: list = field(default_factory=list)          # [{agent_id, version, action, depth, ok, ms}]
    stack: list = field(default_factory=list)
    quiet: bool = False
    cache: dict = field(default_factory=dict)
    trace_cache_enabled: bool = False
    cache_store: dict | None = None                    # 테스트 격리용 캐시 서비스
    force_format: str | None = None                    # 하네스 벤더 샘플 테스트용 (예: '5.2')

    @property
    def replay(self) -> bool:
        return self.replay_clock is not None

    def clock(self) -> datetime:
        return self.replay_clock or self.sys.clock.now()

    def child(self, **kw):
        c = RunContext(self.sys, self.mode, self.replay_clock, self.request_id, dict(self.overlay), self.lesson_overlay,
                       self.run_shadow, quiet=self.quiet, cache_store=self.cache_store, force_format=self.force_format)
        for k, v in kw.items():
            setattr(c, k, v)
        return c


class LeakDetected(Exception):
    pass


def _check_leak(ctx: RunContext, obj, clock: datetime):
    """리플레이 중 반환 데이터에 replay_clock 이후 시각이 섞였는지 재검사 (누출 감시)."""
    if not ctx.replay:
        return
    lim = S(clock)

    def scan(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in TS_FIELDS and isinstance(v, str) and v[:4].isdigit() and v.replace("T", " ")[:19] > lim:
                    ctx.leaks += 1
                elif isinstance(v, (dict, list)):
                    scan(v)
        elif isinstance(o, list):
            for x in o[:2000]:
                if isinstance(x, (dict, list)):
                    scan(x)
    scan(obj)


def make_tools(ctx: RunContext, agent_id: str) -> dict:
    sysm = ctx.sys
    world = sysm.world

    def cost(name, extra=0.0):
        ctx.io_ms += IO_COST_MS.get(name, 50) + extra

    def lookup_equipment(eqp_id):
        cost("lookup_equipment")
        return world.lookup_equipment(eqp_id)

    def query_spec_db(eqp_model, pm_type, chamber_id=None):
        cost("query_spec_db")
        return world.query_spec(eqp_model, pm_type, ctx.clock().date())

    def get_pm_event(chamber_id, pm_type=None, limit=1, since=None):
        cost("get_pm_event")
        r = world.pm_events(chamber_id, ctx.clock(), limit, pm_type, P(since) if since else None)
        _check_leak(ctx, r, ctx.clock())
        return r

    def read_fdc_trace(eqp_id, chamber_id, start, end, sensors=None, slice=None):
        if slice:
            # 로그 슬라이싱: 원문 전체 대신 필요한 구간(header / around / sample)만 반환 — 대용량 로그 진단용
            clock = ctx.clock()
            out, hidden = world.fdc_slice(eqp_id, chamber_id, P(start), P(end), clock, dict(slice), force_format=ctx.force_format)
            cost("read_fdc_trace", IO_COST_MS["read_fdc_trace_per"] * max(1, sum(len(x["rows"]) for x in out) // 10))
            if ctx.replay and hidden:
                ctx.guard_blocked += 1
                world.guard_stats["queries_filtered"] += 1
                world.guard_stats["rows_hidden"] += hidden
            _check_leak(ctx, out, clock)
            return out
        key = ("fdc", chamber_id, str(start), str(end), S(ctx.clock()))
        if ctx.trace_cache_enabled and key in ctx.cache:
            ctx.io_ms += 15
            return ctx.cache[key]
        clock = ctx.clock()
        try:
            rows, hidden = world.fdc_traces(eqp_id, chamber_id, P(start), P(end), clock, force_format=ctx.force_format)
        except DataTimeout:
            cost("read_fdc_trace", 30000)
            raise
        cost("read_fdc_trace", IO_COST_MS["read_fdc_trace_per"] * len(rows))
        if ctx.replay and hidden:
            ctx.guard_blocked += 1
            world.guard_stats["queries_filtered"] += 1
            world.guard_stats["rows_hidden"] += hidden
        _check_leak(ctx, rows, clock)
        if ctx.trace_cache_enabled:
            ctx.cache[key] = rows
        return rows

    def read_fdc_summary(chamber_id, start, end):
        cost("read_fdc_summary")
        r = world.fdc_summary(chamber_id, P(start), P(end), ctx.clock())
        _check_leak(ctx, r, ctx.clock())
        return r

    def read_alarm_log(eqp_id, chamber_id, start, end):
        cost("read_alarm_log")
        r = world.alarm_log(eqp_id, chamber_id, P(start), P(end), ctx.clock())
        _check_leak(ctx, r, ctx.clock())
        return r

    def inspect_legacy_schema(table_pattern="%", sample_rows=3):
        cost("inspect_legacy_schema")
        return world.legacy_schema(table_pattern, sample_rows, ctx.clock(), ctx.replay)

    def query_legacy_db(sql, params=None):
        cost("query_legacy_db")
        try:
            r = world.legacy_query(sql, params, ctx.clock(), ctx.replay)
        except GuardBlocked:
            ctx.guard_blocked += 1
            raise
        if r["guard_blocked"]:
            ctx.guard_blocked += 1
        return r

    def resolve_code_value(table, column, values):
        cost("resolve_code_value")
        grp = {"PM_TP_CD": "PM_TP_CD", "Q1_RSLT_CD": "RSLT_CD", "QF_RSLT_CD": "RSLT_CD", "ITM_CD": "ITM_CD",
               "UNIT_CD": "UNIT_CD", "CHB_ID": "CHB_ID", "PRT_CD": "PRT_CD"}.get(column, column)
        return world.code_dict(grp, list(values), ctx.clock(), ctx.replay)

    def search_experience(filters=None, limit=50):
        cost("search_experience")
        f = dict(filters or {})
        if ctx.lesson_overlay is not None and f.get("kind") == "lesson":
            out = [x for x in ctx.lesson_overlay
                   if (not f.get("eqp_model") or x.get("eqp_model") == f["eqp_model"])
                   and (not f.get("pm_type") or x.get("pm_type") == f["pm_type"])]
            return out[:limit]
        return sysm.memory.search(f, limit, before_ts=ctx.clock())

    def unit_factor(from_unit, to_unit):
        cost("unit_factor")
        if from_unit == to_unit:
            return 1.0
        for a, b, f in world.unit_conversions():
            if a == from_unit and b == to_unit:
                return f
        return None

    def call_agent(target, action, inputs):
        return sysm.runtime.run_agent(ctx, target, action, inputs, indirect=True)

    def now():
        return S(ctx.clock())

    return {k: v for k, v in locals().items() if callable(v) and not k.startswith("_") and k not in ("cost",)}


ALL_TOOL_NAMES = ["lookup_equipment", "query_spec_db", "get_pm_event", "read_fdc_trace", "read_fdc_summary",
                  "read_alarm_log", "inspect_legacy_schema", "query_legacy_db", "resolve_code_value",
                  "search_experience", "unit_factor", "call_agent", "now"]
