"""핵심 불변 규칙 테스트 — python -m unittest discover tests

샌드박스 보안, 결정적 판정(judge_qual) 엣지 케이스, Time-Travel Guard, 엔티티 모호성, 버전 규칙, SC-001 편성.
런타임 저장소는 임시 폴더를 써서 실행 중인 데모에 영향을 주지 않는다.
"""
import shutil
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from autoqual.judge import judge_qual  # noqa: E402
from autoqual.sandbox import Sandbox, ToolProxy, canonical_hash  # noqa: E402

SPECS = [{"item": "LEAK_RATE", "lower": None, "upper": 2.0, "unit": "mTorr/min"},
         {"item": "PARTICLE", "lower": None, "upper": 15, "unit": "ea"},
         {"item": "ER", "lower": 1757.5, "upper": 1942.5, "unit": "A/min"},
         {"item": "ER_UNIF", "lower": None, "upper": 3.0, "unit": "%"}]
CONV = [("nm/min", "A/min", 10.0)]


class TestSandbox(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()

    def run_code(self, code, *args):
        return self.sb.execute(code, "t", "0", "run", args, timeout_s=0.5)

    def test_blocks_os_import(self):
        r = self.run_code("import os\ndef run():\n    return os.listdir('.')\n")
        self.assertFalse(r.ok)
        self.assertEqual(r.error["type"], "SandboxViolation")

    def test_blocks_harness_access(self):
        r = self.run_code("import eval.harness\ndef run():\n    return 1\n")
        self.assertFalse(r.ok)
        self.assertIn("harness", r.error["violations"][0]["rule"])

    def test_blocks_dunder_and_format_escape(self):
        self.assertFalse(self.run_code("def run():\n    return ().__class__\n").ok)
        self.assertFalse(self.run_code("def run(x):\n    return '{0._impl}'.format(x)\n", 1).ok)

    def test_timeout(self):
        r = self.run_code("def run():\n    while True:\n        pass\n")
        self.assertEqual(r.error["type"], "SandboxTimeout")

    def test_permission_proxy(self):
        rec = []
        proxy = ToolProxy({"read": lambda: 1, "write": lambda: 2}, {"read"}, rec)
        r = self.run_code("def run(t):\n    return t.write()\n", proxy)
        self.assertFalse(r.ok)
        self.assertTrue(any(c.get("denied") for c in rec))

    def test_blacklist_hash_ignores_renames(self):
        a = "def f(a):\n    '''doc'''\n    x = a + 1\n    return x\n"
        b = "def f(q):\n    y   =  q + 1\n    return y\n"
        self.assertEqual(canonical_hash(a), canonical_hash(b))


class TestJudge(unittest.TestCase):
    def meas(self, **kw):
        base = {"LEAK_RATE": (0.8, "mTorr/min"), "PARTICLE": (9, "ea"), "ER": (1872, "A/min"), "ER_UNIF": (2.1, "%")}
        base.update(kw)
        return [{"item": k, "value": v, "unit": u} for k, (v, u) in base.items() if v is not None]

    def test_pass(self):
        self.assertEqual(judge_qual("QP", SPECS, self.meas(), CONV)["result"], "PASS")

    def test_boundary_pass(self):
        j = judge_qual("QP", SPECS, self.meas(PARTICLE=(15, "ea")), CONV)
        self.assertEqual(j["result"], "PASS")
        self.assertIn("PARTICLE", j["boundary_pass"])

    def test_unit_conversion(self):
        j = judge_qual("QP", SPECS, self.meas(ER=(187.2, "nm/min")), CONV)
        self.assertEqual(j["result"], "PASS")
        er = next(d for d in j["details"] if d["item"] == "ER")
        self.assertAlmostEqual(er["value"], 1872.0)

    def test_unitless_hold(self):
        j = judge_qual("QP", SPECS, self.meas(ER=(1872, "")), CONV)
        self.assertEqual(j["result"], "HOLD")

    def test_missing_item_never_pass(self):
        j = judge_qual("QP", SPECS, self.meas(ER=(None, None), ER_UNIF=(None, None)), CONV)
        self.assertEqual(j["result"], "INCOMPLETE")
        self.assertIn("ER", j["missing"])

    def test_fail_rework_type(self):
        j = judge_qual("QP", SPECS, self.meas(ER_UNIF=(3.4, "%")), CONV)
        self.assertEqual((j["result"], j["rework_type"]), ("FAIL", "reseason"))
        j = judge_qual("QP", SPECS, self.meas(PARTICLE=(18, "ea")), CONV)
        self.assertEqual(j["rework_type"], "purge")


class TestSystem(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from autoqual.system import System
        cls.tmp = tempfile.mkdtemp(prefix="aq-test-")
        cls.S = System(runtime_dir=Path(cls.tmp))
        cls.S.bus.speed = 0

    @classmethod
    def tearDownClass(cls):
        cls.S.store.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_time_travel_guard_filters_future(self):
        clock = datetime(2024, 1, 15, 12, 0)
        r = self.S.world.legacy_query("SELECT MAX(EVT_TS) FROM QUAL_HIS", None, clock, True)
        self.assertLessEqual(r["rows"][0][0], "2024-01-15 12:00:00")
        self.assertGreater(r["guard_blocked"], 0)

    def test_time_travel_guard_blocks_tables_without_event_ts(self):
        from mock_env.world import GuardBlocked
        with self.assertRaises(GuardBlocked):
            self.S.world.legacy_query("SELECT * FROM QUAL_HIS_OLD", None, datetime(2024, 1, 15), True)
        with self.assertRaises(PermissionError):
            self.S.world.legacy_query("SELECT * FROM lgsrc.QUAL_HIS_OLD", None, datetime(2024, 1, 15), True)

    def test_legacy_is_read_only(self):
        with self.assertRaises(PermissionError):
            self.S.world.legacy_query("DELETE FROM QUAL_HIS", None, datetime(2026, 9, 1), False)

    def test_ambiguous_equipment_asks(self):
        p = self.S.super.parse("7호기 B챔버 Wet Clean 끝났어", datetime(2026, 9, 3, 10, 0))
        self.assertEqual(set(p["ambiguous"]), {"ETCH-07", "CVD-07"})

    def test_version_rules(self):
        reg = self.S.registry
        self.assertEqual(reg.next_version("log_agent", "1.0.0", "patch"), "1.0.1")
        self.assertEqual(reg.next_version("log_agent", "1.0.0", "minor"), "1.1.0")
        self.assertEqual(reg.next_version("log_agent", "1.5.1", "major"), "2.0.0")
        self.assertEqual(reg.next_version("x", "0.3.0", "promote"), "1.0.0")

    def test_sc001_routing(self):
        req = self.S.super.parse("ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘", datetime(2026, 9, 3, 9, 52))
        r = self.S.super.route(req, datetime(2026, 9, 3, 9, 52))
        self.assertEqual(r["selected"], ["spec_agent", "log_agent", "legacy_agent"])
        self.assertEqual(r["can_handle"]["answer"], "yes")

    def test_unsupported_request_needs_grow(self):
        req = self.S.super.parse("지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘", datetime(2026, 9, 10))
        r = self.S.super.route(req, datetime(2026, 9, 10))
        self.assertEqual(r["can_handle"]["answer"], "no")

    def test_baseline_regression_passes(self):
        res = self.S.harness.run_tests("log_agent", "1.0.0")
        self.assertEqual(res["failed"], 0)
        self.assertGreaterEqual(res["total"], 30)

    def test_heal_diagnosis_slices_log(self):
        """SC-003: 진단 CodeAct는 로그 원문 전체가 아니라 헤더·오류 지점 전후·Run별 샘플만 관찰한다."""
        from autoqual.genomes.playbook import DIAG_FORMAT
        from autoqual.sandbox import ToolProxy
        from autoqual.tools import RunContext, make_tools
        clk = datetime(2026, 9, 17, 12)
        f = self.S.world.inject_fault("sw_v52", ["CVD-12"], {"from": "2026-09-17 00:00:00", "tz": {"CVD-12": ""}}, ts=clk)
        try:
            ctx = RunContext(self.S, mode="test", replay_clock=clk, run_shadow=False, quiet=True)
            tools = make_tools(ctx, "healer")
            r = self.S.sandbox.execute(DIAG_FORMAT, "healer", "1.0", None, timeout_s=30, vts="2026-09-17 12:00:00",
                                       globals_extra={"tools": ToolProxy(tools, set(tools) - {"call_agent"}, []), "EQP": "CVD-12",
                                                      "CID": "CVD-12-A", "START": "2026-09-16 12:00:00", "END": "2026-09-17 12:00:00"})
        finally:
            self.S.world.clear_fault(f["fault_id"])
        self.assertTrue(r.ok, r.error)
        sl = r.result["slicing"]
        self.assertTrue(r.result["new_header"].startswith("ts,"))
        self.assertGreater(sl["total_rows"], 10000)
        self.assertEqual(sl["observed"], sl["headers"] + sl["around"] + sl["sample"])
        self.assertLess(sl["observed"] / sl["total_rows"], 0.01)

    def test_grow_edge_cases_catch_naive_agent(self):
        """SC-002: 스키마 탐색으로 만든 엣지 케이스가 정상 케이스는 통과하는 1회차 코드의 결함을 잡는다."""
        from autoqual.genomes.build import make_genome
        from autoqual.loops.l2_grow import BLUEPRINTS, EXPLORE_CODE, test_plan
        from autoqual.sandbox import ToolProxy
        from autoqual.tools import RunContext, make_tools
        clk = "2026-09-10 10:30:00"
        ctx = RunContext(self.S, mode="test", replay_clock=datetime(2026, 9, 10, 10, 30), run_shadow=False, quiet=True)
        proxy = ToolProxy(make_tools(ctx, "factory"), {"inspect_legacy_schema", "query_legacy_db", "resolve_code_value"}, [])
        r = self.S.sandbox.execute(EXPLORE_CODE, "factory", "1.0", None, timeout_s=30, vts=clk,
                                   globals_extra={"tools": proxy, "PATTERN": "PRT%", "COLUMN": "PRT_CD", "NOW": clk})
        self.assertTrue(r.ok, r.error)
        g = {"agent_id": "part_history_agent", "schema": r.result, "clock": clk,
             "request": {"period": {"start": "2026-04-01", "end": "2026-06-30"}, "entities": {"eqp_prefix": "ETCH"}}}
        g["test_plan"] = test_plan(g)
        self.assertEqual(len(g["test_plan"]["normal"]), 5)
        self.assertEqual(len(g["test_plan"]["edges"]), 6)
        reg, bp = self.S.registry, BLUEPRINTS["part_usage"]
        if not reg.agent("part_history_agent"):
            reg.register_agent("part_history_agent", "agent", bp["name_ko"], protected=False, origin="test", card=bp["card"], status="candidate")
        res = {}
        for ver, att in (("0.0.1", bp["attempts"][0]), ("0.0.2", bp["attempts"][1])):
            gen = make_genome(self.S, "part_history_agent", ver, set(att["features"]), [ver])
            reg.add_genome("part_history_agent", ver, gen["code"], params=gen["params"], deps=gen["deps"], tools=gen["tools"],
                           reason="grow", ref="TEST", status="candidate")
            res[ver] = self.S.harness.grow_invariants("part_history_agent", ver, g)
        first = res["0.0.1"]
        self.assertTrue(all(t["ok"] for t in first if t["suite"] != "edge"))                     # 정상 8/8
        self.assertEqual(sorted(t["name"] for t in first if not t["ok"]), ["엣지: 미등록 부품 코드", "엣지: 분/시간 단위 혼재"])
        self.assertEqual(len(res["0.0.2"]), 14)
        self.assertTrue(all(t["ok"] for t in res["0.0.2"]))                                      # 14/14


if __name__ == "__main__":
    unittest.main()
