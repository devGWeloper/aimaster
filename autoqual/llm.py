"""LLM 어댑터 — 사내 제공 LLM API 연동.

설정: config/llm.json (없으면 config/llm.example.json 참고) + 환경변수
  AUTOQUAL_LLM_MODE      offline | openai | anthropic   (기본 offline)
  AUTOQUAL_LLM_BASE_URL  사내 게이트웨이 주소 (예: https://llm-gw.internal/v1)
  AUTOQUAL_LLM_API_KEY   사내 발급 키
  역할별 모델명: models.codegen / models.plan / models.summary

- openai    : OpenAI 호환 /chat/completions (대부분의 사내 LLM 게이트웨이 형식)
- anthropic : Anthropic 호환 /v1/messages
- offline   : 사내망 미연결 시 결정적 재현용 Playbook(사전 작성된 후보 코드)을 LLM 출력으로 사용.
              생성된 코드는 온라인 모드와 똑같이 AST 검사·샌드박스 실행·회귀 테스트를 통과해야 채택된다.

외부 SDK 없이 표준 라이브러리(urllib)만 사용한다.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODELS = {"codegen": "claude-opus-5-5", "plan": "claude-sonnet-5-5", "summary": "claude-haiku-5-5"}


@dataclass
class LLMResult:
    text: str
    model: str
    tokens_in: int
    tokens_out: int
    latency_s: float          # 실제(온라인) 또는 지연 모델(오프라인)
    source: str               # online | playbook


def load_config() -> dict:
    cfg = {"mode": "offline", "base_url": "", "api_key_env": "AUTOQUAL_LLM_API_KEY", "models": dict(DEFAULT_MODELS),
           "timeout_s": 120, "max_tokens": 4096, "extra_headers": {}}
    p = ROOT / "config" / "llm.json"
    if p.exists():
        try:
            user = json.loads(p.read_text(encoding="utf-8"))
            cfg.update({k: v for k, v in user.items() if k != "models"})
            cfg["models"].update(user.get("models", {}))
        except json.JSONDecodeError:
            pass
    cfg["mode"] = os.environ.get("AUTOQUAL_LLM_MODE", cfg["mode"])
    cfg["base_url"] = os.environ.get("AUTOQUAL_LLM_BASE_URL", cfg["base_url"])
    return cfg


def extract_code(text: str) -> str:
    m = re.findall(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    return max(m, key=len).strip() + "\n" if m else text.strip() + "\n"


class LLMClient:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config()
        self.usage = {"calls": 0, "tokens_in": 0, "tokens_out": 0, "by_role": {}}

    @property
    def mode(self) -> str:
        return self.cfg["mode"]

    @property
    def online(self) -> bool:
        return self.cfg["mode"] in ("openai", "anthropic") and bool(self.cfg["base_url"])

    def model_for(self, role: str) -> str:
        return self.cfg["models"].get(role, DEFAULT_MODELS.get(role, "default"))

    def describe(self) -> dict:
        return {"mode": self.mode if self.online else "offline", "base_url": self.cfg["base_url"] if self.online else "",
                "models": self.cfg["models"], "usage": self.usage}

    # ── 호출 ────────────────────────────────────────────────────────
    def chat(self, role: str, system: str, user: str, max_tokens: int | None = None) -> LLMResult:
        model = self.model_for(role)
        t0 = time.time()
        key = os.environ.get(self.cfg.get("api_key_env", "AUTOQUAL_LLM_API_KEY"), "")
        headers = {"Content-Type": "application/json", **self.cfg.get("extra_headers", {})}
        mt = max_tokens or self.cfg["max_tokens"]
        if self.cfg["mode"] == "anthropic":
            url = self.cfg["base_url"].rstrip("/") + "/v1/messages"
            headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
            body = {"model": model, "max_tokens": mt, "system": system, "messages": [{"role": "user", "content": user}]}
        else:
            url = self.cfg["base_url"].rstrip("/") + "/chat/completions"
            if key:
                headers["Authorization"] = f"Bearer {key}"
            body = {"model": model, "max_tokens": mt,
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.cfg["timeout_s"]) as r:
            data = json.loads(r.read().decode())
        if self.cfg["mode"] == "anthropic":
            text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
            ti, to = data.get("usage", {}).get("input_tokens", 0), data.get("usage", {}).get("output_tokens", 0)
        else:
            text = data["choices"][0]["message"]["content"]
            ti, to = data.get("usage", {}).get("prompt_tokens", 0), data.get("usage", {}).get("completion_tokens", 0)
        res = LLMResult(text, model, ti, to, time.time() - t0, "online")
        self._account(role, res)
        return res

    def playbook(self, role: str, prompt_chars: int, text: str) -> LLMResult:
        """오프라인 모드: Playbook 출력을 LLM 결과로 사용(지연·토큰은 모델 특성 기반 추정치)."""
        ti, to = max(200, prompt_chars // 3), max(40, len(text) // 3)
        lat = {"codegen": 18 + to / 55, "plan": 1.6 + to / 160, "summary": 0.5 + to / 400}.get(role, 2.0)
        res = LLMResult(text, self.model_for(role), ti, to, round(lat, 1), "playbook")
        self._account(role, res)
        return res

    def _account(self, role, res: LLMResult):
        self.usage["calls"] += 1
        self.usage["tokens_in"] += res.tokens_in
        self.usage["tokens_out"] += res.tokens_out
        r = self.usage["by_role"].setdefault(role, {"calls": 0, "tokens": 0})
        r["calls"] += 1
        r["tokens"] += res.tokens_in + res.tokens_out

    def generate_code(self, role: str, system: str, prompt: str, fallback_code: str | None) -> tuple[str, LLMResult]:
        """온라인이면 사내 LLM으로 코드 생성, 실패·오프라인이면 Playbook 코드 사용."""
        if self.online:
            try:
                res = self.chat(role, system, prompt)
                return extract_code(res.text), res
            except Exception as e:  # noqa: BLE001 — 사내 게이트웨이 장애는 Playbook으로 폴백
                if fallback_code is None:
                    raise
                res = self.playbook(role, len(prompt), fallback_code)
                res.source = f"playbook(fallback: {type(e).__name__})"
                return fallback_code, res
        if fallback_code is None:
            raise RuntimeError("LLM 오프라인 모드에서 Playbook에 없는 코드 생성 요청")
        return fallback_code, self.playbook(role, len(prompt), fallback_code)
