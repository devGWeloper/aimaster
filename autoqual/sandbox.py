"""CodeAct 실행 런타임 (execute_code) — 샌드박스.

- AST 정적 검사: 허용 import 화이트리스트, dunder/private 속성 접근 차단, 위험 내장함수 차단,
  평가 하네스·Mock 환경·런타임 내부 모듈 접근 시도 탐지(Reward Hacking 차단)
- 제한된 builtins + 가드된 __import__
- 도구 접근은 권한 프록시(ToolProxy)로만: Agent Genome에 선언된 도구만 호출 가능, 모든 호출 감사 기록
- 타임아웃: 워치독이 실행 스레드에 비동기 예외 주입
- 감사 로그: 코드 해시·소요·도구 호출·차단 사유
"""
from __future__ import annotations

import ast
import builtins
import ctypes
import hashlib
import threading
import time
import traceback
from dataclasses import dataclass, field

ALLOWED_IMPORTS = {"math", "statistics", "re", "json", "datetime", "collections", "itertools", "functools",
                   "bisect", "heapq", "decimal", "fractions", "string", "textwrap", "difflib", "operator", "typing"}
HARNESS_MODULES = {"eval", "mock_env", "autoqual", "tests"}
BANNED_NAMES = {"eval", "exec", "compile", "open", "globals", "locals", "vars", "getattr", "setattr", "delattr",
                "input", "breakpoint", "help", "exit", "quit", "memoryview", "__import__", "__builtins__", "__loader__",
                "__spec__", "object", "type", "super", "classmethod", "staticmethod", "property"}
BANNED_ATTRS = {"format", "format_map", "gi_frame", "gi_code", "cr_frame", "ag_frame", "f_back", "f_globals", "f_locals",
                "f_builtins", "f_code", "tb_frame", "tb_next", "co_code", "co_consts", "func_globals", "mro"}
SAFE_BUILTINS = ["abs", "all", "any", "bool", "dict", "enumerate", "filter", "float", "int", "len", "list", "map", "max",
                 "min", "range", "reversed", "round", "set", "sorted", "str", "sum", "tuple", "zip", "isinstance", "frozenset",
                 "divmod", "pow", "repr", "hash", "iter", "next", "chr", "ord", "slice", "callable", "hasattr",
                 "Exception", "ValueError", "KeyError", "TypeError", "IndexError", "ZeroDivisionError", "RuntimeError",
                 "StopIteration", "AssertionError", "ArithmeticError", "LookupError", "NotImplementedError", "AttributeError",
                 "True", "False", "None"]


class SandboxViolation(Exception):
    def __init__(self, violations: list[dict]):
        self.violations = violations
        super().__init__("; ".join(v["msg"] for v in violations))


class SandboxTimeout(Exception):
    pass


class PermissionDenied(Exception):
    pass


@dataclass
class ExecResult:
    ok: bool
    result: object = None
    stdout: str = ""
    error: dict | None = None
    elapsed_ms: float = 0.0
    audit_id: str = ""
    tool_calls: list = field(default_factory=list)
    code_hash: str = ""


# ── 정적 검사 ──────────────────────────────────────────────────────
def static_check(code: str) -> list[dict]:
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [{"rule": "syntax", "msg": f"SyntaxError: {e.msg} (line {e.lineno})", "line": e.lineno}]
    out = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for n in names:
                root = n.split(".")[0]
                if root in HARNESS_MODULES:
                    out.append({"rule": "harness_access", "msg": f"평가 하네스/런타임 모듈 접근 시도: import {n}", "line": node.lineno})
                elif root not in ALLOWED_IMPORTS:
                    out.append({"rule": "import", "msg": f"허용되지 않은 import: {n}", "line": node.lineno})
        elif isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            out.append({"rule": "private_attr", "msg": f"private/dunder 속성 접근 차단: .{node.attr}", "line": node.lineno})
        elif isinstance(node, ast.Attribute) and node.attr in BANNED_ATTRS:
            out.append({"rule": "banned_attr", "msg": f"샌드박스 탈출 위험 속성 차단: .{node.attr}", "line": node.lineno})
        elif isinstance(node, ast.Name) and (node.id in BANNED_NAMES or (node.id.startswith("__") and node.id.endswith("__"))):
            out.append({"rule": "banned_name", "msg": f"금지된 이름 사용: {node.id}", "line": node.lineno})
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            v = node.value.lower()
            if "ground_truth" in v or "eval/harness" in v or "policy.json" in v:
                out.append({"rule": "harness_access", "msg": "평가 하네스/정답 경로 문자열 참조", "line": node.lineno})
    return out


class _Canon(ast.NodeTransformer):
    """블랙리스트 비교용 AST 정규화: docstring 제거, 지역 식별자 일괄 치환."""

    def __init__(self):
        self.names: dict[str, str] = {}

    def _n(self, name):
        if name not in self.names:
            self.names[name] = f"v{len(self.names)}"
        return self.names[name]

    def visit_FunctionDef(self, node):
        if node.body and isinstance(node.body[0], ast.Expr) and isinstance(getattr(node.body[0], "value", None), ast.Constant) \
                and isinstance(node.body[0].value.value, str):
            node.body = node.body[1:] or [ast.Pass()]
        for a in node.args.args:
            a.arg = self._n(a.arg)
        self.generic_visit(node)
        return node

    def visit_Name(self, node):
        if node.id not in dir(builtins):
            node.id = self._n(node.id)
        return node


def canonical_hash(code: str) -> str:
    try:
        tree = ast.parse(code)
        if tree.body and isinstance(tree.body[0], ast.Expr) and isinstance(getattr(tree.body[0], "value", None), ast.Constant):
            tree.body = tree.body[1:]
        tree = _Canon().visit(tree)
        dumped = ast.dump(tree, annotate_fields=False, include_attributes=False)
    except SyntaxError:
        dumped = " ".join(code.split())
    return hashlib.sha256(dumped.encode()).hexdigest()[:16]


def code_hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()[:12]


# ── 권한 프록시 ────────────────────────────────────────────────────
class ToolProxy:
    """선언된 도구만 노출하는 읽기 전용 권한 프록시. 모든 호출을 기록한다."""

    def __init__(self, impl: dict, allowed: set[str], recorder: list):
        self.__dict__["_impl"] = impl
        self.__dict__["_allowed"] = allowed
        self.__dict__["_rec"] = recorder

    def __getattr__(self, name):
        if name not in self._allowed or name not in self._impl:
            self._rec.append({"tool": name, "denied": True})
            raise PermissionDenied(f"권한 프록시: 도구 '{name}' 사용 권한 없음")
        fn = self._impl[name]
        rec = self._rec

        def call(*a, **kw):
            t0 = time.perf_counter()
            try:
                return fn(*a, **kw)
            finally:
                rec.append({"tool": name, "ms": round((time.perf_counter() - t0) * 1000, 2)})
        return call

    def __setattr__(self, k, v):
        raise PermissionDenied("권한 프록시는 수정할 수 없습니다")


class Namespace:
    """스킬 등 읽기 전용 네임스페이스."""

    def __init__(self, d: dict):
        self.__dict__["_d"] = d

    def __getattr__(self, k):
        try:
            return self._d[k]
        except KeyError:
            raise AttributeError(k)

    def __setattr__(self, k, v):
        raise PermissionDenied("읽기 전용 네임스페이스")


# ── 실행 ───────────────────────────────────────────────────────────
_INTERNAL_OK = {"_strptime", "time", "locale", "calendar", "_datetime", "_locale", "encodings", "_decimal", "_pydecimal"}


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in ALLOWED_IMPORTS and root not in _INTERNAL_OK:   # 표준 라이브러리 내부 지연 import 허용 (사용자 코드는 AST 검사로 차단)
        raise ImportError(f"sandbox: import '{name}' 차단")
    return builtins.__import__(name, globals, locals, fromlist, level)


def _make_builtins(printer):
    b = {k: getattr(builtins, k) for k in SAFE_BUILTINS if hasattr(builtins, k)}
    b["__import__"] = _guarded_import
    b["__build_class__"] = builtins.__build_class__
    b["__name__"] = "sandbox"
    b["print"] = printer
    return b


def _async_raise(tid: int, exc):
    ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(tid), ctypes.py_object(exc))


class Sandbox:
    def __init__(self, audit_sink=None):
        self._compiled: dict[str, object] = {}
        self._checked: dict[str, list] = {}
        self.audit_sink = audit_sink          # callable(dict)
        self._seq = 0
        self._lock = threading.Lock()
        self.stats = {"executions": 0, "blocked": 0, "timeouts": 0, "errors": 0}

    def check(self, code: str) -> list[dict]:
        h = code_hash(code)
        if h not in self._checked:
            self._checked[h] = static_check(code)
        return self._checked[h]

    def _compile(self, code: str, filename: str):
        h = code_hash(code)
        c = self._compiled.get(h)
        if c is None:
            c = compile(code, filename, "exec")
            self._compiled[h] = c
        return c, h

    def execute(self, code: str, agent_id: str, version: str, entry: str | None, args: tuple = (),
                globals_extra: dict | None = None, timeout_s: float = 10.0, tool_calls: list | None = None,
                replay: bool = False, vts: str | None = None) -> ExecResult:
        with self._lock:
            self._seq += 1
            audit_id = f"AU-{self._seq:07d}"
        self.stats["executions"] += 1
        tool_calls = tool_calls if tool_calls is not None else []
        violations = self.check(code)
        h = code_hash(code)
        if violations:
            self.stats["blocked"] += 1
            res = ExecResult(False, error={"type": "SandboxViolation", "message": "; ".join(v["msg"] for v in violations),
                                           "violations": violations, "traceback": ""}, audit_id=audit_id, code_hash=h)
            self._audit(res, agent_id, version, replay, vts, blocked=violations)
            return res
        out_lines: list[str] = []

        def printer(*a, **kw):
            if len(out_lines) < 400:
                out_lines.append(" ".join(str(x) for x in a))

        g = {"__builtins__": _make_builtins(printer)}
        if globals_extra:
            g.update(globals_extra)
        compiled, h = self._compile(code, f"<genome:{agent_id}@{version}>")
        tid = threading.get_ident()
        done = threading.Event()
        timed_out = []

        def watchdog():
            if not done.wait(timeout_s):
                timed_out.append(True)
                _async_raise(tid, SandboxTimeout)

        wd = threading.Thread(target=watchdog, daemon=True)
        t0 = time.perf_counter()
        wd.start()
        try:
            exec(compiled, g)
            result = g[entry](*args) if entry else g.get("result")
            done.set()
            res = ExecResult(True, result=result, stdout="\n".join(out_lines), elapsed_ms=(time.perf_counter() - t0) * 1000,
                             audit_id=audit_id, tool_calls=tool_calls, code_hash=h)
        except BaseException as e:  # noqa: BLE001 — 샌드박스 안의 모든 예외를 구조화해 반환
            done.set()
            if isinstance(e, SandboxTimeout) or timed_out:
                self.stats["timeouts"] += 1
                err = {"type": "SandboxTimeout", "message": f"실행 제한 시간 {timeout_s}s 초과", "traceback": ""}
            else:
                self.stats["errors"] += 1
                tb = traceback.extract_tb(e.__traceback__)
                frames = [f for f in tb if f.filename.startswith("<genome")]
                line = frames[-1].lineno if frames else None
                err = {"type": type(e).__name__, "message": str(e), "line": line,
                       "traceback": "".join(traceback.format_list(frames[-4:])) if frames else "",
                       "key": e.args[0] if isinstance(e, KeyError) and e.args else None}
            res = ExecResult(False, error=err, stdout="\n".join(out_lines), elapsed_ms=(time.perf_counter() - t0) * 1000,
                             audit_id=audit_id, tool_calls=tool_calls, code_hash=h)
        self._audit(res, agent_id, version, replay, vts)
        return res

    def load_module(self, code: str, name: str) -> dict:
        """스킬 모듈 로드: 정적 검사 후 제한된 builtins로 실행, 공개 함수만 반환."""
        violations = self.check(code)
        if violations:
            raise SandboxViolation(violations)
        g = {"__builtins__": _make_builtins(lambda *a, **k: None)}
        compiled, _ = self._compile(code, f"<genome:{name}>")
        exec(compiled, g)
        return {k: v for k, v in g.items() if callable(v) and not k.startswith("_") and k[0].islower()}

    def _audit(self, res: ExecResult, agent_id, version, replay, vts, blocked=None):
        if self.audit_sink:
            self.audit_sink({"audit_id": res.audit_id, "ts": vts, "agent_id": agent_id, "version": version,
                             "code_hash": res.code_hash, "elapsed_ms": round(res.elapsed_ms, 3), "ok": int(res.ok),
                             "error": (res.error or {}).get("type"), "tool_calls": [c["tool"] for c in res.tool_calls][:30],
                             "blocked": blocked, "replay": int(replay)})
