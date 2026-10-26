"""Mock Fab Qual 시뮬레이터 — 숨은 패턴(ground truth)의 '물리'.

생성기(과거 이력 생성), 평가 하네스(반사실 백테스트), 운영 시뮬레이터(운영 기간 Qual 결과)가
모두 이 모듈 하나로 Qual 결과를 만든다. Agent는 이 모듈에 접근할 수 없다(샌드박스 import 차단).
"""
from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass, field, asdict
from datetime import datetime

from . import config as C


def rng_for(*parts) -> random.Random:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return random.Random(int(h[:16], 16))


@dataclass
class EventTruth:
    event_id: str
    eqp_id: str
    chamber: str
    model: str
    group: str
    pm_type: str
    pm_start: datetime
    pm_end: datetime
    recipe: str
    rf_refl_delta: float          # PM 후 RF Reflected 초기값 변화율(%)
    fr_hours: float | None        # PM 직후 Focus Ring 사용시간(h) — ETCH만
    cycle_rf_hours: float | None  # 직전 Wet Clean 이후 RF 누적시간(h)
    humid: bool
    bp_stable_min: int            # Leak Check 후 Base Pressure 안정화 소요(분)
    leak_rate: float              # mTorr/min (정상 상태 값)
    random_fail: bool
    noise: int
    fr_replaced: bool = False
    parts: list = field(default_factory=list)
    R: int = 0                     # 필요 Seasoning 매수 (ground truth)
    effects: dict = field(default_factory=dict)

    def to_row(self) -> dict:
        d = asdict(self)
        d["pm_start"] = self.pm_start.isoformat(sep=" ")
        d["pm_end"] = self.pm_end.isoformat(sep=" ")
        return d


def required_count(t: EventTruth) -> tuple[int, dict]:
    """필요 Seasoning 매수 R과 효과 분해."""
    d = t.pm_end.date()
    base = C.base_count(t.model, t.pm_type, d)
    eff: dict[str, int] = {}
    offset = C.R0_OFFSET.get((t.model, t.pm_type), C.DEFAULT_R0_OFFSET)
    # 레시피별 특이 기본 필요량
    if t.recipe == "R1":
        if (t.model, t.pm_type) == ("CVX-200", "SHOWERHEAD_REPLACE"):
            offset = -4                  # 구 레시피 기본 25매로는 부족 (+5 교훈 대상)
        if (t.model, t.pm_type) == ("PVX-100", "TARGET_REPLACE"):
            offset = -3
    else:
        if (t.model, t.pm_type) == ("PVX-100", "TARGET_REPLACE"):
            offset = -3                  # R2에서도 기본 20매 부족 (교훈 재학습 대상)
        if (t.model, t.pm_type) == ("CVX-200", "QUARTERLY_PM"):
            offset = -2                  # R2 기본 15매가 낙관적 (신규 교훈 대상)
    if t.group == "ETCH" and t.pm_type == "ESC_REPLACE":
        offset = -2                      # ESC 교체 후 기본 매수 부족 (+5 교훈 대상)
    R = base - offset
    eff["base_required"] = R
    if t.model == "ETX-300" and t.pm_type == "WET_CLEAN" and t.rf_refl_delta >= 10.0:
        eff["rf_refl"] = 10
    if t.group == "ETCH" and t.pm_type in ("WET_CLEAN", "QUARTERLY_PM") and t.fr_hours is not None:
        if t.model == "ETX-300":
            if t.fr_hours >= 600:
                eff["focus_ring"] = 10
            elif t.fr_hours >= 400:
                eff["focus_ring"] = 5
        elif t.fr_hours >= 600:
            eff["focus_ring"] = 5
    if t.model == "CVX-200" and t.pm_type in ("QUARTERLY_PM", "PUMP_PM", "ALARM_RECOVERY") \
            and t.cycle_rf_hours is not None and t.cycle_rf_hours > 450:
        eff["cvd_cycle"] = 6
    R += sum(v for k, v in eff.items() if k != "base_required")
    if t.noise:
        eff["noise"] = t.noise
    R += t.noise
    return max(R, 3), eff


def leak_fail_prob(t: EventTruth, wait_step: bool) -> float:
    if wait_step:
        return 0.0
    return 0.45 if t.bp_stable_min >= 25 else 0.03


def _spec_by_item(model: str, d) -> dict:
    return {s["item"]: s for s in C.spec_items(model, d)}


def simulate_qual(t: EventTruth, count: int, wait_step: bool, attempt: int = 1,
                  fixed: dict | None = None) -> dict:
    """주어진 Seasoning 매수로 Qual을 수행한 결과(측정값)를 결정적으로 생성."""
    r = rng_for("qual", t.event_id, attempt, count, int(wait_step))
    d = t.pm_end.date()
    specs = _spec_by_item(t.model, d)
    season_ok = count >= t.R
    particle_fail = t.random_fail if attempt == 1 else (r.random() < 0.03)
    leak_fail = r.random() < leak_fail_prob(t, wait_step)
    meas: dict[str, tuple[float, str]] = {}

    def unif_val(u):
        if season_ok:
            return round(u if r.random() < 0.01 else r.uniform(0.42 * u, 0.93 * u), 2)
        return round(r.uniform(u + 0.1, u + 1.6), 2)

    for item, s in specs.items():
        up, lo = s["upper"], s["lower"]
        if item == "LEAK_RATE":
            v = round(r.uniform(up + 0.1, up + 0.9), 2) if leak_fail else round(min(t.leak_rate, up - 0.12), 2)
        elif item == "PARTICLE":
            if particle_fail:
                v = r.randint(int(up) + 1, int(up) + 14)
            else:
                v = int(up) if r.random() < 0.03 else r.randint(1, max(2, int(up) - 2))
        elif item in ("ER", "DR"):
            c = (lo + up) / 2
            tol = (up - c) / c * 100
            if season_ok or r.random() < 0.65:
                v = round(c * (1 + max(-(tol - 0.6), min(tol - 0.6, r.gauss(0, 1.2))) / 100), 1)
            else:
                v = round(c * (1 - r.uniform(tol + 0.3, tol + 3.0) / 100), 1)
        elif item == "BASE_PRESSURE":
            v = float(f"{r.uniform(5.5e-7, 9.0e-7) if leak_fail else r.uniform(1.4e-7, 4.6e-7):.2e}")
        else:  # *_UNIF
            v = unif_val(up)
        meas[item] = (v, s["unit"])
    if fixed:
        meas.update(fixed)
    fail_items = []
    for item, (v, _u) in meas.items():
        s = specs[item]
        if (s["upper"] is not None and v > s["upper"]) or (s["lower"] is not None and v < s["lower"]):
            fail_items.append(item)
    return {"passed": not fail_items, "measurements": meas, "fail_items": fail_items,
            "season_ok": season_ok, "count": count, "attempt": attempt}
