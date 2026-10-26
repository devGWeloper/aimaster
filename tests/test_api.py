"""운영 API(ui/server.py) 스모크 테스트 — 프론트엔드(ui/web)가 의존하는 엔드포인트의 응답 형태를 고정한다.

격리된 runtime 디렉터리(AUTOQUAL_RUNTIME)에서 System 을 초기화하므로 실제 runtime/ 을 건드리지 않는다.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="aq-api-")
os.environ["AUTOQUAL_RUNTIME"] = _TMP

from fastapi.testclient import TestClient  # noqa: E402

from ui import server  # noqa: E402


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(server.app)

    def test_health_and_state(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertIn("clock", body)
        st = self.client.get("/api/state").json()
        for key in ("clock", "speed", "approval_mode", "story", "registry", "approvals", "fab", "policy", "counts", "last_seq"):
            self.assertIn(key, st)
        self.assertEqual(len(st["fab"]), 90)                     # 장비 30 × 챔버 3
        ids = {a["agent_id"] for a in st["registry"]["agents"]}
        self.assertTrue({"super_agent", "spec_agent", "log_agent", "legacy_agent"} <= ids)
        self.assertEqual(len(st["story"]["chapters"]), 12)

    def test_index_serves_frontend_build_or_503(self):
        r = self.client.get("/")
        dist = Path(server.DIST) / "index.html"
        if dist.exists():
            self.assertEqual(r.status_code, 200)
            self.assertIn("<div id=\"root\">", r.text)
        else:
            self.assertEqual(r.status_code, 503)

    def test_reports_full_and_lineage_shapes(self):
        rows = self.client.get("/api/reports/full?limit=5").json()
        self.assertIsInstance(rows, list)
        for r in rows:
            for key in ("report_id", "kind", "title", "ts", "content"):
                self.assertIn(key, r)
        lin = self.client.get("/api/lineage").json()
        self.assertTrue(any(x["kind"] == "baseline" for x in lin))
        self.assertTrue(all({"agent_id", "from_version", "to_version", "kind", "ts"} <= set(x) for x in lin))

    def test_genome_and_kpi(self):
        g = self.client.get("/api/genome/log_agent").json()
        self.assertEqual(g["agent"]["agent_id"], "log_agent")
        self.assertIn("code", g["genome"])
        self.assertTrue(g["versions"])
        k = self.client.get("/api/kpi").json()
        self.assertIn("unapproved", k)
        self.assertEqual(k["unapproved"]["value"], 0)

    def test_chat_requires_text(self):
        r = self.client.post("/api/chat", json={"text": ""})
        self.assertEqual(r.status_code, 400)

    def test_control_endpoints(self):
        self.assertEqual(self.client.post("/api/speed", json={"speed": 2}).json()["speed"], 2.0)
        self.assertEqual(self.client.post("/api/approval_mode", json={"mode": "auto"}).json()["mode"], "auto")
        self.assertEqual(self.client.post("/api/approval_mode", json={"mode": "manual"}).json()["mode"], "manual")
        r = self.client.post("/api/approval/APR-9999", json={"approved": True, "approver": "테스트"})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
