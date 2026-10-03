import subprocess
import sys
import textwrap


def run_isolated(source):
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(source)],
        capture_output=True,
        text=True,
        check=True,
        # This checks logger ownership and sensitive-data exclusion, not startup
        # latency. Cold application imports on CPU-limited Linux runners can
        # exceed 15 seconds; retain a bounded allowance independent of API timeouts.
        timeout=90,
    )


def test_default_uvicorn_logging_emits_safe_stage_and_request_metadata():
    result = run_isolated("""
        from uuid import UUID
        from uvicorn import Config
        Config("app.main:app", access_log=False).configure_logging()

        from fastapi.testclient import TestClient
        from app.core.config import Settings
        from app.integrations.chat_runtime import ChatRuntime
        from app.main import create_app

        def upstream(endpoint, body, key, timeout):
            if endpoint == "create_conversation":
                return {"Conversation": {"AppConversationID": "private-conversation"}}
            return {"event": "message", "answer": "private-answer"}

        runtime = ChatRuntime("private-api-key", "private-access-code", upstream)
        _, visitor = runtime.login("private-access-code")
        runtime.generate(visitor, "private-turn", {}, "private-prompt",
                         trace_id=UUID("e4656c2e-412b-49ea-95b9-4d098d312b03"))
        with TestClient(create_app(Settings(app_env="test"))) as client:
            response = client.get("/health/live")
            assert response.status_code == 200
            print(response.headers["x-request-id"])
    """)
    assert (
        "INFO twinnku.agent agent_upstream request_id=e4656c2e-412b-49ea-95b9-4d098d312b03"
        in result.stderr
    )
    assert "stage=create_conversation reason=SUCCESS duration_ms=" in result.stderr
    assert "stage=chat_query_v2 reason=SUCCESS duration_ms=" in result.stderr
    assert (
        f"INFO twinnku request id={result.stdout.strip()} method=GET status=200 duration_ms="
        in result.stderr
    )
    for private in [
        "private-api-key",
        "private-access-code",
        "private-conversation",
        "private-answer",
        "private-turn",
        "private-prompt",
    ]:
        assert private not in result.stderr


def test_existing_application_handler_and_level_are_preserved_without_duplicates():
    result = run_isolated("""
        import logging
        from uvicorn import Config
        Config("app.main:app", access_log=False).configure_logging()
        logger = logging.getLogger("twinnku")
        logger.setLevel(logging.WARNING)
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("custom %(message)s"))
        logger.addHandler(handler)
        from app.core.config import Settings
        from app.main import create_app
        create_app(Settings(app_env="test"))
        create_app(Settings(app_env="test"))
        assert logger.handlers == [handler]
        assert logger.level == logging.WARNING
        logger.info("info-hidden-by-external-policy")
        logger.warning("warning-once")
    """)
    assert result.stderr == "custom warning-once\n"


def test_later_parent_handler_receives_one_record_and_application_setup_is_idempotent():
    result = run_isolated("""
        import logging
        from uvicorn import Config
        Config("app.main:app", access_log=False).configure_logging()
        from app.core.config import Settings
        from app.main import create_app
        logger = logging.getLogger("twinnku")
        create_app(Settings(app_env="test"))
        create_app(Settings(app_env="test"))
        assert len(logger.handlers) == 1
        assert logger.level == logging.INFO
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("parent %(message)s"))
        logging.getLogger().addHandler(handler)
        logger.info("info-once")
    """)
    assert result.stderr == "parent info-once\n"
