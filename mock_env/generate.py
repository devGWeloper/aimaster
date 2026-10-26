"""Mock AutoQual 환경 데이터 생성기 (시드 고정, 재현 가능).

    python -m mock_env.generate

생성물 (mock_env/data/)
  spec.db          기준정보 DB  — 장비·챔버 마스터, Qual 절차, Spec(유효기간 버전), Seasoning 레시피
  legacy.db        레거시 MES DB — QUAL_HIS(약어 컬럼·미문서화 코드), QUAL_MEAS, PRT_CHG_HIS, CHB_RF_USAGE,
                   CD_DICT(부분 문서화), 폐기·백업·이관 테이블, ETL_LOAD_LOG
  fdc.db           장비 로그 — FDC 트레이스 원문(SW 버전별 포맷), Run Summary, Leak Check, 알람, PM 이벤트
  ground_truth.db  숨은 패턴·정답 (평가 하네스 전용, Agent 접근 불가)
"""
from __future__ import annotations

import json
import math
import random
import sqlite3
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from . import config as C
from .formats import leak_line, render_trace
from .simulator import EventTruth, required_count, rng_for, simulate_qual

DATA = Path(__file__).parent / "data"
DAY0 = date(2022, 11, 1)          # RF 사용시간 기록 시작 (Focus Ring 초기 사용시간 산출용)
DAYN = date(2026, 12, 31)
NDAYS = (DAYN - DAY0).days + 1

PART_CODES = ["FR01", "FR02", "FR03", "FR04", "ESC1", "ESC2", "RFG1", "RFG2", "SHD1", "TGT1", "TGT2", "TGT3",
              "PMP1", "VLV1", "ORG1", "LNR1", "EDR1", "WIN1", "CVR1", "MFC1", "HTR1", "TCP1", "BLW1"]
PART_NAMES = {"FR01": "Focus Ring (ETX-300)", "FR02": "Focus Ring (ETX-500)", "FR03": "Focus Ring 신규 공급사(ETX-300)",
              "FR04": "Focus Ring Type-B(ETX-500)", "ESC1": "ESC (ETCH)", "ESC2": "ESC (CVD)", "RFG1": "RF Generator 13.56MHz",
              "RFG2": "RF Generator 2MHz", "SHD1": "Showerhead", "TGT1": "Ti Target", "TGT2": "TiN Target", "TGT3": "Al Target",
              "PMP1": "Dry Pump", "VLV1": "Throttle Valve", "ORG1": "O-ring Kit", "LNR1": "Chamber Liner", "EDR1": "Edge Ring",
              "WIN1": "View Window", "CVR1": "Lid Cover", "MFC1": "MFC", "HTR1": "Heater", "TCP1": "Thermocouple", "BLW1": "Bellows"}
UNDOC_PARTS = {"FR03", "FR04", "EDR1", "WIN1", "CVR1", "TCP1", "BLW1", "LNR1"}   # CD_DICT 미등재 8종

PM_DURATION_H = {"WET_CLEAN": (6, 9), "RF_GEN_REPLACE": (4, 6), "ESC_REPLACE": (5, 8), "SHOWERHEAD_REPLACE": (5, 7),
                 "TARGET_REPLACE": (6, 10), "PUMP_PM": (3, 5), "QUARTERLY_PM": (8, 12), "ALARM_RECOVERY": (2, 4)}
MEAN_INTERVAL = {"ETCH": 30.8, "CVD": 32.0, "PVD": 33.0}
ALARMS = [("ALM-RF-0412", "RF Reflected Power High"), ("ALM-PRS-2201", "Chamber Pressure Deviation"),
          ("ALM-ESC-3105", "ESC He Leak High"), ("ALM-VAC-1102", "Turbo Pump Fault"),
          ("ALM-TMP-4010", "Heater Temp Deviation"), ("ALM-GAS-5203", "MFC Flow Deviation")]


def dt(d: date, h: int = 0, m: int = 0) -> datetime:
    return datetime(d.year, d.month, d.day, h, m)


def ts(x: datetime) -> str:
    return x.strftime("%Y-%m-%d %H:%M:%S")


def legacy_dt(x: datetime) -> str:
    return x.strftime("%Y%m%d%H%M%S")


class Generator:
    def __init__(self):
        self.r = random.Random(C.SEED)
        self.engineers = self._engineers()
        self.chambers = {}
        self.events: list[dict] = []
        self.truths: list[EventTruth] = []
        self.part_changes: list[dict] = []
        self.usage = {}       # cid -> list of minutes per day (true)
        self.usage_missing = {}

    # ── 엔지니어 ────────────────────────────────────────────────────
    def _engineers(self):
        r = random.Random(C.SEED + 1)
        engs = []
        groups = ["ETCH"] * 18 + ["CVD"] * 15 + ["PVD"] * 7
        for i, g in enumerate(groups):
            kind = "normal"
            x = r.random()
            if x < 0.17:
                kind = "experienced"
            elif x < 0.38:
                kind = "conservative"
            engs.append({"id": f"E{101 + i}", "group": g, "kind": kind, "night": r.random() < 0.4})
        return engs

    def pick_engineer(self, group: str, night: bool, r: random.Random):
        pool = [e for e in self.engineers if e["group"] == group and e["night"] == night] or \
               [e for e in self.engineers if e["group"] == group]
        return r.choice(pool)

    # ── 챔버 기본 특성 + 일별 RF 사용시간 ──────────────────────────────
    def build_chambers(self):
        r = self.r
        for eqp in C.ALL_EQPS:
            g = C.EQP_GROUP[eqp]
            for ch in C.CHAMBERS:
                cid = f"{eqp}-{ch}"
                st = {
                    "eqp": eqp, "ch": ch, "group": g, "model": C.EQP_MODEL[eqp],
                    "rf_rate": r.uniform(2.7, 4.0),
                    "refl": {"ETCH": r.uniform(38, 58), "CVD": r.uniform(18, 32), "PVD": r.uniform(8, 14)}[g],
                    "fwd": {"ETCH": r.uniform(1450, 1560), "CVD": r.uniform(760, 840), "PVD": r.uniform(1900, 2100)}[g],
                    "press": {"ETCH": r.uniform(28, 32), "CVD": r.uniform(2400, 2600), "PVD": r.uniform(3.2e-3, 3.8e-3)}[g],
                    "temp": {"ETCH": 45.0, "CVD": 400.0, "PVD": 25.0}[g],
                    "gas": {"ETCH": 200.0, "CVD": 1500.0, "PVD": 40.0}[g],
                }
                self.chambers[cid] = st
                mins, missing = [], set()
                for i in range(NDAYS):
                    v = max(0, round(r.gauss(st["rf_rate"] * 60, 32)))
                    mins.append(v)
                    if r.random() < 0.015:
                        missing.add(i)
                self.usage[cid] = mins
                self.usage_missing[cid] = missing
        # 누적합
        self.cum = {}
        for cid, mins in self.usage.items():
            acc, s = [], 0
            for v in mins:
                s += v
                acc.append(s)
            self.cum[cid] = acc

    def rf_hours_between(self, cid: str, d0: date, d1: date) -> float:
        i0 = max(0, (d0 - DAY0).days)
        i1 = min(NDAYS - 1, (d1 - DAY0).days - 1)
        if i1 < i0:
            return 0.0
        c = self.cum[cid]
        return (c[i1] - (c[i0 - 1] if i0 > 0 else 0)) / 60.0

    # ── PM 일정 ─────────────────────────────────────────────────────
    def build_schedule(self):
        r = self.r
        evs = []
        for cid, st in self.chambers.items():
            g = st["group"]
            t = C.HIST_START + timedelta(days=r.randint(0, 25))
            while t <= C.OPS_END:
                evs.append(self._new_event(cid, t, r))
                gap = max(5.0, r.gammavariate(4.0, MEAN_INTERVAL[g] / 4.0))
                t = t + timedelta(days=round(gap))
        self.events = evs
        self._plant()
        self._trim_to_target()
        self.events.sort(key=lambda e: (e["pm_end"], e["cid"]))

    def _new_event(self, cid, d: date, r, pm=None, hour=None, minute=None, plant=None):
        st = self.chambers[cid]
        if pm is None:
            w = C.PM_WEIGHTS[st["group"]]
            pm = r.choices(list(w), weights=list(w.values()))[0]
        if hour is None:
            hour = r.randint(8, 19) if r.random() < 0.6 else r.choice([20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7])
        if minute is None:
            minute = r.choice([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
        end = dt(d, hour, minute)
        lo, hi = PM_DURATION_H[pm]
        start = end - timedelta(minutes=round(r.uniform(lo, hi) * 60))
        return {"cid": cid, "pm_type": pm, "pm_start": start, "pm_end": end, "plant": plant or {}}

    def _plant(self):
        """시나리오에 쓰이는 사건을 명시적으로 심는다 (나머지는 랜덤 생성)."""
        r = random.Random(C.SEED + 7)
        win0, win1 = date(2025, 3, 1), date(2026, 9, 20)
        # SC-001: ETCH-07-B 최근 8회 Wet Clean 이력(25매 2/4, 35매 4/4) + 2026-09-03 AutoQual
        self.events = [e for e in self.events if not (e["cid"] == "ETCH-07-B" and win0 <= e["pm_end"].date() <= win1)]
        plan = [  # (date, hour, rf, N1, fr_replace, engineer kind)
            (date(2025, 3, 18), 14, 3.2, 25, True), (date(2025, 5, 27), 10, 13.1, 25, False),
            (date(2025, 8, 5), 15, 12.5, 35, True), (date(2025, 10, 14), 9, 5.0, 25, False),
            (date(2025, 12, 9), 16, 11.4, 25, True), (date(2026, 2, 17), 11, 14.0, 35, False),
            (date(2026, 4, 21), 13, 4.1, 35, True), (date(2026, 7, 7), 10, 11.0, 35, True),
        ]
        for d, h, rf, n1, frr in plan:
            self.events.append(self._new_event("ETCH-07-B", d, r, "WET_CLEAN", h, 20, plant={
                "rf": rf, "noise": 0, "random_fail": False, "bp": 13, "N1": n1, "wait": True,
                "fr_replace": frr, "tag": "SC-001-history"}))
        for d, pm in [(date(2025, 4, 22), "PUMP_PM"), (date(2025, 6, 30), "ALARM_RECOVERY"), (date(2025, 9, 16), "QUARTERLY_PM"),
                      (date(2025, 11, 11), "ALARM_RECOVERY"), (date(2026, 1, 13), "PUMP_PM"), (date(2026, 3, 24), "ESC_REPLACE"),
                      (date(2026, 5, 26), "ALARM_RECOVERY"), (date(2026, 8, 11), "PUMP_PM")]:
            self.events.append(self._new_event("ETCH-07-B", d, r, pm, plant={"fr_replace": False, "fr_block": True}))
        self.events.append(self._new_event("ETCH-07-B", date(2026, 9, 3), r, "WET_CLEAN", 9, 40, plant={
            "rf": 12.0, "noise": 0, "random_fail": False, "bp": 14, "leak": 0.8, "fr_replace": False,
            "tag": "SC-001", "no_alarm": True}))
        # SC-003: CVD-12-A RF Generator 교체 (장비 SW v5.2 포맷 변경)
        self._replace_near("CVD-12-A", date(2026, 9, 17), "RF_GEN_REPLACE", 10, 20,
                           {"rf": 1.2, "noise": 0, "random_fail": False, "bp": 12, "tag": "SC-003"}, r)
        # SC-005: PVD-03-C Target 교체
        self._replace_near("PVD-03-C", date(2026, 11, 14), "TARGET_REPLACE", 14, 30,
                           {"noise": 0, "random_fail": False, "bp": 11, "tag": "SC-005"}, r)
        # SC-007 이후 다음 요청: ETCH-05-A Wet Clean (RF +13%, Focus Ring ~720h)
        self._replace_near("ETCH-05-A", date(2026, 10, 22), "WET_CLEAN", 13, 10,
                           {"rf": 13.0, "noise": 0, "random_fail": False, "bp": 12, "fr_target": 720, "tag": "SC-007-next"}, r)
        # SC-007 재료: 운영 7주간 ETX-300 Wet Clean 건 보강
        etx300 = [f"ETCH-{i:02d}-{c}" for i in range(1, 9) for c in "ABC" if f"ETCH-{i:02d}-{c}" not in ("ETCH-07-B", "ETCH-05-A")]
        days = [date(2026, 9, 1) + timedelta(days=k) for k in range(0, 48)]
        fr_targets = [650, 700, 760, 820, 610, 680, 900, 640, None, None, None, None, None]
        for k, frt in enumerate(fr_targets):
            cid = etx300[(k * 5 + 3) % len(etx300)]
            plant = {"tag": "SC-007-ops"}
            if frt:
                plant["fr_target"] = frt
            self._replace_near(cid, days[(k * 7 + 2) % len(days)], "WET_CLEAN", None, None, plant, r)
        # SC-009: PVD-02-B PM 사이클 간 drift 요청 대상
        self._replace_near("PVD-02-B", date(2026, 12, 10), "QUARTERLY_PM", 18, 0, {"tag": "SC-009"}, r)

    def _replace_near(self, cid, d, pm, hour, minute, plant, r):
        self.events = [e for e in self.events if not (e["cid"] == cid and abs((e["pm_end"].date() - d).days) < 6)]
        self.events.append(self._new_event(cid, d, r, pm, hour, minute, plant=plant))

    def _trim_to_target(self):
        r = random.Random(C.SEED + 11)
        def in_window(e):
            d = e["pm_end"].date()
            return C.HIST_START <= d <= C.REPLAY_END and not (C.MIGRATION_GAP[0] <= d <= C.MIGRATION_GAP[1])
        win = [e for e in self.events if in_window(e)]
        excess = len(win) - C.REPLAY_CASES
        if excess < 0:
            raise RuntimeError(f"이벤트 부족: {len(win)}")
        removable = [e for e in win if not e["plant"]]
        drop = set(id(e) for e in r.sample(removable, excess))
        self.events = [e for e in self.events if id(e) not in drop]

    # ── 사건 처리: 잠재 특성, 부품 교체, ground truth ───────────────────
    def process(self):
        by_cid = defaultdict(list)
        for e in self.events:
            by_cid[e["cid"]].append(e)
        lot_seq = defaultdict(int)
        special_lot_left = 5
        for cid, evs in by_cid.items():
            evs.sort(key=lambda e: e["pm_end"])
            st = self.chambers[cid]
            r = rng_for("chamber", cid)
            g, model = st["group"], st["model"]
            fr_install = DAY0 + timedelta(days=r.randint(0, 200))
            fr_life = r.uniform(560, 1100)
            last_wc = DAY0 + timedelta(days=r.randint(150, 240))
            # Focus Ring 목표 사용시간을 맞춰야 하는 사건 (SC-007-next)
            target = next((e for e in evs if e["plant"].get("fr_target")), None)
            force_day = None
            if target:
                want = target["plant"]["fr_target"]
                cands = [e for e in evs if e["pm_end"] < target["pm_end"] and e["pm_type"] in ("WET_CLEAN", "QUARTERLY_PM")]
                best = min(cands, key=lambda e: abs(self.rf_hours_between(cid, e["pm_end"].date(), target["pm_end"].date()) - want))
                best["plant"]["fr_replace"] = True
                force_day = best["pm_end"]
                for e in evs:
                    if force_day < e["pm_end"] <= target["pm_end"] and e is not best:
                        e["plant"]["fr_replace"] = False
            for idx, e in enumerate(evs):
                p = e["plant"]
                er = rng_for("event", cid, e["pm_end"].isoformat())
                d = e["pm_end"].date()
                pm = e["pm_type"]
                eid = f"EV-{cid}-{e['pm_end']:%y%m%d%H%M}"
                parts = []
                fr_hours = None
                fr_replaced = False
                if g == "ETCH":
                    hours = self.rf_hours_between(cid, fr_install, d)
                    want_replace = None
                    if pm in ("WET_CLEAN", "QUARTERLY_PM"):
                        want_replace = (hours > fr_life and er.random() < 0.6) or er.random() < 0.05
                    if "fr_replace" in p:
                        want_replace = p["fr_replace"] and pm in ("WET_CLEAN", "QUARTERLY_PM")
                    if want_replace:
                        code = "FR01" if model == "ETX-300" else "FR02"
                        if model == "ETX-300" and d >= date(2025, 1, 1) and er.random() < 0.35:
                            code = "FR03"
                        if model == "ETX-500" and d >= date(2025, 6, 1) and er.random() < 0.4:
                            code = "FR04"
                        lot_seq[d.strftime("%y%m")] += 1
                        lot = f"FRL-{d:%y%m}-{100 + lot_seq[d.strftime('%y%m')]:03d}"
                        if code == "FR01" and date(2024, 8, 15) <= d <= date(2025, 2, 28) and special_lot_left > 0:
                            lot = "FRL-2408-117"
                            special_lot_left -= 1
                        parts.append({"code": code, "lot": lot, "removed_min": round(hours * 60)})
                        fr_install, fr_life, fr_replaced = d, er.uniform(560, 1100), True
                        fr_hours = 0.0
                    else:
                        fr_hours = round(hours, 1)
                cycle = round(self.rf_hours_between(cid, last_wc, d), 1)
                if pm == "WET_CLEAN":
                    last_wc = d
                parts += self._other_parts(model, g, pm, d, er, lot_seq)
                # 잠재 특성
                if "rf" in p:
                    rf = p["rf"]
                elif model == "ETX-300" and pm == "WET_CLEAN":
                    rf = er.uniform(10.2, 19.0) if er.random() < 0.33 else max(-4, min(9.6, er.gauss(3.0, 2.6)))
                elif model == "ETX-500" and pm == "WET_CLEAN":
                    rf = er.uniform(10.0, 16.0) if er.random() < 0.2 else max(-4, min(9.6, er.gauss(3.0, 2.5)))
                elif pm == "RF_GEN_REPLACE":
                    rf = max(-4, min(16, er.gauss(4.0, 3.5)))
                else:
                    rf = er.uniform(10, 14) if er.random() < 0.03 else max(-4, min(9.6, er.gauss(2.0, 2.2)))
                humid = d.month in (7, 8)
                if "bp" in p:
                    bp = p["bp"]
                elif humid:
                    bp = er.randint(26, 46) if er.random() < 0.75 else er.randint(9, 22)
                else:
                    bp = er.randint(25, 35) if er.random() < 0.04 else er.randint(8, 21)
                leak = p.get("leak") or (round(max(0.15, min(0.85, er.gauss(0.45, 0.12))), 2) if g == "PVD"
                                         else round(max(0.25, min(1.75, er.gauss(0.8, 0.25))), 2))
                t = EventTruth(
                    event_id=eid, eqp_id=st["eqp"], chamber=st["ch"], model=model, group=g, pm_type=pm,
                    pm_start=e["pm_start"], pm_end=e["pm_end"], recipe=C.recipe_rev(d), rf_refl_delta=round(rf, 1),
                    fr_hours=fr_hours, cycle_rf_hours=cycle, humid=humid, bp_stable_min=bp, leak_rate=leak,
                    random_fail=p.get("random_fail", er.random() < 0.04),
                    noise=p.get("noise", round(er.gauss(0, C.NOISE_SD))), fr_replaced=fr_replaced, parts=parts)
                t.R, t.effects = required_count(t)
                e["truth"] = t
                e["eid"] = eid
                for pt in parts:
                    self.part_changes.append({"eqp": st["eqp"], "ch": st["ch"], "cid": cid, "code": pt["code"],
                                              "lot": pt["lot"], "removed_min": pt["removed_min"], "dt": e["pm_end"]})

    def _other_parts(self, model, g, pm, d, r, lot_seq):
        codes = []
        if pm == "ESC_REPLACE":
            codes.append("ESC1" if g == "ETCH" else "ESC2")
        elif pm == "RF_GEN_REPLACE":
            codes.append("RFG1" if r.random() < 0.7 else "RFG2")
        elif pm == "SHOWERHEAD_REPLACE":
            codes.append("SHD1")
        elif pm == "TARGET_REPLACE":
            codes.append(r.choice(["TGT1", "TGT2", "TGT3"]))
        elif pm == "PUMP_PM":
            codes.append("PMP1")
            if g == "PVD" and r.random() < 0.5:
                codes.append("BLW1")
            if r.random() < 0.3:
                codes.append("VLV1")
        elif pm == "QUARTERLY_PM":
            codes += ["ORG1", "LNR1"] + (["EDR1"] if g == "ETCH" and r.random() < 0.5 else [])
        elif pm == "WET_CLEAN":
            if r.random() < 0.6:
                codes.append("ORG1")
            if r.random() < 0.15:
                codes.append("WIN1")
            if r.random() < 0.1:
                codes.append("CVR1")
        elif pm == "ALARM_RECOVERY" and r.random() < 0.3:
            codes.append(r.choice(["MFC1", "HTR1", "TCP1", "VLV1"]))
        out = []
        for c in codes:
            lot_seq[d.strftime("%y%m")] += 1
            out.append({"code": c, "lot": f"{c[:2]}L-{d:%y%m}-{100 + lot_seq[d.strftime('%y%m')]:03d}",
                        "removed_min": round(r.uniform(300, 9000) * 60)})
        return out

    # ── 과거 Qual 결과 (엔지니어 행동 모델) ──────────────────────────────
    def history_outcomes(self):
        for e in self.events:
            t: EventTruth = e["truth"]
            if t.pm_end.date() > C.HIST_END:
                continue
            p = e["plant"]
            r = rng_for("eng", t.event_id)
            night = t.pm_end.hour >= 20 or t.pm_end.hour < 8
            eng = self.pick_engineer(t.group, night, r)
            exp, cons = eng["kind"] == "experienced", eng["kind"] == "conservative"
            d = t.pm_end.date()
            base = C.base_count(t.model, t.pm_type, d)
            n1 = base
            if (t.model, t.pm_type) == ("ETX-500", "WET_CLEAN"):
                if (exp and r.random() < 0.6) or r.random() < 0.18:
                    n1 = 30
                if exp and r.random() < 0.2:
                    n1 = 25
            if t.model == "ETX-300" and t.pm_type == "WET_CLEAN" and t.rf_refl_delta >= 10:
                if (exp and r.random() < 0.75) or r.random() < 0.28:
                    n1 += 10
            if t.group == "ETCH" and t.pm_type in ("WET_CLEAN", "QUARTERLY_PM") and (t.fr_hours or 0) >= 600:
                if exp and r.random() < 0.35:
                    n1 += 10
            if (t.model, t.pm_type) == ("CVX-200", "SHOWERHEAD_REPLACE") and t.recipe == "R1" and ((exp and r.random() < 0.6) or r.random() < 0.2):
                n1 += 5
            if (t.model, t.pm_type) == ("PVX-100", "TARGET_REPLACE") and ((exp and r.random() < 0.6) or r.random() < 0.2):
                n1 += 5
            if t.group == "ETCH" and t.pm_type == "ESC_REPLACE" and ((exp and r.random() < 0.55) or r.random() < 0.15):
                n1 += 5
            if (t.model, t.pm_type) == ("CVX-200", "QUARTERLY_PM") and t.recipe == "R2" and ((exp and r.random() < 0.5) or r.random() < 0.15):
                n1 += 5
            if t.effects.get("cvd_cycle") and ((exp and r.random() < 0.4) or r.random() < 0.12):
                n1 += 5
            if cons and r.random() < 0.45:
                n1 += r.choice([5, 5, 10])
            if night and r.random() < 0.2:
                n1 += 5
            wait = (t.bp_stable_min >= 25 or t.humid) and ((exp and r.random() < 0.65) or r.random() < 0.12)
            if "N1" in p:
                n1 = p["N1"]
            if "wait" in p:
                wait = p["wait"]
            attempts = []
            count, w = n1, wait
            for a in range(1, 4):
                res = simulate_qual(t, count, w, a)
                attempts.append(res)
                if res["passed"]:
                    break
                fi = set(res["fail_items"])
                if fi & {"ER", "ER_UNIF", "DR", "THK_UNIF", "RS_UNIF"}:
                    count += 10 if r.random() < 0.75 else 5
                elif fi & {"LEAK_RATE", "BASE_PRESSURE"}:
                    w = True
                else:
                    count += 5
            e["hist"] = {"eng": eng, "n1": n1, "wait": wait, "attempts": attempts, "night": night}

    # ── 메모 ────────────────────────────────────────────────────────
    @staticmethod
    def memo(h, r) -> str:
        a = h["attempts"]
        bits = []
        if h["wait"]:
            bits.append(r.choice(["BP 안정화 30분 대기 후 진행", "Leak 후 30분 대기", "BP 안정화 대기(30m)"]))
        if a[0]["passed"]:
            bits.append(r.choice(["1차 PASS", "PASS", "Qual 정상 완료", "특이사항 없음", "1차 OK"]))
            return ". ".join(bits) if r.random() > 0.15 else ""
        for i, x in enumerate(a):
            if x["passed"]:
                bits.append(f"{i + 1}차 PASS")
                break
            fi = x["fail_items"]
            m = x["measurements"]
            desc = []
            for it in fi:
                v = m[it][0]
                nm = {"ER_UNIF": "ER Unif", "PARTICLE": "Particle", "LEAK_RATE": "Leak", "ER": "ER", "DR": "DR",
                      "THK_UNIF": "THK Unif", "RS_UNIF": "Rs Unif", "BASE_PRESSURE": "BP"}[it]
                desc.append(f"{nm} {v}")
            nxt = a[i + 1]["count"] - x["count"] if i + 1 < len(a) else 0
            act = f"SSN +{nxt}매" if nxt else ("BP 대기 후 재측정" if set(fi) & {"LEAK_RATE", "BASE_PRESSURE"} else "Purge 후 재측정")
            bits.append(f"{i + 1}차 NG({', '.join(desc)}) → {act}" if i + 1 < len(a) else f"{i + 1}차 NG({', '.join(desc)}) → 엔지니어 에스컬레이션")
        return ". ".join(bits)

    # ── DB 쓰기 ──────────────────────────────────────────────────────
    def write_all(self):
        DATA.mkdir(parents=True, exist_ok=True)
        for f in ("spec.db", "legacy.db", "fdc.db", "ground_truth.db"):
            p = DATA / f
            if p.exists():
                p.unlink()
        self.write_spec()
        self.write_fdc()
        self.write_legacy()
        self.write_truth()

    def write_spec(self):
        con = sqlite3.connect(DATA / "spec.db")
        c = con.cursor()
        c.executescript("""
        CREATE TABLE EQP_MASTER(EQP_ID TEXT PRIMARY KEY, EQP_MODEL TEXT, EQP_GROUP TEXT, LINE TEXT, INSTALL_DT TEXT);
        CREATE TABLE CHAMBER_MASTER(CHAMBER_ID TEXT PRIMARY KEY, EQP_ID TEXT, CH_POS TEXT, CH_TYPE TEXT);
        CREATE TABLE QUAL_PROCEDURE(PROCEDURE_ID TEXT, EQP_MODEL TEXT, PM_TYPE TEXT, REVISION TEXT, STEPS_JSON TEXT, VALID_FROM TEXT, VALID_TO TEXT);
        CREATE TABLE QUAL_SPEC(PROCEDURE_ID TEXT, ITEM TEXT, LOWER REAL, UPPER REAL, UNIT TEXT, INCLUSIVE INTEGER, VALID_FROM TEXT, VALID_TO TEXT);
        CREATE TABLE SEASONING_RECIPE(RECIPE_ID TEXT, EQP_MODEL TEXT, PM_TYPE TEXT, BASE_COUNT INTEGER, RECIPE_REV TEXT, VALID_FROM TEXT, VALID_TO TEXT);
        CREATE TABLE UNIT_CONV(FROM_UNIT TEXT, TO_UNIT TEXT, FACTOR REAL);
        """)
        lines = {"ETCH": "FAB-M1 / ETCH Bay", "CVD": "FAB-M1 / CVD Bay", "PVD": "FAB-M1 / PVD Bay"}
        r = random.Random(C.SEED + 3)
        for eqp in C.ALL_EQPS:
            m = C.EQP_MODEL[eqp]
            c.execute("INSERT INTO EQP_MASTER VALUES(?,?,?,?,?)", (eqp, m, C.EQP_GROUP[eqp], lines[C.EQP_GROUP[eqp]],
                                                                    f"20{r.randint(18, 22)}-{r.randint(1, 12):02d}-01"))
            for ch in C.CHAMBERS:
                c.execute("INSERT INTO CHAMBER_MASTER VALUES(?,?,?,?)", (f"{eqp}-{ch}", eqp, ch, "PROCESS"))
        for m, info in C.MODELS.items():
            g = info["group"]
            for pm in C.BASE_SEASONING[m]:
                pid = C.procedure_id(m, pm)
                steps = list(C.PROCEDURE_STEPS[g])
                c.execute("INSERT INTO QUAL_PROCEDURE VALUES(?,?,?,?,?,?,?)",
                          (pid, m, pm, pid[-2:], json.dumps(steps, ensure_ascii=False), "2019-01-01", None))
                specs_old = C.spec_items(m, date(2024, 1, 1))
                specs_new = C.spec_items(m, date(2026, 1, 1))
                for so, sn in zip(specs_old, specs_new):
                    if so != sn:
                        c.execute("INSERT INTO QUAL_SPEC VALUES(?,?,?,?,?,?,?,?)", (pid, so["item"], so["lower"], so["upper"], so["unit"], 1, "2019-01-01", "2025-03-31"))
                        c.execute("INSERT INTO QUAL_SPEC VALUES(?,?,?,?,?,?,?,?)", (pid, sn["item"], sn["lower"], sn["upper"], sn["unit"], 1, "2025-04-01", None))
                    else:
                        c.execute("INSERT INTO QUAL_SPEC VALUES(?,?,?,?,?,?,?,?)", (pid, sn["item"], sn["lower"], sn["upper"], sn["unit"], 1, "2019-01-01", None))
                r1, r2 = C.BASE_SEASONING[m][pm]
                short = f"SSN-{info['short']}-{C.PM_TYPES[pm]['short']}"
                c.execute("INSERT INTO SEASONING_RECIPE VALUES(?,?,?,?,?,?,?)", (f"{short}-R1", m, pm, r1, "R1", "2019-01-01", "2024-09-30"))
                c.execute("INSERT INTO SEASONING_RECIPE VALUES(?,?,?,?,?,?,?)", (f"{short}-R2", m, pm, r2, "R2", "2024-10-01", None))
        for row in [("nm/min", "A/min", 10.0), ("A/min", "nm/min", 0.1), ("Torr", "mTorr", 1000.0), ("mTorr", "Torr", 0.001),
                    ("Torr/min", "mTorr/min", 1000.0), ("mTorr/min", "Torr/min", 0.001), ("um/min", "A/min", 10000.0)]:
            c.execute("INSERT INTO UNIT_CONV VALUES(?,?,?)", row)
        con.commit()
        con.close()

    def _trace_rows(self, st, kind, delta, r, spike, base_scale=1.0):
        g = st["group"]
        rows = []
        refl0 = st["refl"] * base_scale
        n = 20
        pvd_idle = 5 if (g == "PVD" and kind == "POST_PM") else 0
        spike_at = r.randrange(n) if spike else -1
        for i in range(n):
            if i < pvd_idle:
                rows.append({"rf_fwd": 0.0, "rf_refl": 0.0, "press": float(f"{r.uniform(1.6e-7, 4.4e-7):.2e}"),
                             "esc_temp": st["temp"] + r.gauss(0, 0.2), "gas": 0.0, "step": 0})
                continue
            j = i - pvd_idle
            ramp = 0.62 if j == 0 else (0.95 if j == 1 else 1.0)
            fwd = st["fwd"] * ramp * (1 + r.gauss(0, 0.003))
            if kind == "POST_PM":
                k = delta * (1.0 if j < 6 else 0.3 + 0.7 * math.exp(-(j - 6) / 2.5))
                refl = refl0 * (1 + k / 100) * (1 + r.gauss(0, 0.009))
            else:
                refl = refl0 * (1 + r.gauss(0, 0.009))
            if i == spike_at:
                refl *= 1.5
            press = st["press"] * (1 + r.gauss(0, 0.01))
            row = {"rf_fwd": round(fwd, 1), "rf_refl": round(refl, 2), "press": press if g == "PVD" else round(press, 2),
                   "esc_temp": round(st["temp"] + r.gauss(0, 0.25), 1), "gas": round(st["gas"] * (1 + r.gauss(0, 0.004)), 1),
                   "step": 1 if j < 10 else 2}
            for key in ("rf_refl", "press", "esc_temp"):
                if r.random() < 0.01:
                    row[key] = None
            rows.append(row)
        return rows

    @staticmethod
    def _summary(rows, g):
        on = [x for x in rows if x["rf_fwd"] and x["rf_fwd"] > 50]
        stable = [x for x in on[2:]] or on
        refl = [x["rf_refl"] for x in on if x["rf_refl"] is not None]
        init = sorted(refl[:6])
        med = init[len(init) // 2] if init else None
        press = [x["press"] for x in rows if x["press"] is not None]
        return {"rf_fwd_mean": round(sum(x["rf_fwd"] for x in stable) / max(1, len(stable)), 2),
                "rf_refl_init": med, "rf_refl_mean": round(sum(refl) / max(1, len(refl)), 3),
                "press_mean": sum(press) / len(press), "press_min": min(press), "rf_on_sec": 5 * len(on)}

    def write_fdc(self):
        con = sqlite3.connect(DATA / "fdc.db")
        c = con.cursor()
        c.executescript("""
        CREATE TABLE FDC_TRACE(TRACE_ID INTEGER PRIMARY KEY, EQP_ID TEXT, CHAMBER_ID TEXT, RUN_TS TEXT, RUN_KIND TEXT, SW_VERSION TEXT, RAW TEXT);
        CREATE TABLE FDC_RUN_SUMMARY(TRACE_ID INTEGER, EQP_ID TEXT, CHAMBER_ID TEXT, RUN_TS TEXT, RUN_KIND TEXT, RF_FWD_MEAN REAL, RF_REFL_INIT REAL,
                                     RF_REFL_MEAN REAL, PRESS_MEAN REAL, PRESS_MIN REAL, PRESS_UNIT TEXT, RF_ON_SEC INTEGER, COLLECTED INTEGER);
        CREATE TABLE LEAK_LOG(EQP_ID TEXT, CHAMBER_ID TEXT, TS TEXT, RAW TEXT);
        CREATE TABLE ALARM_LOG(EQP_ID TEXT, CHAMBER_ID TEXT, TS TEXT, ALARM_CODE TEXT, MESSAGE TEXT, SEVERITY TEXT);
        CREATE TABLE PM_EVENT(PM_ID TEXT, EQP_ID TEXT, CHAMBER_ID TEXT, PM_TYPE TEXT, PM_START TEXT, PM_END TEXT, PARTS TEXT, WORKER TEXT, NOTE TEXT);
        """)
        tid = 0
        for e in self.events:
            t: EventTruth = e["truth"]
            st = self.chambers[e["cid"]]
            r = rng_for("fdc", t.event_id)
            d = t.pm_end.date()
            sw = C.sw_version(t.eqp_id, d)
            unit = "Torr" if st["group"] == "PVD" else "mTorr"
            drift = 1 + 0.05 * math.sin((d - DAY0).days / 97.0) + r.gauss(0, 0.01)
            runs = [("PROD", t.pm_start - timedelta(hours=5, minutes=r.randint(0, 40)), 0.0, drift * (1 + r.gauss(0, 0.012))),
                    ("PROD", t.pm_start - timedelta(hours=2, minutes=r.randint(0, 40)), 0.0, drift * (1 + r.gauss(0, 0.012))),
                    ("POST_PM", t.pm_end - timedelta(minutes=15), t.rf_refl_delta, drift)]
            missing_post = r.random() < 0.02 and not e["plant"].get("tag")
            for kind, start, delta, scale in runs:
                tid += 1
                spike = r.random() < 0.05 and not e["plant"].get("tag")
                rows = self._trace_rows(st, kind, delta, r, spike, scale)
                s = self._summary(rows, st["group"])
                collected = not (kind == "POST_PM" and missing_post)
                if collected:
                    raw = render_trace(t.eqp_id, t.chamber, sw, kind, start, rows, unit)
                    c.execute("INSERT INTO FDC_TRACE VALUES(?,?,?,?,?,?,?)", (tid, t.eqp_id, e["cid"], ts(start), kind, sw, raw))
                c.execute("INSERT INTO FDC_RUN_SUMMARY VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (tid, t.eqp_id, e["cid"], ts(start), kind, s["rf_fwd_mean"], s["rf_refl_init"], s["rf_refl_mean"],
                           s["press_mean"], s["press_min"], unit, s["rf_on_sec"], int(collected)))
            base = r.uniform(1.6e-7, 4.4e-7) if st["group"] == "PVD" else r.uniform(1.2e-6, 2.8e-6)
            c.execute("INSERT INTO LEAK_LOG VALUES(?,?,?,?)", (t.eqp_id, e["cid"], ts(t.pm_end - timedelta(minutes=30)),
                                                              leak_line(t.pm_end - timedelta(minutes=30), t.chamber, t.leak_rate, base, t.bp_stable_min)))
            if t.pm_type == "ALARM_RECOVERY":
                code, msg = r.choice(ALARMS)
                c.execute("INSERT INTO ALARM_LOG VALUES(?,?,?,?,?,?)", (t.eqp_id, e["cid"], ts(t.pm_start - timedelta(minutes=r.randint(5, 50))), code, msg, "ALARM"))
            if not e["plant"].get("no_alarm"):
                if t.rf_refl_delta >= 10 and r.random() < 0.3:
                    c.execute("INSERT INTO ALARM_LOG VALUES(?,?,?,?,?,?)", (t.eqp_id, e["cid"], ts(t.pm_end - timedelta(minutes=12)), "ALM-RF-0412", "RF Reflected Power High", "WARN"))
                elif r.random() < 0.05:
                    code, msg = r.choice(ALARMS[1:])
                    c.execute("INSERT INTO ALARM_LOG VALUES(?,?,?,?,?,?)", (t.eqp_id, e["cid"], ts(t.pm_end - timedelta(minutes=r.randint(5, 25))), code, msg, "WARN"))
            parts = ",".join(p["code"] for p in t.parts)
            worker = e.get("hist", {}).get("eng", {}).get("id") or self.pick_engineer(t.group, False, r)["id"]
            c.execute("INSERT INTO PM_EVENT VALUES(?,?,?,?,?,?,?,?,?)", (f"PM-{t.pm_end:%y%m%d}-{tid:05d}", t.eqp_id, e["cid"], t.pm_type,
                                                                        ts(t.pm_start), ts(t.pm_end), parts, worker, ""))
        # 생산 중 일반 알람 (배경 잡음)
        r = random.Random(C.SEED + 21)
        day = C.HIST_START
        while day <= C.OPS_END:
            for _ in range(r.randint(0, 3)):
                cid = r.choice(list(self.chambers))
                code, msg = r.choice(ALARMS)
                c.execute("INSERT INTO ALARM_LOG VALUES(?,?,?,?,?,?)", (cid.rsplit("-", 1)[0], cid, ts(dt(day, r.randint(0, 23), r.randint(0, 59))), code, msg, r.choice(["WARN", "WARN", "INFO"])))
            day += timedelta(days=1)
        c.executescript("""
        CREATE INDEX IX_TRACE ON FDC_TRACE(CHAMBER_ID, RUN_TS);
        CREATE INDEX IX_SUM ON FDC_RUN_SUMMARY(CHAMBER_ID, RUN_TS);
        CREATE INDEX IX_LEAK ON LEAK_LOG(CHAMBER_ID, TS);
        CREATE INDEX IX_ALM ON ALARM_LOG(CHAMBER_ID, TS);
        CREATE INDEX IX_PM ON PM_EVENT(CHAMBER_ID, PM_END);
        """)
        con.commit()
        con.close()

    def write_legacy(self):
        con = sqlite3.connect(DATA / "legacy.db")
        c = con.cursor()
        c.executescript("""
        CREATE TABLE QUAL_HIS(QH_SEQ INTEGER PRIMARY KEY, EQP_ID TEXT, CHB_ID TEXT, PM_TP_CD TEXT, PM_END_DT TEXT, PROC_ID TEXT,
            SSN_RCP_ID TEXT, SSN_CNT_1 INTEGER, Q1_RSLT_CD TEXT, Q1_FAIL_ITM TEXT, RWK_SSN_CNT INTEGER, SSN_CNT_FNL INTEGER,
            QF_RSLT_CD TEXT, Q_CNT INTEGER, ENG_ID TEXT, ACT_MEMO TEXT, EVT_TS TEXT, DEL_YN TEXT);
        CREATE TABLE QUAL_MEAS(QH_SEQ INTEGER, MEAS_SEQ INTEGER, ITM_CD TEXT, MEAS_VAL REAL, UNIT_CD TEXT, REG_DT TEXT);
        CREATE TABLE PRT_CHG_HIS(PC_SEQ INTEGER PRIMARY KEY, EQP_ID TEXT, CHB_ID TEXT, PRT_CD TEXT, CHG_DT TEXT, PRT_LOT_NO TEXT,
            RMV_USE_MIN INTEGER, EVT_TS TEXT);
        CREATE TABLE CHB_RF_USAGE(EQP_ID TEXT, CHB_ID TEXT, YMD TEXT, RF_ON_MIN INTEGER, EVT_TS TEXT);
        CREATE TABLE CD_DICT(CD_GRP TEXT, CD_VAL TEXT, CD_NM TEXT, VALID_FROM TEXT, VALID_TO TEXT);
        CREATE TABLE ETL_LOAD_LOG(TBL_NM TEXT, LAST_LOAD_TS TEXT, ROW_CNT INTEGER, NOTE TEXT);
        CREATE TABLE QUAL_HIS_OLD(SEQ INTEGER, EQUIP TEXT, CHAMBER TEXT, PMTYPE TEXT, PMDATE TEXT, SEASON_QTY INTEGER, RESULT TEXT, WORKER TEXT);
        CREATE TABLE TMP_QH_BAK_0312(QH_SEQ INTEGER, EQP_ID TEXT, CHB_ID TEXT, PM_TP_CD TEXT, PM_END_DT TEXT, SSN_CNT_1 INTEGER,
            Q1_RSLT_CD TEXT, SSN_CNT_FNL INTEGER, ENG_ID TEXT);
        CREATE TABLE QL_HIS_NEW(QUAL_SEQ INTEGER, EQUIP_ID TEXT, CHAMBER_ID TEXT, PM_TYPE_CD TEXT, PM_END_TS TEXT, SSN_QTY_1ST INTEGER,
            RSLT_1ST TEXT, SSN_QTY_FINAL INTEGER, RSLT_FINAL TEXT, EVT_TS TEXT);
        """)
        r = random.Random(C.SEED + 5)
        seq = 100000
        hist_rows = []
        for e in self.events:
            t: EventTruth = e["truth"]
            d = t.pm_end.date()
            if "hist" not in e:
                continue
            if C.MIGRATION_GAP[0] <= d <= C.MIGRATION_GAP[1]:
                e["split"] = "gap"
                continue
            h = e["hist"]
            seq += 1
            e["qh_seq"] = seq
            chb = t.chamber if d >= C.LEGACY_CODE_SWITCH else {"A": "1", "B": "2", "C": "3"}[t.chamber]
            pmc = C.LEGACY_PM_CODE[t.pm_type]
            if t.pm_type == "WET_CLEAN" and d <= C.PM_CODE_W0_UNTIL:
                pmc = "W0"
            a = h["attempts"]
            n1 = h["n1"]
            n1_rec = n1 * 10 if r.random() < 0.003 else n1          # 오기록 (350매 등)
            fail1 = ",".join(C.LEGACY_ITEM[x] for x in a[0]["fail_items"]) or None
            final = a[-1]
            q_final = "P" if final["passed"] else "F"
            if final["passed"] and r.random() < 0.01:
                q_final = "H"                                      # 미문서화: Up 보류(타 사유)
            dur = timedelta(minutes=round(sum(x["count"] for x in a) * 3.6 + 70 * len(a)))
            evt = t.pm_end + dur
            row = (seq, t.eqp_id, chb, pmc, legacy_dt(t.pm_end), C.procedure_id(t.model, t.pm_type), C.recipe_id(t.model, t.pm_type, d),
                   n1_rec, "P" if a[0]["passed"] else "F", fail1, (final["count"] - n1) if len(a) > 1 else None, final["count"],
                   q_final, len(a), h["eng"]["id"], self.memo(h, r), ts(evt), "N")
            hist_rows.append(row)
            c.execute("INSERT INTO QUAL_HIS VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
            mt = t.pm_end
            for i, x in enumerate(a):
                mt = mt + timedelta(minutes=round(x["count"] * 3.6 + 60))
                for item, (v, unit) in x["measurements"].items():
                    uc = C.LEGACY_UNIT[unit]
                    val = v
                    if item == "ER" and t.model == "ETX-500" and C.ER_NM_UNIT_PERIOD[0] <= d <= C.ER_NM_UNIT_PERIOD[1]:
                        val, uc = round(v / 10.0, 2), "NM/M"
                    c.execute("INSERT INTO QUAL_MEAS VALUES(?,?,?,?,?,?)", (seq, i + 1, C.LEGACY_ITEM[item], val, uc, ts(mt)))
            e["split"] = ("heldout" if d >= C.HELDOUT_START else "evolve") if d <= C.REPLAY_END else "post"
        # 소프트 삭제된 중복 행 (DEL_YN='Y') — 필터 안 하면 이중 집계
        for row in r.sample(hist_rows, 40):
            seq += 1
            dup = list(row)
            dup[0] = seq
            dup[-1] = "Y"
            dup[16] = ts(datetime.strptime(row[16], "%Y-%m-%d %H:%M:%S") + timedelta(minutes=r.randint(2, 50)))
            c.execute("INSERT INTO QUAL_HIS VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dup)
        # 부품 교체 이력
        pc = 500000
        for p in sorted(self.part_changes, key=lambda x: x["dt"]):
            pc += 1            # 운영 기간 교체 이력도 적재 (EVT_TS 이후에만 조회 가능)
            d = p["dt"].date()
            chb = p["ch"] if d >= C.LEGACY_CODE_SWITCH else {"A": "1", "B": "2", "C": "3"}[p["ch"]]
            c.execute("INSERT INTO PRT_CHG_HIS VALUES(?,?,?,?,?,?,?,?)", (pc, p["eqp"], chb, p["code"], legacy_dt(p["dt"]), p["lot"],
                                                                         p["removed_min"], ts(p["dt"] + timedelta(hours=1))))
        # 일별 RF 사용시간 (분) — 결측일 존재
        for cid, mins in self.usage.items():
            eqp, ch = cid.rsplit("-", 1)
            miss = self.usage_missing[cid]
            for i, v in enumerate(mins):
                d = DAY0 + timedelta(days=i)
                if i in miss:
                    continue
                chb = ch if d >= C.LEGACY_CODE_SWITCH else {"A": "1", "B": "2", "C": "3"}[ch]
                c.execute("INSERT INTO CHB_RF_USAGE VALUES(?,?,?,?,?)", (eqp, chb, d.strftime("%Y%m%d"), v, ts(dt(d + timedelta(days=1), 2, 10))))
        # 코드 사전 (부분 문서화)
        cd = [("PM_TP_CD", "W1", "Wet Clean", "2024-03-01", None)]
        for pm, info in C.PM_TYPES.items():
            if pm != "WET_CLEAN":
                cd.append(("PM_TP_CD", info["legacy"], info["name"], "2019-01-01", None))
        cd += [("RSLT_CD", "P", "PASS", "2019-01-01", None), ("RSLT_CD", "F", "FAIL", "2019-01-01", None)]
        for it, code in C.LEGACY_ITEM.items():
            if code != "BP":
                cd.append(("ITM_CD", code, it, "2019-01-01", None))
        for u, code in C.LEGACY_UNIT.items():
            if code != "NM/M":
                cd.append(("UNIT_CD", code, u, "2019-01-01", None))
        for ch in "ABC":
            cd.append(("CHB_ID", ch, f"Chamber {ch}", "2024-01-01", None))
        for code in PART_CODES:
            if code not in UNDOC_PARTS:
                cd.append(("PRT_CD", code, PART_NAMES[code], "2019-01-01", None))
        c.executemany("INSERT INTO CD_DICT VALUES(?,?,?,?,?)", cd)
        # 폐기 테이블 (구 스키마, event_ts 없음)
        rr = random.Random(C.SEED + 9)
        d0 = date(2022, 7, 1)
        for i in range(720):
            d = d0 + timedelta(days=rr.randint(0, 364))
            eqp = rr.choice(C.ALL_EQPS)
            c.execute("INSERT INTO QUAL_HIS_OLD VALUES(?,?,?,?,?,?,?,?)", (i + 1, eqp, rr.choice("123"), rr.choice(list(C.PM_TYPES)),
                                                                            d.strftime("%Y-%m-%d"), rr.choice([10, 15, 20, 25, 30, 35]),
                                                                            rr.choice(["OK", "OK", "OK", "NG"]), f"E{rr.randint(101, 140)}"))
        # 이관 백업 (2024-03-12 시점 사본, event_ts 없음, 중복 행)
        for row in hist_rows:
            if "20231001" <= row[4][:8] <= "20240229":
                c.execute("INSERT INTO TMP_QH_BAK_0312 VALUES(?,?,?,?,?,?,?,?,?)", (row[0], row[1], row[2], row[3], row[4], row[7], row[8], row[11], row[14]))
        etl = [("QUAL_HIS", "2026-08-31 23:50:00", None, "운영"), ("QUAL_MEAS", "2026-08-31 23:50:00", None, "운영"),
               ("PRT_CHG_HIS", "2026-08-31 23:55:00", None, "운영"), ("CHB_RF_USAGE", "2026-09-01 02:10:00", None, "운영"),
               ("QUAL_HIS_OLD", "2023-06-30 23:00:00", None, "구 시스템 이관 전 테이블(폐기 예정)"),
               ("TMP_QH_BAK_0312", "2024-03-12 04:00:00", None, "이관 작업 백업"),
               ("QL_HIS_NEW", None, 0, "신규 이력 테이블(이관 준비)"), ("CD_DICT", "2024-03-01 00:00:00", None, "코드 사전")]
        for name, last, cnt, note in etl:
            if cnt is None:
                cnt = c.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
            c.execute("INSERT INTO ETL_LOAD_LOG VALUES(?,?,?,?)", (name, last, cnt, note))
        c.executescript("""
        CREATE INDEX IX_QH ON QUAL_HIS(EQP_ID, CHB_ID, PM_TP_CD, PM_END_DT);
        CREATE INDEX IX_QH_TS ON QUAL_HIS(EVT_TS);
        CREATE INDEX IX_QM ON QUAL_MEAS(QH_SEQ);
        CREATE INDEX IX_PC ON PRT_CHG_HIS(EQP_ID, CHB_ID, CHG_DT);
        CREATE INDEX IX_RF ON CHB_RF_USAGE(EQP_ID, CHB_ID, YMD);
        """)
        con.commit()
        con.close()

    def write_truth(self):
        con = sqlite3.connect(DATA / "ground_truth.db")
        c = con.cursor()
        c.execute("""CREATE TABLE EVENT_TRUTH(EVENT_ID TEXT PRIMARY KEY, CHAMBER_ID TEXT, EQP_ID TEXT, CHAMBER TEXT, MODEL TEXT, EQP_GROUP TEXT,
                     PM_TYPE TEXT, PM_START TEXT, PM_END TEXT, RECIPE TEXT, RF_REFL_DELTA REAL, FR_HOURS REAL, CYCLE_RF_HOURS REAL,
                     HUMID INTEGER, BP_STABLE_MIN INTEGER, LEAK_RATE REAL, RANDOM_FAIL INTEGER, NOISE INTEGER, FR_REPLACED INTEGER,
                     R_REQUIRED INTEGER, EFFECTS TEXT, QH_SEQ INTEGER, SPLIT TEXT, HIST_N1 INTEGER, HIST_WAIT INTEGER,
                     HIST_FIRST_PASS INTEGER, HIST_FINAL INTEGER, HIST_ENG TEXT, TAG TEXT, PARTS TEXT)""")
        c.execute("CREATE TABLE PATTERNS(PATTERN_ID TEXT, DESCRIPTION TEXT)")
        c.executemany("INSERT INTO PATTERNS VALUES(?,?)", list(C.PATTERNS.items()))
        for e in self.events:
            t: EventTruth = e["truth"]
            h = e.get("hist")
            split = e.get("split") or ("ops" if t.pm_end.date() >= C.OPS_START else "post")
            c.execute("INSERT INTO EVENT_TRUTH VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                t.event_id, e["cid"], t.eqp_id, t.chamber, t.model, t.group, t.pm_type, ts(t.pm_start), ts(t.pm_end), t.recipe,
                t.rf_refl_delta, t.fr_hours, t.cycle_rf_hours, int(t.humid), t.bp_stable_min, t.leak_rate, int(t.random_fail),
                t.noise, int(t.fr_replaced), t.R, json.dumps(t.effects), e.get("qh_seq"), split,
                h["n1"] if h else None, int(h["wait"]) if h else None, int(h["attempts"][0]["passed"]) if h else None,
                h["attempts"][-1]["count"] if h else None, h["eng"]["id"] if h else None, e["plant"].get("tag"),
                json.dumps(t.parts)))
        c.execute("CREATE INDEX IX_GT_SEQ ON EVENT_TRUTH(QH_SEQ)")
        c.execute("CREATE INDEX IX_GT_CH ON EVENT_TRUTH(CHAMBER_ID, PM_END)")
        con.commit()
        con.close()


def main():
    t0 = time.time()
    g = Generator()
    g.build_chambers()
    g.build_schedule()
    g.process()
    g.history_outcomes()
    g.write_all()
    print(f"[mock_env] 생성 완료 {time.time() - t0:.1f}s → {DATA}")
    con = sqlite3.connect(DATA / "ground_truth.db")
    for split, n, fp in con.execute("SELECT SPLIT, COUNT(*), AVG(HIST_FIRST_PASS) FROM EVENT_TRUTH GROUP BY SPLIT"):
        print(f"  {split:8s} {n:5d}건  1차 Pass율 {fp if fp is None else round(fp * 100, 1)}")


if __name__ == "__main__":
    main()
