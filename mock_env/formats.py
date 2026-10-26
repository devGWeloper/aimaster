"""장비 SW 버전별 FDC 로그 포맷 렌더러.

- v3.8  : 세미콜론 구분, 'YYYY/MM/DD hh:mm:ss', 약어 컬럼, 챔버 숫자 코드
- v4.2  : CSV, 'YYYYMMDDhhmmss', 현행 컬럼명 (STEP_NO 없음)
- v4.6  : CSV, v4.2 + STEP_NO 컬럼 (순서 변경)
- v5.2  : JSON 헤더 + 점(.) 표기 컬럼 7개 변경, ISO8601 시간(일부 장비는 타임존 미지정)
          → 장애 주입기(sw_v52)가 v4.x 원문을 실시간 변환해 재현
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

CH_NUM = {"A": "1", "B": "2", "C": "3"}


def render_trace(eqp: str, ch: str, sw: str, run_kind: str, start: datetime,
                 rows: list[dict], press_unit: str) -> str:
    """rows: [{rf_fwd, rf_refl, press, esc_temp, gas, step}] (None = 결측)"""
    def f(v, nd=2):
        if v is None:
            return ""
        if isinstance(v, float) and abs(v) < 0.01 and v != 0:
            return f"{v:.3e}"
        return f"{v:.{nd}f}" if isinstance(v, float) else str(v)

    lines: list[str] = []
    if sw.startswith("3."):
        lines.append(f"#EQP:{eqp};CH:{CH_NUM[ch]};SW:{sw};KIND:{run_kind}")
        lines.append("TIME;RFFWD;RFREF;PRES_MT;TEMP_C;GAS1")
        for i, r in enumerate(rows):
            ts = (start + timedelta(seconds=5 * i)).strftime("%Y/%m/%d %H:%M:%S")
            lines.append(";".join([ts, f(r["rf_fwd"], 1), f(r["rf_refl"]), f(r["press"]), f(r["esc_temp"], 1), f(r["gas"], 1)]))
        return "\n".join(lines)
    lines.append(f"# FDC_EXPORT v{sw}")
    lines.append(f"# EQP={eqp} CHAMBER={ch} RUN_KIND={run_kind}")
    lines.append(f"# UNIT CHM_PRESS={press_unit}")
    if sw == "4.2":
        lines.append("TIMESTAMP,RF_FWD_PWR,RF_REFL_PWR,CHM_PRESS,ESC_TEMP,GAS_FLOW_1")
    else:
        lines.append("TIMESTAMP,STEP_NO,RF_FWD_PWR,RF_REFL_PWR,CHM_PRESS,ESC_TEMP,GAS_FLOW_1")
    for i, r in enumerate(rows):
        ts = (start + timedelta(seconds=5 * i)).strftime("%Y%m%d%H%M%S")
        vals = [f(r["rf_fwd"], 1), f(r["rf_refl"]), f(r["press"], 4), f(r["esc_temp"], 1), f(r["gas"], 1)]
        if sw == "4.2":
            lines.append(",".join([ts] + vals))
        else:
            lines.append(",".join([ts, str(r["step"])] + vals))
    return "\n".join(lines)


V52_COLUMNS = ["ts", "recipe.step", "rf.forward.w", "rf.reflected.w", "chamber.pressure", "esc.temp.c", "gas.mfc1.sccm"]


def to_v52(raw: str, tz_suffix: str = "+09:00") -> str:
    """v4.x 원문을 장비 SW v5.2 포맷으로 변환 (장애 주입기용)."""
    lines = raw.splitlines()
    meta = {}
    unit = "mTorr"
    header = None
    data = []
    for ln in lines:
        if ln.startswith("# EQP="):
            for tok in ln[2:].split():
                k, _, v = tok.partition("=")
                meta[k] = v
        elif ln.startswith("# UNIT"):
            unit = ln.split("=")[-1].strip()
        elif ln.startswith("#"):
            continue
        elif header is None:
            header = ln.split(",")
        else:
            data.append(dict(zip(header, ln.split(","))))
    out = ["#" + json.dumps({"schema": "fdc.v5.2", "eqp": meta.get("EQP"), "chamber": meta.get("CHAMBER"),
                             "run_kind": meta.get("RUN_KIND"), "units": {"chamber.pressure": unit}}, ensure_ascii=False)]
    out.append(",".join(V52_COLUMNS))
    for r in data:
        t = datetime.strptime(r["TIMESTAMP"], "%Y%m%d%H%M%S").strftime("%Y-%m-%dT%H:%M:%S") + tz_suffix
        out.append(",".join([t, r.get("STEP_NO", "1"), r["RF_FWD_PWR"], r["RF_REFL_PWR"], r["CHM_PRESS"],
                             r["ESC_TEMP"], r["GAS_FLOW_1"]]))
    return "\n".join(out)


def leak_line(ts: datetime, ch: str, rate: float, base: float, stable_min: int, unit: str = "mTorr/min") -> str:
    shown = rate if unit == "mTorr/min" else rate / 1000.0
    res = "OK" if rate <= 2.0 else "NG"
    rate_s = f"{shown:.2f}" if unit == "mTorr/min" else f"{shown:.5f}"
    return (f"{ts:%Y-%m-%d %H:%M:%S} [LEAK_CHECK] CH={ch} RATE={rate_s} {unit} "
            f"BASE={base:.1E} Torr BP_STABLE_MIN={stable_min} RESULT={res}")
