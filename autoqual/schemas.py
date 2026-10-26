"""Agent 간 Structured Output 스키마 (Pydantic). 스키마 검증 실패는 사후 검증 실패로 간주해 Heal을 트리거한다."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError


class _Base(BaseModel):
    model_config = ConfigDict(extra="allow")
    status: Literal["ok", "partial", "unavailable"]
    unavailable: list[str] = []


class Indicator(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str
    value: Any
    unit: str | None = None


class SpecLookup(_Base):
    eqp_model: str | None = None
    procedure_id: str | None = None
    specs: list[dict] = []
    seasoning: dict | None = None


class SpecRecommend(_Base):
    base: int
    count: int
    required_est: int
    corrections: list[dict] = []
    extra_steps: list[dict] = []


class LogAnalyze(_Base):
    indicators: list[Indicator] = []
    signals: dict = {}


class LegacyHistory(_Base):
    n_cases: int = 0
    by_count: dict = {}
    absence: str = "none"


class LegacyMeasurements(_Base):
    measurements: list[dict] = []


class Generic(_Base):
    pass


SCHEMAS = {
    ("spec_agent", "lookup"): SpecLookup, ("spec_agent", "recommend"): SpecRecommend,
    ("log_agent", "analyze"): LogAnalyze, ("log_agent", "trend"): Generic,
    ("legacy_agent", "history"): LegacyHistory, ("legacy_agent", "measurements"): LegacyMeasurements,
}


def validate(agent_id: str, action: str, out) -> tuple[bool, str]:
    if not isinstance(out, dict):
        return False, f"출력 타입 오류: {type(out).__name__}"
    model = SCHEMAS.get((agent_id, action), Generic)
    try:
        model.model_validate(out)
        return True, ""
    except ValidationError as e:
        return False, "스키마 검증 실패: " + "; ".join(f"{'.'.join(str(x) for x in err['loc'])} {err['msg']}" for err in e.errors()[:3])
