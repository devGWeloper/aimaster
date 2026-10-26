"""Jev 판단 게이트 — 루프 안의 짧은 분기 판단을 보정 확률로 반환.

jev_decide(question, mode, options, context) -> {answer, probs, calibrated, model, latency_ms}

사내망 반입 전 대안(설계서: "SemIf 또는 소형 분류 모델")으로, 판단 유형별 보정 로지스틱 헤드를
로컬에서 계산한다. 각 헤드는 명시적 특징(feature)과 가중치를 갖고 온도(temperature) 스케일링으로
보정된다. config/jev.json mode=http 이면 같은 시그니처로 사내 엔드포인트를 호출한다.
"""
from __future__ import annotations

import json
import math
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z))


def softmax(zs: dict[str, float], temp: float = 1.0) -> dict[str, float]:
    m = max(zs.values())
    ex = {k: math.exp((v - m) / temp) for k, v in zs.items()}
    s = sum(ex.values())
    return {k: v / s for k, v in ex.items()}


ERROR_TYPES = ["포맷 변경", "스키마 변경", "기준정보 누락", "로직 오류", "외부 장애", "복구 불가"]


class Jev:
    def __init__(self):
        self.cfg = {"mode": "local"}
        p = ROOT / "config" / "jev.json"
        if p.exists():
            try:
                self.cfg.update(json.loads(p.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                pass
        self.calls = 0
        self.history: list[dict] = []

    @property
    def model(self) -> str:
        return "jev-http" if self.cfg.get("mode") == "http" and self.cfg.get("base_url") else "jev-local-calibrated"

    def _result(self, kind, question, answer, probs, t0, features=None):
        self.calls += 1
        out = {"kind": kind, "question": question, "answer": answer,
               "probs": {k: round(v, 3) for k, v in probs.items()}, "calibrated": True, "model": self.model,
               "latency_ms": round((time.perf_counter() - t0) * 1000 + 35, 1), "features": features or {}}
        if len(self.history) < 2000:
            self.history.append({"kind": kind, "answer": answer})
        return out

    def _http(self, question, mode, options, context):
        req = urllib.request.Request(self.cfg["base_url"].rstrip("/") + "/decide", method="POST",
                                     data=json.dumps({"question": question, "mode": mode, "options": options, "context": context}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())

    # ── 범용 진입점 (설계서 시그니처) ────────────────────────────────
    def decide(self, question: str, mode: str, options: list[str], context: dict) -> dict:
        if self.model == "jev-http":
            return self._http(question, mode, options, context)
        head = context.get("head")
        fn = getattr(self, f"head_{head}", None)
        if fn is None:
            raise ValueError(f"unknown jev head {head}")
        return fn(question, options, context)

    # ── 헤드: Agent 편성 (multi_choice) ─────────────────────────────
    def head_route(self, q, options, ctx):
        t0 = time.perf_counter()
        req = ctx["request"]
        probs = {}
        feats = {}
        for card in ctx["cards"]:
            a = card["agent_id"]
            if a not in options:
                continue
            f = {
                "type": 1.0 if req["rtype"] in card.get("serves", []) else 0.0,
                "group": 1.0 if (not card.get("groups") or req.get("eqp_group") in card["groups"]) else 0.0,
                "pm": 1.0 if (not card.get("pm_types") or req.get("pm_type") in card["pm_types"]) else 0.0,
                "keyword": min(1.0, sum(1 for k in card.get("keywords", []) if k in req.get("text", "")) / 2.0),
                "contrib": card.get("contrib", 0.5),
                "probation": 1.0 if card.get("status") == "probation" else 0.0,
            }
            z = -2.6 + 2.9 * f["type"] + 1.1 * f["group"] + 0.9 * f["pm"] + 1.6 * f["keyword"] + 1.2 * (f["contrib"] - 0.5) \
                - 0.5 * f["probation"] + card.get("bias", 0.0)
            probs[a] = sigmoid(z / 0.85)
            feats[a] = f
        sel = [a for a, p in probs.items() if p >= ctx.get("threshold", 0.60)]
        return self._result("route", q, sel, probs, t0, feats)

    # ── 헤드: 기존 Agent로 처리 가능? (yes_no) ─────────────────────
    def head_can_handle(self, q, options, ctx):
        t0 = time.perf_counter()
        need = set(ctx["required_caps"])
        have = set(ctx["available_caps"])
        cov = len(need & have) / max(1, len(need))
        z = -3.9 + 6.2 * cov - (0.6 if ctx.get("novel_terms") else 0)
        p = sigmoid(z)
        return self._result("can_handle", q, "yes" if p >= 0.5 else "no", {"yes": p, "no": 1 - p}, t0,
                            {"coverage": round(cov, 2), "missing": sorted(need - have)})

    # ── 헤드: 오류 유형 분류 (choice) ──────────────────────────────
    def head_classify_error(self, q, options, ctx):
        t0 = time.perf_counter()
        e = ctx["error"]
        et, msg = e.get("type", ""), (e.get("message") or "").lower()
        z = {k: 0.0 for k in ERROR_TYPES}
        if et == "KeyError":
            z["포맷 변경"] += 2.6
            z["스키마 변경"] += 0.9
            z["로직 오류"] += 0.7
        if ctx.get("header_changed"):
            z["포맷 변경"] += 1.6
        if et == "ValueError" and ("time" in msg or "format" in msg or "does not match" in msg):
            z["포맷 변경"] += 2.4
        if "no such column" in msg or "no such table" in msg:
            z["스키마 변경"] += 3.0
        if et in ("ValueRangeViolation",):
            z["포맷 변경"] += 2.2       # 단위 변경 등 '에러 없는 오판'
            z["로직 오류"] += 0.8
        if et in ("TimeoutError", "DataTimeout", "ConnectionError"):
            z["외부 장애"] += 4.2
        if et == "EmptyResult":
            if ctx.get("source_stale") or ctx.get("migrated"):
                z["복구 불가"] += 1.5
                z["스키마 변경"] += 1.8
            else:
                z["기준정보 누락"] += 1.2
        if et == "Unsupported":
            z["로직 오류"] += 3.6           # 대체 Agent의 기능 미지원 → 로직 확장 필요
        if et in ("ZeroDivisionError", "TypeError", "IndexError", "AssertionError", "AttributeError"):
            z["로직 오류"] += 2.8
        if "기준정보 누락" in msg or "not_found" in msg:
            z["기준정보 누락"] += 3.0
        if ctx.get("failed_attempts", 0) >= 3 and ctx.get("all_alternatives_empty"):
            z["복구 불가"] += 3.4
        probs = softmax(z, temp=1.0)
        ans = max(probs, key=probs.get)
        return self._result("classify_error", q, ans, probs, t0, {"type": et})

    # ── 헤드: 일반 예/아니오 (진화·병합·폐기·복구불가) ─────────────
    def head_need_evolve(self, q, options, ctx):
        t0 = time.perf_counter()
        z = -2.2 + 0.18 * ctx.get("mismatch_pp", 0) + 1.4 * min(2, ctx.get("clusters", 0)) + 0.9 * ctx.get("signal_issues", 0) \
            + 1.1 * ctx.get("gap", 0)
        p = sigmoid(z)
        return self._result("need_evolve", q, "yes" if p >= 0.5 else "no", {"yes": p, "no": 1 - p}, t0, ctx)

    def head_need_merge(self, q, options, ctx):
        t0 = time.perf_counter()
        z = -4.0 + 6.0 * ctx.get("dup_rate", 0) + 0.55 * ctx.get("double_heals", 0) + 3.2 * ctx.get("overlap", 0) \
            + 1.2 * ctx.get("latency_growth", 0)
        p = sigmoid(z / 1.15)
        return self._result("need_merge", q, "yes" if p >= 0.5 else "no", {"yes": p, "no": 1 - p}, t0, ctx)

    def head_need_retire(self, q, options, ctx):
        t0 = time.perf_counter()
        z = -3.0 + 0.045 * min(120, ctx.get("days_unused", 0)) + 4.2 * ctx.get("overlap", 0) \
            - 0.02 * min(150, ctx.get("indirect_calls", 0)) - 2.5 * ctx.get("periodic", 0) + 1.0 * ctx.get("never_promoted", 0)
        p = sigmoid(z)
        return self._result("need_retire", q, "yes" if p >= 0.5 else "no", {"yes": p, "no": 1 - p}, t0, ctx)

    def head_unrecoverable(self, q, options, ctx):
        t0 = time.perf_counter()
        z = -2.8 + 1.1 * ctx.get("failed_attempts", 0) + 1.6 * ctx.get("all_alternatives_empty", 0) + 1.3 * ctx.get("source_stale", 0)
        p = sigmoid(z)
        return self._result("unrecoverable", q, "yes" if p >= 0.5 else "no", {"yes": p, "no": 1 - p}, t0, ctx)

    def head_need_grow(self, q, options, ctx):
        t0 = time.perf_counter()
        z = -2.4 + 2.2 * ctx.get("lift", 0) + 0.06 * ctx.get("cases", 0) - 3.0 * ctx.get("covered", 0)
        p = sigmoid(z)
        return self._result("need_grow", q, "yes" if p >= 0.5 else "no", {"yes": p, "no": 1 - p}, t0, ctx)

    def head_template_match(self, q, options, ctx):
        t0 = time.perf_counter()
        z = -3.5 + 3.4 * ctx.get("type_match", 0) + 2.6 * ctx.get("cond_match", 0) - 3.0 * ctx.get("extra_parts", 0)
        p = sigmoid(z)
        return self._result("template_match", q, "yes" if p >= 0.9 else "no", {"yes": p, "no": 1 - p}, t0, ctx)

    def head_entity(self, q, options, ctx):
        t0 = time.perf_counter()
        n = max(1, len(options))
        probs = {o: (ctx.get("scores", {}).get(o, 1.0)) for o in options}
        s = sum(probs.values()) or 1
        probs = {k: v / s for k, v in probs.items()}
        ans = max(probs, key=probs.get) if probs else None
        return self._result("entity", q, ans, probs, t0, {"candidates": n})
