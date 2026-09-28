"""Local boundary tests use a stub API; they do not prove school connectivity."""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import deploy
from deploy import patch_nginx
from probe_nk_genios_api import ProbeError
from server import COOKIE, Chat, Demo, Failure, Server

CODE = "test-demo-code-123456"


class DemoTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def upstream(endpoint, body, key, timeout):
            self.calls.append((endpoint, body.copy()))
            if endpoint == "create_conversation":
                return {"Conversation": {"AppConversationID": "conv-" + body["UserID"]}}
            return {
                "event": "message",
                "answer": "<script>test</script>",
                "think_messages": ["private trace"],
            }

        self.demo = Demo("fake-key", CODE, "https://2512921.cn", upstream)

    def session(self):
        token = self.demo.login(CODE)
        return self.demo.session(f"{COOKIE}={token}")

    def test_conversations_and_request_ids_are_isolated(self):
        a, b = self.session(), self.session()
        body = Chat(query="test", request_id="same-request-12345")
        one = self.demo.chat(a, body)
        self.assertEqual(one, self.demo.chat(a, body))
        self.demo.chat(a, Chat(query="next", request_id="second-request-12345"))
        self.demo.chat(b, body)
        self.assertEqual(len(self.calls), 5)
        self.assertNotEqual(a.user, b.user)
        self.assertEqual(len(a.user), 20)
        self.assertNotEqual(a.conversation, b.conversation)
        self.assertEqual(
            self.calls[1][1]["AppConversationID"], self.calls[2][1]["AppConversationID"]
        )
        self.assertEqual(one.model_dump(), {"answer": "<script>test</script>"})
        with self.assertRaises(Failure) as error:
            self.demo.chat(a, Chat(query="changed", request_id=body.request_id))
        self.assertEqual(error.exception.code, "REQUEST_ID_REUSED")

    def test_unknown_upstream_result_is_not_retried(self):
        def broken(*args):
            raise ProbeError("NETWORK_TIMEOUT")

        self.demo.upstream = broken
        a = self.session()
        body = Chat(query="test", request_id="timeout-request-123")
        with self.assertRaises(Failure) as error:
            self.demo.chat(a, body)
        self.assertEqual(error.exception.code, "NETWORK_TIMEOUT")
        with self.assertRaises(Failure) as error:
            self.demo.chat(a, body)
        self.assertEqual(error.exception.code, "PREVIOUS_RESULT_UNKNOWN")

    def test_expired_and_inflight_sessions(self):
        a = self.session()
        body = Chat(query="test", request_id="inflight-request-123")
        a.lock.acquire()
        try:
            with self.assertRaises(Failure) as error:
                self.demo.chat(a, body)
            self.assertEqual(error.exception.status, 409)
        finally:
            a.lock.release()
        token = self.demo.login(CODE)
        self.demo.session(f"{COOKIE}={token}").expires = 0
        with self.assertRaises(Failure) as error:
            self.demo.session(f"{COOKIE}={token}")
        self.assertEqual(error.exception.status, 401)

    def test_http_auth_origin_cookie_and_schema(self):
        server = Server(("127.0.0.1", 0), self.demo)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def post(path, body, *, origin="https://2512921.cn", cookie=""):
            conn = http.client.HTTPConnection(
                "127.0.0.1", server.server_port, timeout=3
            )
            conn.request(
                "POST",
                path,
                json.dumps(body),
                {
                    "Origin": origin,
                    "Content-Type": "application/json",
                    "Cookie": cookie,
                },
            )
            response = conn.getresponse()
            result = (
                response.status,
                dict(response.getheaders()),
                json.loads(response.read()),
            )
            conn.close()
            return result

        try:
            self.assertEqual(
                post(
                    "/agent-demo/login", {"code": CODE}, origin="https://evil.example"
                )[0],
                403,
            )
            body = {"query": "hello", "request_id": "request-1234567890"}
            self.assertEqual(post("/agent-demo/chat", body)[0], 401)
            code, headers, _ = post("/agent-demo/login", {"code": CODE})
            self.assertEqual(code, 200)
            cookie = headers["Set-Cookie"]
            for flag in ("Secure", "HttpOnly", "SameSite=Strict", "Path=/"):
                self.assertIn(flag, cookie)
            self.assertEqual(
                post("/agent-demo/chat", {**body, "UserID": "forged"}, cookie=cookie)[
                    0
                ],
                400,
            )
            status, headers, result = post("/agent-demo/chat", body, cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(set(result), {"answer"})
            self.assertNotIn("fake-key", json.dumps(result))
            self.assertEqual(headers["Cache-Control"], "no-store")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_nginx_patch_keeps_existing_routes(self):
        source = "server { location = /agent/embed.html { try_files $uri =404; } location / { try_files $uri /index.html; } }"
        patched = patch_nginx(source)
        self.assertIn("location / { try_files $uri /index.html; }", patched)
        self.assertEqual(patched.count("proxy_pass http://agent-demo:8100;"), 2)
        with self.assertRaises(RuntimeError):
            patch_nginx(patched)
        with self.assertRaises(RuntimeError):
            patch_nginx("server { location / {} }")

    def test_failed_real_probe_does_not_change_deployment(self):
        with tempfile.TemporaryDirectory() as folder:
            compose = Path(folder) / "compose.yaml"
            compose.write_text("services: {}")
            labels = {
                "com.docker.compose.project.working_dir": folder,
                "com.docker.compose.project.config_files": str(compose),
                "com.docker.compose.config-hash": "testhash",
            }
            web = {
                "Config": {"Labels": labels},
                "NetworkSettings": {"Networks": {"net": {}}},
            }
            api = {"Id": "test-api", "NetworkSettings": {"Networks": {"net": {}}}}
            args = SimpleNamespace(
                state_dir=str(Path(folder) / "state"),
                origin="https://2512921.cn",
                project="twinnku",
            )
            with (
                patch.object(deploy, "inspect_container", side_effect=[web, api]),
                patch.object(
                    deploy, "command", side_effect=["web testhash", "enabled"]
                ) as cmd,
                patch.dict(deploy.os.environ, {"NK_GENIOS_API_KEY": "fake-key"}),
                patch.object(
                    deploy, "run_probe", return_value={"ok": False, "checks": []}
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "has not been modified"):
                    deploy.install(args)
                self.assertEqual(cmd.call_count, 2)
                self.assertFalse(Path(args.state_dir).exists())


if __name__ == "__main__":
    unittest.main()
