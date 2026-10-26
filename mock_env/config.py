"""Mock AutoQual 환경 — 가상 Fab 토폴로지·기준정보·숨은 패턴 정의.

모든 ID·값은 가상이다. 실제 회사·장비·레시피·코드 체계와 무관하다.
생성기는 SEED로 고정되어 언제 실행해도 같은 데이터를 만든다.
"""
from __future__ import annotations

from datetime import date, datetime

SEED = 20260701

# ── 기간 ────────────────────────────────────────────────────────────
HIST_START = date(2023, 7, 1)        # 레거시 Qual 이력 시작
REPLAY_END = date(2026, 6, 30)       # 리플레이 대상 끝 (3,000건)
HELDOUT_START = date(2026, 1, 1)     # 최근 6개월 Held-out
HIST_END = date(2026, 8, 31)         # 레거시 적재 끝 (운영 투입 직전)
OPS_START = date(2026, 9, 1)         # 운영 기간 (스토리 진행)
OPS_END = date(2026, 12, 31)
REPLAY_CASES = 3000

RECIPE_R2_FROM = date(2024, 10, 1)   # Seasoning 레시피 개정 SSN-R2
PARTICLE_SPEC_CHANGE = date(2025, 4, 1)  # Particle Spec ≤20 → ≤15 (ETCH)
LEGACY_CODE_SWITCH = date(2024, 1, 1)    # 챔버 코드 '1/2/3' → 'A/B/C'
PM_CODE_W0_UNTIL = date(2024, 2, 29)     # Wet Clean 구코드 W0 사용 종료
MIGRATION_GAP = (date(2024, 3, 4), date(2024, 3, 17))  # 이관 공백(미적재) 구간
ER_NM_UNIT_PERIOD = (date(2024, 7, 1), date(2025, 3, 31))  # ETX-500 ER을 nm/min로 적재한 기간

# ── 장비 ────────────────────────────────────────────────────────────
MODELS = {
    "ETX-300": {"group": "ETCH", "short": "ETX", "eqps": [f"ETCH-{i:02d}" for i in range(1, 9)]},
    "ETX-500": {"group": "ETCH", "short": "EX5", "eqps": [f"ETCH-{i:02d}" for i in range(9, 15)]},
    "CVX-200": {"group": "CVD", "short": "CVX", "eqps": [f"CVD-{i:02d}" for i in range(1, 13)]},
    "PVX-100": {"group": "PVD", "short": "PVX", "eqps": [f"PVD-{i:02d}" for i in range(1, 5)]},
}
CHAMBERS = ["A", "B", "C"]

EQP_MODEL = {eqp: m for m, info in MODELS.items() for eqp in info["eqps"]}
EQP_GROUP = {eqp: MODELS[m]["group"] for eqp, m in EQP_MODEL.items()}
ALL_EQPS = list(EQP_MODEL.keys())

# 장비 SW 버전 이력: (적용 시작일, 버전). v3.x = 세미콜론 구포맷, v4.x = CSV 현행 포맷
OLD_SW_EQPS = {"ETCH-01", "ETCH-02", "ETCH-03", "ETCH-04", "ETCH-05",
               "CVD-01", "CVD-02", "CVD-03", "CVD-04", "CVD-05", "CVD-06"}
SW_UPGRADE_V4 = date(2024, 2, 15)
V52_EQPS = ["CVD-03", "CVD-08", "CVD-12"]   # SC-003 장애 주입(장비 SW v5.2) 대상


def sw_version(eqp: str, d: date) -> str:
    if eqp in OLD_SW_EQPS and d < SW_UPGRADE_V4:
        return "3.8"
    if d < date(2025, 1, 10):
        return "4.2"
    return "4.6"


# ── PM 종류 (8종) ───────────────────────────────────────────────────
PM_TYPES = {
    "WET_CLEAN":          {"short": "WC",  "legacy": "W1", "name": "Wet Clean"},
    "RF_GEN_REPLACE":     {"short": "RFG", "legacy": "R2", "name": "RF Generator 교체"},
    "SHOWERHEAD_REPLACE": {"short": "SHR", "legacy": "S3", "name": "Showerhead 교체"},
    "ESC_REPLACE":        {"short": "ESC", "legacy": "E4", "name": "ESC 교체"},
    "TARGET_REPLACE":     {"short": "TGT", "legacy": "T5", "name": "Target 교체"},
    "PUMP_PM":            {"short": "PMP", "legacy": "P6", "name": "Pump PM"},
    "QUARTERLY_PM":       {"short": "QPM", "legacy": "Q7", "name": "정기 PM(분기)"},
    "ALARM_RECOVERY":     {"short": "ALM", "legacy": "A8", "name": "알람 Down 복구"},
}
LEGACY_PM_CODE = {k: v["legacy"] for k, v in PM_TYPES.items()}
LEGACY_PM_DECODE = {v["legacy"]: k for k, v in PM_TYPES.items()}
LEGACY_PM_DECODE["W0"] = "WET_CLEAN"   # 문서화 안 된 구코드

PM_WEIGHTS = {
    "ETCH": {"WET_CLEAN": .38, "RF_GEN_REPLACE": .07, "ESC_REPLACE": .07, "PUMP_PM": .10, "QUARTERLY_PM": .20, "ALARM_RECOVERY": .18},
    "CVD":  {"WET_CLEAN": .30, "RF_GEN_REPLACE": .07, "ESC_REPLACE": .05, "SHOWERHEAD_REPLACE": .08, "PUMP_PM": .10, "QUARTERLY_PM": .22, "ALARM_RECOVERY": .18},
    "PVD":  {"WET_CLEAN": .25, "TARGET_REPLACE": .25, "PUMP_PM": .12, "QUARTERLY_PM": .20, "ALARM_RECOVERY": .18},
}

# ── 기준정보: 기본 Seasoning 매수 (SSN-R1, SSN-R2) ──────────────────
BASE_SEASONING = {
    "ETX-300": {"WET_CLEAN": (25, 25), "RF_GEN_REPLACE": (15, 15), "ESC_REPLACE": (20, 20), "PUMP_PM": (10, 10), "QUARTERLY_PM": (20, 20), "ALARM_RECOVERY": (10, 10)},
    "ETX-500": {"WET_CLEAN": (35, 35), "RF_GEN_REPLACE": (20, 20), "ESC_REPLACE": (20, 20), "PUMP_PM": (10, 10), "QUARTERLY_PM": (25, 25), "ALARM_RECOVERY": (10, 10)},
    "CVX-200": {"WET_CLEAN": (20, 15), "RF_GEN_REPLACE": (15, 15), "ESC_REPLACE": (15, 15), "SHOWERHEAD_REPLACE": (25, 20), "PUMP_PM": (10, 10), "QUARTERLY_PM": (20, 15), "ALARM_RECOVERY": (8, 8)},
    "PVX-100": {"WET_CLEAN": (15, 15), "TARGET_REPLACE": (25, 20), "PUMP_PM": (10, 10), "QUARTERLY_PM": (15, 15), "ALARM_RECOVERY": (8, 8)},
}


def recipe_rev(d: date) -> str:
    return "R2" if d >= RECIPE_R2_FROM else "R1"


def base_count(model: str, pm: str, d: date) -> int:
    r1, r2 = BASE_SEASONING[model][pm]
    return r2 if recipe_rev(d) == "R2" else r1


def procedure_id(model: str, pm: str) -> str:
    rev = {"WET_CLEAN": "03", "QUARTERLY_PM": "02"}.get(pm, "01")
    return f"QP-{MODELS[model]['short']}-{PM_TYPES[pm]['short']}-{rev}"


def recipe_id(model: str, pm: str, d: date) -> str:
    return f"SSN-{MODELS[model]['short']}-{PM_TYPES[pm]['short']}-{recipe_rev(d)}"


# ── Qual Spec ───────────────────────────────────────────────────────
# (item, lower, upper, unit) — ER 계열은 중심값 ±%로 정의
ER_CENTER = {"ETX-300": 1850.0, "ETX-500": 2100.0}
DR_CENTER = {"CVX-200": 1200.0}


def spec_items(model: str, d: date) -> list[dict]:
    g = MODELS[model]["group"]
    if g == "ETCH":
        c = ER_CENTER[model]
        ptc = 20 if d < PARTICLE_SPEC_CHANGE else 15
        return [
            {"item": "LEAK_RATE", "lower": None, "upper": 2.0, "unit": "mTorr/min"},
            {"item": "PARTICLE", "lower": None, "upper": ptc, "unit": "ea"},
            {"item": "ER", "lower": round(c * .95, 1), "upper": round(c * 1.05, 1), "unit": "A/min"},
            {"item": "ER_UNIF", "lower": None, "upper": 3.0, "unit": "%"},
        ]
    if g == "CVD":
        c = DR_CENTER[model]
        return [
            {"item": "LEAK_RATE", "lower": None, "upper": 2.0, "unit": "mTorr/min"},
            {"item": "PARTICLE", "lower": None, "upper": 20, "unit": "ea"},
            {"item": "DR", "lower": round(c * .96, 1), "upper": round(c * 1.04, 1), "unit": "A/min"},
            {"item": "THK_UNIF", "lower": None, "upper": 2.5, "unit": "%"},
        ]
    return [
        {"item": "LEAK_RATE", "lower": None, "upper": 1.0, "unit": "mTorr/min"},
        {"item": "PARTICLE", "lower": None, "upper": 10, "unit": "ea"},
        {"item": "BASE_PRESSURE", "lower": None, "upper": 5.0e-7, "unit": "Torr"},
        {"item": "RS_UNIF", "lower": None, "upper": 3.5, "unit": "%"},
    ]


PROCEDURE_STEPS = {
    "ETCH": ["Leak Check", "Seasoning", "Particle Monitor", "ER Monitor"],
    "CVD": ["Leak Check", "Seasoning", "Particle Monitor", "Deposition Rate Monitor"],
    "PVD": ["Leak Check", "Base Pressure Check", "Seasoning(Burn-in)", "Particle Monitor", "Rs Monitor"],
}

# 레거시 ITM_CD / UNIT_CD
LEGACY_ITEM = {"LEAK_RATE": "LKR", "PARTICLE": "PTC", "ER": "ER", "ER_UNIF": "ERU",
               "DR": "DR", "THK_UNIF": "THU", "BASE_PRESSURE": "BP", "RS_UNIF": "RSU"}
LEGACY_ITEM_DECODE = {v: k for k, v in LEGACY_ITEM.items()}
LEGACY_UNIT = {"mTorr/min": "MT/M", "ea": "EA", "A/min": "A/M", "%": "PCT", "Torr": "T", "nm/min": "NM/M"}

# ── 숨은 패턴 (ground truth) ──────────────────────────────────────
# 필요 Seasoning 매수 R = 기본 필요량 R0 + 효과들 + 노이즈. 1차 Pass ⟺ 투입 매수 ≥ R (그리고 별도 Fail 요인 없음)
R0_OFFSET = {  # R0 = base - offset (기본 매수가 대체로 충분하도록 여유)
    ("ETX-500", "WET_CLEAN"): 8,      # 기본 35매는 과잉: 27~28매면 충분 (L-0019 대상)
}
DEFAULT_R0_OFFSET = 3
NOISE_SD = 1.4

PATTERNS = {
    "P1_RF_REFL": "ETX-300 Wet Clean 후 RF Reflected 초기값이 PM 전 대비 +10% 이상이면 필요 매수 +10",
    "P2_ETX500_SATURATION": "ETX-500 Wet Clean은 27~28매에서 1차 Pass 포화 (기본 35매 과잉)",
    "P3_HUMID_BP": "7~8월 Leak Check 후 Base Pressure 안정화 대기(30분) 없이 진행하면 Leak Rate Fail 45%",
    "P4_FOCUS_RING": "ETCH Wet Clean·정기 PM 시 Focus Ring 사용 400~600h +5매, 600h 초과 +10매 (ETX-300), ETX-500은 600h 초과 +5매 — 부품 교체 이력에만 존재(레거시 Qual 이력·FDC로 설명 불가)",
    "P5_CVD_CYCLE": "CVX-200 정기 PM·Pump PM·알람 복구 시 직전 Wet Clean 이후 RF 누적 450h 초과면 필요 매수 +6",
    "P6_RECIPE_R2": "2024-10 SSN-R2 개정: CVX-200 WC/QPM/SHR, PVX-100 TGT 기본 매수 −5 (필요량도 함께 감소)",
    "P7_RANDOM_PARTICLE": "매수와 무관한 랜덤 Particle Fail 4%",
    "P8_ESC_ETCH": "ETCH ESC 교체 후 기본 매수 대비 +2~3매 필요 (+5 교훈 대상)",
    "P9_SHR_TGT": "CVX-200 Showerhead 교체(R1)·PVX-100 Target 교체는 기본 매수 대비 +3~4매 필요 (+5 교훈 대상)",
}
