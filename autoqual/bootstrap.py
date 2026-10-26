"""초기 구축 (2026-07, 사람이 작성한 베이스라인): super·spec·log·legacy 1.0.0 + 공용 스킬 2종 + 회귀 테스트셋."""
from __future__ import annotations

from .genomes.skills import skill_sources

SUPER_PROMPT = """당신은 AutoQual Super Agent(super_agent)다. 설비 엔지니어·공정 담당자의 자연어 요청을 해석해 하위 Agent
(기준정보·로그분석·레거시DB 및 자동 생성 Agent)를 편성하고, 병렬 호출·결과 결합·판정 순서를 Python 실행 계획 코드(CodeAct)로
작성해 샌드박스에서 실행한 뒤 결과를 종합한다.
톤: 현장 엔지니어 대상 간결한 보고체. [Agent 편성]/[Qual 절차]/[챔버 상태]/[과거 이력]/[추천]/[판정] 블록, 결론 먼저, 근거는 수치·Spec·이력 건수.
확인 불가·근거 부족 항목은 숨기지 않고 명시한다.
금지: 사람 승인 없는 장비 상태 변경, LLM 추론으로 Spec 판정 대체, 원본 데이터·레거시 쓰기, 샌드박스 밖 실행, 근거 없는 결과를 정상 결과로 제시,
평가 하네스·루프 예산 수정, 실제 장비·MES·EES 직접 제어."""

SPEC_PROMPT = "기준정보 Agent: 기준정보 원문 코드(절차 ID·Spec·레시피 ID)를 그대로 인용, 보정 적용 시 교훈 ID와 보정량 명시. 기준정보 누락 시 추정 금지."
LOG_PROMPT = "로그분석 Agent: 지표명·측정값·PM 전 대비 변화율을 한 줄씩. 파싱 실패 항목은 '확인 불가'. 판정 금지."
LEGACY_PROMPT = "레거시DB Agent: 표본 수·기간 함께 제시. 해석한 코드값은 출처와 함께. SELECT만. 0건은 '이력 없음'/'데이터 부재' 구분."

SUPER_PLANNER = '''"""super_agent {v} — CodeAct 실행 계획 정책
요청 유형별 실행 계획 코드 골격. LLM(plan 역할)이 이 골격과 Agent 카탈로그를 받아 요청별 계획 코드를 작성한다.
- PM 후 AutoQual: spec.lookup ∥ log.analyze ∥ legacy.history (∥ 편성된 신규 Agent) → 신호 결합 → spec.recommend
- 결과 상충 시 보수적 계획(더 많은 매수)과 근거를 함께 제시
- 장비 상태 변경은 approval_gate(사람 승인)로만
"""
ROUTE_AUTO = {route_auto}
MERGE_SIGNALS = {merge}
SKIP_RULES = {skip}
'''

CARDS = {
    "spec_agent": {"serves": ["autoqual", "judge", "remeasure"], "caps": ["procedure", "spec", "seasoning_base", "seasoning_reco"],
                   "keywords": ["Spec", "절차", "기준"], "contrib": 0.9, "bias": 0.53, "signals": []},
    "log_agent": {"serves": ["autoqual"], "caps": ["fdc_trace", "leak", "alarm"], "keywords": ["로그", "FDC", "알람"],
                  "contrib": 0.8, "bias": -0.16, "signals": ["rf_refl_delta_pct", "leak_rate", "bp_stable_min", "base_pressure"]},
    "legacy_agent": {"serves": ["autoqual", "history", "remeasure", "analysis"], "caps": ["qual_history", "pass_curve", "code_values"],
                     "keywords": ["이력", "지난", "과거"], "contrib": 0.7, "bias": -0.57, "signals": []},
}


def log_tools():
    return ["read_fdc_trace", "read_fdc_summary", "read_alarm_log", "get_pm_event", "query_legacy_db"]


def super_code(version: str, params: dict) -> str:
    return SUPER_PLANNER.replace("{v}", version).replace("{route_auto}", repr(params.get("route_auto", 0.9))) \
        .replace("{merge}", repr(params.get("merge_signals", []))).replace("{skip}", repr(params.get("skip_rules", [])))


def seed_baseline(sysm):
    reg = sysm.registry
    # 공용 스킬
    sk = skill_sources()
    for sid in ("legacy_sql_toolkit", "code_value_resolver"):
        reg.register_agent(sid, "skill", {"legacy_sql_toolkit": "레거시 SQL 툴킷", "code_value_resolver": "코드값 해석기"}[sid],
                           origin="초기 구축")
        reg.add_genome(sid, "1.0.0", sk[sid]["1.0.0"], reason="baseline", status="active")
        reg.activate(sid, "1.0.0", "baseline", note="초기 구축")
    # Super Agent
    params = {"route_auto": 0.90, "merge_signals": ["log_agent"], "skip_rules": []}
    reg.register_agent("super_agent", "super", "Super Agent", protected=True)
    reg.add_genome("super_agent", "1.0.0", super_code("1.0.0", params), params=params, prompt=SUPER_PROMPT, reason="baseline", status="active")
    reg.activate("super_agent", "1.0.0", "baseline", note="초기 구축")
    # 메인 Agent 3종
    from .genomes.build import make_genome
    defs = [("spec_agent", "기준정보 Agent", SPEC_PROMPT, "초기 구축: 기준정보 조회 + 기본 Seasoning 매수"),
            ("log_agent", "로그분석 Agent", LOG_PROMPT, "초기 구축: SW v4.x(CSV) 파서, RF Reflected 변화율·Leak·알람"),
            ("legacy_agent", "레거시DB Agent", LEGACY_PROMPT, "초기 구축: QUAL_HIS 동일 챔버·PM 이력, 매수별 1차 Pass율")]
    for aid, name, prompt, cl in defs:
        gen = make_genome(sysm, aid, "1.0.0", set(), [f"1.0.0: {cl}"])
        reg.register_agent(aid, "agent", name, protected=True, card=CARDS[aid])
        reg.add_genome(aid, "1.0.0", gen["code"], prompt=prompt, tools=gen["tools"], deps=gen["deps"], params=gen["params"],
                       reason="baseline", status="active")
        reg.activate(aid, "1.0.0", "baseline", note="초기 구축")
    from eval.testcases import build_regression
    build_regression(sysm)
