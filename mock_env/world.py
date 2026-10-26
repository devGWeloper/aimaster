"""Mock Fab '세계' — 데이터 서버 + 장애 주입기 + MES 기록.

Agent 도구 계층(autoqual.tools)은 이 모듈을 통해서만 데이터에 접근한다.
- 모든 조회는 시각(clock) 이하 데이터만 반환한다. 운영 모드에선 세계의 현재 시각,
  리플레이 모드에선 replay_clock(Time-Travel Guard)을 쓴다.
- 원본 DB는 읽기 전용(mode=ro)으로 연결한다. 운영 중 Qual 결과는 세계(MES)가
  runtime/legacy_live.db 에 적재한다(Agent는 여전히 읽기만 가능).
- 장애 주입기: sw_v52(로그 포맷) / leak_unit_torr(단위) / legacy_table_migration(이관·미적재)
  / fdc_timeout(외부 장애) / legacy_column_rename(스키마 변경)
"""
from __future__ import annotations

import json
import re
import shutil
import sqlite3
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

from . import config as C
from .formats import to_v52
from .simulator import EventTruth, simulate_qual

DATA = Path(__file__).parent / "data"

# 레거시 테이블별 이벤트 시각 컬럼 (Time-Travel Guard 기준). 없으면 리플레이 중 차단.
LEGACY_TS = {"QUAL_HIS": "EVT_TS", "QUAL_MEAS": "REG_DT", "PRT_CHG_HIS": "EVT_TS", "CHB_RF_USAGE": "EVT_TS",
             "QL_HIS_NEW": "EVT_TS"}
LEGACY_VALIDITY = {"CD_DICT": ("VALID_FROM", "VALID_TO")}
LEGACY_TABLES = ["QUAL_HIS", "QUAL_MEAS", "PRT_CHG_HIS", "CHB_RF_USAGE", "CD_DICT", "ETL_LOAD_LOG",
                 "QUAL_HIS_OLD", "TMP_QH_BAK_0312", "QL_HIS_NEW"]
DEPRECATED_TABLES = {"QUAL_HIS_OLD", "TMP_QH_BAK_0312"}
WRITE_SQL = re.compile(r"\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex)\b|\breplace\s+into\b", re.I)


class GuardBlocked(Exception):
    pass


class DataTimeout(TimeoutError):
    pass


def _ts(x: datetime) -> str:
    return x.strftime("%Y-%m-%d %H:%M:%S")


class World:
    def __init__(self, runtime_dir: Path):
        self.runtime_dir = Path(runtime_dir)
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.legacy_path = self.runtime_dir / "legacy_live.db"
        self.faults: dict[str, dict] = {}
        self._local = threading.local()
        self._write_lock = threading.Lock()
        self._truth_cache: dict[str, EventTruth] = {}
        self.guard_stats = {"queries_filtered": 0, "rows_hidden": 0, "blocked_tables": 0, "blocked_log": []}
        if not self.legacy_path.exists():
            self.reset()

    # ── 수명 ────────────────────────────────────────────────────────
    def reset(self):
        self._close_all()
        shutil.copyfile(DATA / "legacy.db", self.legacy_path)
        self.faults = {}
        self.guard_stats = {"queries_filtered": 0, "rows_hidden": 0, "blocked_tables": 0, "blocked_log": []}

    def _close_all(self):
        self._local = threading.local()

    def snapshot_to(self, path: Path):
        self._close_all()
        shutil.copyfile(self.legacy_path, path)

    def restore_from(self, path: Path):
        self._close_all()
        shutil.copyfile(path, self.legacy_path)

    # ── 연결 ────────────────────────────────────────────────────────
    def _ro(self, name: str) -> sqlite3.Connection:
        key = f"ro_{name}"
        con = getattr(self._local, key, None)
        if con is None:
            con = sqlite3.connect(f"file:{(DATA / name).as_posix()}?mode=ro", uri=True, check_same_thread=False)
            con.row_factory = sqlite3.Row
            setattr(self._local, key, con)
        return con

    def _legacy(self, clock: datetime, replay: bool) -> sqlite3.Connection:
        con = getattr(self._local, "legacy", None)
        if con is None:
            con = sqlite3.connect(":memory:", check_same_thread=False, uri=True)
            con.execute(f"ATTACH DATABASE 'file:{self.legacy_path.as_posix()}?mode=ro' AS lgsrc")
            con.row_factory = sqlite3.Row
            self._local.legacy = con
            self._local.legacy_key = None
        key = (_ts(clock), replay, json.dumps(sorted(self._legacy_fault_keys())))
        if self._local.legacy_key != key:
            self._build_views(con, clock, replay)
            self._local.legacy_key = key
        return con

    def _legacy_fault_keys(self):
        return [f["type"] + json.dumps(f.get("params", {}), sort_keys=True) for f in self.faults.values()
                if f["active"] and f["type"].startswith("legacy")]

    def _build_views(self, con, clock: datetime, replay: bool):
        c = _ts(clock)
        d = clock.strftime("%Y-%m-%d")
        for t in LEGACY_TABLES:
            con.execute(f"DROP VIEW IF EXISTS temp.{t}")
        migration = self.active_fault("legacy_table_migration")
        rename = self.active_fault("legacy_column_rename")
        for t in LEGACY_TABLES:
            cols = "*"
            if rename and rename["params"].get("table") == t:
                names = [r[1] for r in con.execute(f"PRAGMA lgsrc.table_info({t})")]
                cols = ", ".join(f'{n} AS {rename["params"]["new"]}' if n == rename["params"]["old"] else n for n in names)
            if t in LEGACY_TS:
                where = f"{LEGACY_TS[t]} <= '{c}'"
                if migration and t in ("QUAL_HIS", "QUAL_MEAS") and clock >= datetime.fromisoformat(migration["params"]["cutover"]):
                    where = "0"   # 이관 후 구 테이블 조회 불가 (빈 결과)
                con.execute(f"CREATE TEMP VIEW {t} AS SELECT {cols} FROM lgsrc.{t} WHERE {where}")
            elif t in LEGACY_VALIDITY:
                vf, vt = LEGACY_VALIDITY[t]
                con.execute(f"CREATE TEMP VIEW {t} AS SELECT {cols} FROM lgsrc.{t} WHERE {vf} <= '{d}' AND ({vt} IS NULL OR {vt} >= '{d}')")
            elif not replay:
                con.execute(f"CREATE TEMP VIEW {t} AS SELECT {cols} FROM lgsrc.{t}")
            else:
                # replay 모드: 이벤트 시각 없는 테이블(ETL_LOAD_LOG, QUAL_HIS_OLD, TMP_QH_BAK_0312)은 차단 뷰로 가린다
                # (가리지 않으면 SQLite가 이름을 첨부 DB에서 찾아 Guard가 우회됨)
                con.execute(f"CREATE TEMP VIEW {t} AS SELECT * FROM guard_blocked_{t}")

    # ── 장애 주입 ────────────────────────────────────────────────────
    def inject_fault(self, fault_type: str, target, params: dict | None = None, ts: datetime | None = None) -> dict:
        fid = f"F-{len(self.faults) + 1:03d}"
        self.faults[fid] = {"fault_id": fid, "type": fault_type, "target": target, "params": params or {},
                            "active": True, "ts": _ts(ts) if ts else None}
        self._close_all()
        return {"fault_id": fid, "active": True}

    def clear_fault(self, fault_id: str):
        if fault_id in self.faults:
            self.faults[fault_id]["active"] = False
        self._close_all()

    def active_fault(self, fault_type: str, target: str | None = None):
        for f in self.faults.values():
            if f["active"] and f["type"] == fault_type:
                tg = f["target"]
                if target is None or tg is None or target in (tg if isinstance(tg, list) else [tg]):
                    return f
        return None

    def export_faults(self):
        return json.loads(json.dumps(self.faults))

    def import_faults(self, faults: dict):
        self.faults = faults or {}
        self._close_all()

    # ── 기준정보 ─────────────────────────────────────────────────────
    def lookup_equipment(self, eqp_id: str):
        r = self._ro("spec.db").execute("SELECT * FROM EQP_MASTER WHERE EQP_ID=?", (eqp_id,)).fetchone()
        if not r:
            return None
        chs = [x[0] for x in self._ro("spec.db").execute("SELECT CHAMBER_ID FROM CHAMBER_MASTER WHERE EQP_ID=? ORDER BY 1", (eqp_id,))]
        return {"eqp_id": r["EQP_ID"], "eqp_model": r["EQP_MODEL"], "eqp_group": r["EQP_GROUP"], "line": r["LINE"], "chambers": chs}

    def list_equipment(self):
        return [dict(r) for r in self._ro("spec.db").execute("SELECT * FROM EQP_MASTER ORDER BY EQP_ID")]

    def query_spec(self, model: str, pm_type: str, at: date):
        con = self._ro("spec.db")
        d = at.isoformat()
        p = con.execute("SELECT * FROM QUAL_PROCEDURE WHERE EQP_MODEL=? AND PM_TYPE=? AND VALID_FROM<=? AND (VALID_TO IS NULL OR VALID_TO>=?)",
                        (model, pm_type, d, d)).fetchone()
        if not p:
            return {"error": "NOT_FOUND"}
        specs = [{"item": r["ITEM"], "lower": r["LOWER"], "upper": r["UPPER"], "unit": r["UNIT"], "inclusive": bool(r["INCLUSIVE"]),
                  "valid_from": r["VALID_FROM"], "valid_to": r["VALID_TO"]}
                 for r in con.execute("SELECT * FROM QUAL_SPEC WHERE PROCEDURE_ID=? AND VALID_FROM<=? AND (VALID_TO IS NULL OR VALID_TO>=?)",
                                      (p["PROCEDURE_ID"], d, d))]
        s = con.execute("SELECT * FROM SEASONING_RECIPE WHERE EQP_MODEL=? AND PM_TYPE=? AND VALID_FROM<=? AND (VALID_TO IS NULL OR VALID_TO>=?)",
                        (model, pm_type, d, d)).fetchone()
        return {"procedure_id": p["PROCEDURE_ID"], "revision": p["REVISION"], "steps": json.loads(p["STEPS_JSON"]),
                "specs": specs, "seasoning": {"recipe_id": s["RECIPE_ID"], "base_count": s["BASE_COUNT"], "recipe_rev": s["RECIPE_REV"]},
                "valid_at": d}

    def unit_conversions(self):
        return [(r[0], r[1], r[2]) for r in self._ro("spec.db").execute("SELECT * FROM UNIT_CONV")]

    # ── 장비 로그 (FDC·Leak·알람·PM 이벤트) ──────────────────────────
    def pm_events(self, chamber_id: str, clock: datetime, limit: int = 1, pm_type: str | None = None, since: datetime | None = None):
        sql = "SELECT * FROM PM_EVENT WHERE CHAMBER_ID=? AND PM_END<=?"
        args = [chamber_id, _ts(clock)]
        if pm_type:
            sql += " AND PM_TYPE=?"
            args.append(pm_type)
        if since:
            sql += " AND PM_END>=?"
            args.append(_ts(since))
        sql += " ORDER BY PM_END DESC LIMIT ?"
        args.append(limit)
        return [{"pm_id": r["PM_ID"], "eqp_id": r["EQP_ID"], "chamber_id": r["CHAMBER_ID"], "pm_type": r["PM_TYPE"],
                 "pm_start": r["PM_START"], "pm_end": r["PM_END"], "parts": [p for p in (r["PARTS"] or "").split(",") if p],
                 "worker": r["WORKER"]} for r in self._ro("fdc.db").execute(sql, args)]

    def fdc_traces(self, eqp_id: str, chamber_id: str, start: datetime, end: datetime, clock: datetime, force_format: str | None = None):
        if self.active_fault("fdc_timeout", eqp_id):
            raise DataTimeout(f"FDC server timeout (eqp={eqp_id}, 30s)")
        hi = min(end, clock)
        rows = self._ro("fdc.db").execute(
            "SELECT TRACE_ID, RUN_TS, RUN_KIND, SW_VERSION, RAW FROM FDC_TRACE WHERE CHAMBER_ID=? AND RUN_TS>=? AND RUN_TS<=? ORDER BY RUN_TS",
            (chamber_id, _ts(start), _ts(hi))).fetchall()
        hidden = 0
        if end > clock:
            hidden = self._ro("fdc.db").execute("SELECT COUNT(*) FROM FDC_TRACE WHERE CHAMBER_ID=? AND RUN_TS>? AND RUN_TS<=?",
                                                (chamber_id, _ts(clock), _ts(end))).fetchone()[0]
        out = []
        v52 = self.active_fault("sw_v52", eqp_id)
        for r in rows:
            raw, sw = r["RAW"], r["SW_VERSION"]
            if ((v52 and r["RUN_TS"] >= v52["params"].get("from", "0000")) or force_format == "5.2") and sw.startswith("4."):
                tz = (v52["params"].get("tz", {}) if v52 else {}).get(eqp_id, "" if eqp_id.endswith("12") else "+09:00")
                raw, sw = to_v52(raw, tz), "5.2"
            out.append({"trace_id": r["TRACE_ID"], "run_ts": r["RUN_TS"], "run_kind": r["RUN_KIND"], "sw_version": sw, "raw": raw})
        return out, hidden

    # ── FDC 로그 슬라이싱 (원본 해상도) ──────────────────────────────────
    # 저장된 트레이스는 5초 간격 export. 원본은 RAW_HZ로 샘플링된 것으로 보고, 요청한 행만 그 자리에서 보간 생성한다
    # (원본 전체를 읽지 않는다 — 대용량 로그를 슬라이스로만 관찰하는 SC-003 진단 경로).
    def fdc_slice(self, eqp_id: str, chamber_id: str, start: datetime, end: datetime, clock: datetime, sl: dict,
                  force_format: str | None = None):
        traces, hidden = self.fdc_traces(eqp_id, chamber_id, start, end, clock, force_format=force_format)
        parsed = [dict(t, **_split_trace(t["raw"])) for t in traces]
        mode, n = sl.get("mode", "header"), int(sl.get("n") or 5)

        def item(t, idx):
            return {"trace_id": t["trace_id"], "run_ts": t["run_ts"], "run_kind": t["run_kind"], "sw_version": t["sw_version"],
                    "header": t["meta"] + [t["header"]], "total_rows": t["total"], "rows": [_raw_row(t, i) for i in idx]}

        if mode == "header":
            out = [item(t, []) for t in parsed]
        elif mode == "sample":
            out = [item(t, sorted({round(j * (t["total"] - 1) / max(1, n - 1)) for j in range(n)})) for t in parsed]
        elif mode == "around":
            at = str(sl.get("at") or "")
            k = next((i for i, t in enumerate(parsed) if t["run_ts"] >= at), len(parsed) - 1)
            out = []
            if k > 0:
                prev = parsed[k - 1]
                out.append(item(prev, range(max(0, prev["total"] - n), prev["total"])))
            if parsed:
                out.append(item(parsed[k], range(min(n, parsed[k]["total"]))))
        else:
            raise ValueError(f"slice.mode는 header / around / sample 중 하나 ({mode})")
        return out, hidden

    def fdc_summary(self, chamber_id: str, start: datetime, end: datetime, clock: datetime):
        hi = min(end, clock)
        return [dict(r) for r in self._ro("fdc.db").execute(
            "SELECT * FROM FDC_RUN_SUMMARY WHERE CHAMBER_ID=? AND RUN_TS>=? AND RUN_TS<=? ORDER BY RUN_TS", (chamber_id, _ts(start), _ts(hi)))]

    def alarm_log(self, eqp_id: str, chamber_id: str, start: datetime, end: datetime, clock: datetime):
        if self.active_fault("fdc_timeout", eqp_id):
            raise DataTimeout(f"EES log server timeout (eqp={eqp_id})")
        hi = _ts(min(end, clock))
        con = self._ro("fdc.db")
        alarms = [{"ts": r["TS"], "alarm_code": r["ALARM_CODE"], "message": r["MESSAGE"], "severity": r["SEVERITY"]}
                  for r in con.execute("SELECT * FROM ALARM_LOG WHERE CHAMBER_ID=? AND TS>=? AND TS<=? ORDER BY TS", (chamber_id, _ts(start), hi))]
        leaks = [r["RAW"] for r in con.execute("SELECT RAW FROM LEAK_LOG WHERE CHAMBER_ID=? AND TS>=? AND TS<=? ORDER BY TS", (chamber_id, _ts(start), hi))]
        if self.active_fault("leak_unit_torr", chamber_id):
            leaks = [self._leak_to_torr(x) for x in leaks]
        return {"alarms": alarms, "leak_checks": leaks}

    @staticmethod
    def _leak_to_torr(line: str) -> str:
        m = re.search(r"RATE=([0-9.]+) mTorr/min", line)
        if not m:
            return line
        return line.replace(m.group(0), f"RATE={float(m.group(1)) / 1000:.5f} Torr/min")

    # ── 레거시 DB ────────────────────────────────────────────────────
    def legacy_query(self, sql: str, params: dict | None, clock: datetime, replay: bool):
        s = sql.strip().rstrip(";")
        low = s.lower()
        if not (low.startswith("select") or low.startswith("with")) or WRITE_SQL.search(low):
            raise PermissionError("레거시 DB는 SELECT만 허용됩니다 (권한 프록시)")
        if "lgsrc" in low or "sqlite_" in low:
            raise PermissionError("원본 스키마 직접 참조 금지 (Time-Travel Guard 우회 시도)")
        con = self._legacy(clock, replay)
        try:
            cur = con.execute(s, params or {})
        except sqlite3.OperationalError as e:
            msg = str(e)
            if replay and "no such table" in msg:
                t = msg.split(":")[-1].strip().replace("guard_blocked_", "").replace("main.", "")
                self.guard_stats["blocked_tables"] += 1
                self._guard_log("BLOCK_TABLE", t, clock)
                raise GuardBlocked(f"Time-Travel Guard: 이벤트 시각이 없는 테이블 {t} 차단 (replay_clock={_ts(clock)})")
            raise
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = [list(r) for r in cur.fetchall()]
        hidden = 0
        if replay:
            for t in LEGACY_TS:
                if re.search(rf"\b{t}\b", s, re.I):
                    hidden += con.execute(f"SELECT COUNT(*) FROM lgsrc.{t} WHERE {LEGACY_TS[t]} > ?", (_ts(clock),)).fetchone()[0]
            if hidden:
                self.guard_stats["queries_filtered"] += 1
                self.guard_stats["rows_hidden"] += hidden
        return {"columns": cols, "rows": rows, "row_count": len(rows), "guard_blocked": hidden}

    def _guard_log(self, kind, target, clock):
        log = self.guard_stats["blocked_log"]
        if len(log) < 500:
            log.append({"kind": kind, "target": target, "clock": _ts(clock)})

    def legacy_schema(self, pattern: str, sample_rows: int, clock: datetime, replay: bool):
        con = self._legacy(clock, replay)
        rx = re.compile("^" + pattern.replace("%", ".*").replace("_", "_") + "$", re.I)
        out = []
        etl = {}
        if not replay:
            for r in con.execute("SELECT * FROM ETL_LOAD_LOG"):
                etl[r["TBL_NM"]] = (r["LAST_LOAD_TS"], r["NOTE"])
        migration = self.active_fault("legacy_table_migration")
        for t in LEGACY_TABLES:
            if not rx.match(t):
                continue
            exists = con.execute("SELECT 1 FROM temp.sqlite_master WHERE name=?", (t,)).fetchone()
            if not exists or (replay and t not in LEGACY_TS and t not in LEGACY_VALIDITY):
                self.guard_stats["blocked_tables"] += 1
                self._guard_log("BLOCK_SCHEMA", t, clock)
                out.append({"table": t, "columns": [], "row_count": None, "last_loaded_at": None, "deprecated": t in DEPRECATED_TABLES,
                            "has_event_ts": False, "guard": "BLOCKED (이벤트 시각 없음)"})
                continue
            cur = con.execute(f"SELECT * FROM {t} LIMIT {int(sample_rows)}")
            names = [d[0] for d in cur.description]
            samples = cur.fetchall()
            cols = [{"name": n, "samples": [s[i] for s in samples]} for i, n in enumerate(names)]
            cnt = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            if t in LEGACY_TS:
                last = con.execute(f"SELECT MAX({LEGACY_TS[t]}) FROM {t}").fetchone()[0]
            else:
                last = etl.get(t, (None, None))[0]
            note = etl.get(t, (None, ""))[1]
            if migration and t == "QUAL_HIS" and clock >= datetime.fromisoformat(migration["params"]["cutover"]):
                note = f"QL_HIS_NEW로 이관됨 ({migration['params']['cutover'][:10]})"
                last = migration["params"]["cutover"]
            out.append({"table": t, "columns": cols, "row_count": cnt, "last_loaded_at": last, "deprecated": t in DEPRECATED_TABLES or bool(migration and t == "QUAL_HIS"),
                        "has_event_ts": t in LEGACY_TS, "note": note})
        return out

    def code_dict(self, grp: str, values: list, clock: datetime, replay: bool):
        con = self._legacy(clock, replay)
        out = {}
        for v in values:
            r = con.execute("SELECT CD_NM, VALID_FROM FROM CD_DICT WHERE CD_GRP=? AND CD_VAL=?", (grp, str(v))).fetchone()
            out[str(v)] = {"meaning": r[0], "source": f"CD_DICT(valid_from {r[1]})", "confidence": 1.0} if r else None
        return out

    # ── 세계(MES) 쓰기: 운영 기간 Qual 결과 적재 ──────────────────────
    def truth(self, event_id: str) -> EventTruth | None:
        if event_id in self._truth_cache:
            return self._truth_cache[event_id]
        r = self._ro("ground_truth.db").execute("SELECT * FROM EVENT_TRUTH WHERE EVENT_ID=?", (event_id,)).fetchone()
        if not r:
            return None
        t = self._row_truth(r)
        self._truth_cache[event_id] = t
        return t

    @staticmethod
    def _row_truth(r) -> EventTruth:
        t = EventTruth(event_id=r["EVENT_ID"], eqp_id=r["EQP_ID"], chamber=r["CHAMBER"], model=r["MODEL"], group=r["EQP_GROUP"],
                       pm_type=r["PM_TYPE"], pm_start=datetime.fromisoformat(r["PM_START"]), pm_end=datetime.fromisoformat(r["PM_END"]),
                       recipe=r["RECIPE"], rf_refl_delta=r["RF_REFL_DELTA"], fr_hours=r["FR_HOURS"], cycle_rf_hours=r["CYCLE_RF_HOURS"],
                       humid=bool(r["HUMID"]), bp_stable_min=r["BP_STABLE_MIN"], leak_rate=r["LEAK_RATE"], random_fail=bool(r["RANDOM_FAIL"]),
                       noise=r["NOISE"], fr_replaced=bool(r["FR_REPLACED"]), parts=json.loads(r["PARTS"] or "[]"))
        t.R = r["R_REQUIRED"]
        t.effects = json.loads(r["EFFECTS"])
        return t

    def events_between(self, start: datetime, end: datetime, splits=None):
        sql = "SELECT * FROM EVENT_TRUTH WHERE PM_END>=? AND PM_END<=?"
        args = [_ts(start), _ts(end)]
        if splits:
            sql += f" AND SPLIT IN ({','.join('?' * len(splits))})"
            args += list(splits)
        out = []
        for r in self._ro("ground_truth.db").execute(sql + " ORDER BY PM_END", args):
            t = self._row_truth(r)
            t.R = r["R_REQUIRED"]
            out.append((t, dict(r)))
        return out

    def event_for(self, chamber_id: str, pm_end: str):
        r = self._ro("ground_truth.db").execute("SELECT * FROM EVENT_TRUTH WHERE CHAMBER_ID=? AND PM_END=?", (chamber_id, pm_end)).fetchone()
        return self._row_truth(r) if r else None

    def tagged_event(self, tag: str):
        r = self._ro("ground_truth.db").execute("SELECT * FROM EVENT_TRUTH WHERE TAG=? ORDER BY PM_END LIMIT 1", (tag,)).fetchone()
        return self._row_truth(r) if r else None

    def run_qual(self, t: EventTruth, count: int, wait: bool, attempt: int, fixed: dict | None = None) -> dict:
        return simulate_qual(t, count, wait, attempt, fixed)

    def append_qual_history(self, t: EventTruth, attempts: list[dict], eng_id: str, memo: str, evt: datetime):
        """운영 중 완료된 Qual을 MES(QUAL_HIS·QUAL_MEAS)에 적재. Agent 쓰기 경로 아님."""
        with self._write_lock:
            con = sqlite3.connect(self.legacy_path)
            seq = (con.execute("SELECT MAX(QH_SEQ) FROM QUAL_HIS").fetchone()[0] or 100000) + 1
            n1 = attempts[0]["count"]
            final = attempts[-1]
            fail1 = ",".join(C.LEGACY_ITEM[x] for x in attempts[0]["fail_items"]) or None
            con.execute("INSERT INTO QUAL_HIS VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                seq, t.eqp_id, t.chamber, C.LEGACY_PM_CODE[t.pm_type], t.pm_end.strftime("%Y%m%d%H%M%S"),
                C.procedure_id(t.model, t.pm_type), C.recipe_id(t.model, t.pm_type, t.pm_end.date()), n1,
                "P" if attempts[0]["passed"] else "F", fail1, (final["count"] - n1) if len(attempts) > 1 else None,
                final["count"], "P" if final["passed"] else "F", len(attempts), eng_id, memo, _ts(evt), "N"))
            mt = t.pm_end
            for i, a in enumerate(attempts):
                mt = mt + timedelta(minutes=round(a["count"] * 3.6 + 60))
                for item, (v, unit) in a["measurements"].items():
                    con.execute("INSERT INTO QUAL_MEAS VALUES(?,?,?,?,?,?)", (seq, i + 1, C.LEGACY_ITEM[item], v, C.LEGACY_UNIT[unit], _ts(min(mt, evt))))
            con.commit()
            con.close()
        self._close_all()
        return seq


# ── FDC 원본 해상도 모델 (슬라이싱용) ──────────────────────────────────
FDC_RAW_HZ = 60          # 원본 트레이스 샘플링 주파수 (저장 export는 5초 간격)
FDC_EXPORT_STEP_S = 5


def _split_trace(raw: str) -> dict:
    lines = raw.splitlines()
    meta = [ln for ln in lines if ln.startswith("#")]
    body = [ln for ln in lines if not ln.startswith("#")]
    header, data = (body[0], body[1:]) if body else ("", [])
    total = (len(data) - 1) * FDC_EXPORT_STEP_S * FDC_RAW_HZ + 1 if data else 0
    return {"meta": meta, "header": header, "data": data, "sep": ";" if ";" in header else ",", "total": total}


def _ts_split(s: str):
    if "T" in s and "-" in s:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S"), "iso", s[19:]
    if "/" in s:
        return datetime.strptime(s[:19], "%Y/%m/%d %H:%M:%S"), "v3", ""
    return datetime.strptime(s[:14], "%Y%m%d%H%M%S"), "v4", ""


def _ts_join(dt: datetime, kind: str, suffix: str) -> str:
    ms = f".{dt.microsecond // 1000:03d}"
    if kind == "iso":
        return dt.strftime("%Y-%m-%dT%H:%M:%S") + ms + suffix
    if kind == "v3":
        return dt.strftime("%Y/%m/%d %H:%M:%S") + ms
    return dt.strftime("%Y%m%d%H%M%S") + ms


def _lerp(a: str, b: str, f: float) -> str:
    try:
        x, y = float(a), float(b)
    except ValueError:
        return a
    v = x + (y - x) * f
    if "e" in a.lower():
        return f"{v:.3e}"
    d = len(a.split(".")[1]) if "." in a else 0
    return f"{v:.{d}f}"


def _raw_row(t: dict, i: int) -> str:
    """원본 해상도 i번째 행 — export 표본 사이를 선형 보간 (행 번호는 0 ~ total-1)."""
    data, sep = t["data"], t["sep"]
    sec = i / FDC_RAW_HZ
    k = min(int(sec // FDC_EXPORT_STEP_S), len(data) - 1)
    f = (sec - k * FDC_EXPORT_STEP_S) / FDC_EXPORT_STEP_S
    a = data[k].split(sep)
    b = data[min(k + 1, len(data) - 1)].split(sep)
    t0, kind, suffix = _ts_split(a[0])
    vals = [a[j] if j >= len(b) else _lerp(a[j], b[j], f) for j in range(1, len(a))]
    return sep.join([_ts_join(t0 + timedelta(seconds=sec - k * FDC_EXPORT_STEP_S), kind, suffix)] + vals)
