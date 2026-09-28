import importlib.util
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "nk_api_probe",
    Path(__file__).resolve().parents[3] / "scripts/probe_nk_genios_api.py",
)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_default_only_reads_configuration(self):
        calls = []

        def request(endpoint, body, key, timeout):
            calls.append((endpoint, body))
            return {"Name": "Test"}

        report = probe.run_probe("fake-test-key", request_fn=request)
        self.assertTrue(report["ok"])
        self.assertEqual([c[0] for c in calls], ["get_app_config_preview"])
        self.assertEqual(len(calls[0][1]["UserID"]), 20)
        self.assertNotIn("fake-test-key", json.dumps(report))

    def test_chat_reuses_conversation_and_confirms_context(self):
        calls = []
        marker = ""

        def request(endpoint, body, key, timeout):
            nonlocal marker
            calls.append((endpoint, body))
            if endpoint == "get_app_config_preview":
                return {"Name": "Test"}
            if endpoint == "create_conversation":
                return {"Conversation": {"AppConversationID": "test-conversation"}}
            if not marker:
                marker = body["Query"].split("代号 ")[1].split("，")[0]
                return {"event": "message", "answer": "已记录"}
            return {"event": "message", "answer": marker}

        report = probe.run_probe("fake-test-key", chat=True, request_fn=request)
        self.assertTrue(report["ok"])
        self.assertEqual(len(calls), 4)
        self.assertEqual(len({body["UserID"] for _, body in calls}), 1)
        for _, body in calls[2:]:
            self.assertEqual(body["AppConversationID"], "test-conversation")
            self.assertEqual(body["ResponseMode"], "blocking")
        self.assertNotIn(marker, json.dumps(report))

    def test_model_failure_and_empty_answers_are_not_success(self):
        for result in [
            {"event": "message_failed", "answer": "error text"},
            {"event": "message", "answer": ""},
            {"event": "message", "answer": "   "},
        ]:
            with self.subTest(result=result):

                def request(endpoint, body, key, timeout, result=result):
                    if endpoint == "get_app_config_preview":
                        return {"Name": "Test"}
                    if endpoint == "create_conversation":
                        return {
                            "Conversation": {"AppConversationID": "test-conversation"}
                        }
                    return result

                report = probe.run_probe("fake-test-key", chat=True, request_fn=request)
                self.assertFalse(report["ok"])
                self.assertEqual(report["checks"][2]["code"], "NO_FINAL_ANSWER")

    def test_unconfirmed_context_is_not_reported_as_pass(self):
        def request(endpoint, body, key, timeout):
            if endpoint == "get_app_config_preview":
                return {"Name": "Test"}
            if endpoint == "create_conversation":
                return {"Conversation": {"AppConversationID": "test-conversation"}}
            return {"event": "message", "answer": "不知道测试代号"}

        report = probe.run_probe("fake-test-key", chat=True, request_fn=request)
        self.assertFalse(report["ok"])
        self.assertEqual(report["checks"][3]["code"], "CONTEXT_NOT_CONFIRMED")

    def test_http_never_follows_redirects_or_replays_key(self):
        requests_seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests_seen.append(
                    (self.path, self.headers.get("Apikey"), self.headers.get("Cookie"))
                )
                self.send_response(self.server.redirect_status)
                self.send_header(
                    "Location",
                    f"http://127.0.0.1:{self.server.server_port}/sink?secret=fake-test-key",
                )
                self.end_headers()

            def do_GET(self):
                requests_seen.append((self.path, None, None))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with (
                patch.object(
                    probe, "BASE_URL", f"http://127.0.0.1:{server.server_port}"
                ),
                patch.dict("os.environ", {"no_proxy": "127.0.0.1"}),
            ):
                for status in (301, 302, 303, 307, 308):
                    server.redirect_status = status
                    with self.assertRaisesRegex(probe.ProbeError, "^REDIRECT_BLOCKED$"):
                        probe.request_json(
                            "get_app_config_preview",
                            {"UserID": "test"},
                            "fake-test-key",
                            2,
                        )
            self.assertEqual(len(requests_seen), 5)
            self.assertTrue(
                all(path == "/get_app_config_preview" for path, _, _ in requests_seen)
            )
            self.assertTrue(
                all(
                    key == "fake-test-key" and cookie is None
                    for _, key, cookie in requests_seen
                )
            )
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
