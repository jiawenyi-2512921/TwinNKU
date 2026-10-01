import logging
from uuid import uuid4

import pytest

from app.core.errors import DomainError
from app.integrations.chat_runtime import ChatRuntime
from app.integrations.nk_api import ProbeError

CODE = "test-only-runtime-access-code"


def assert_released(runtime, session):
    assert not session.lock.locked()
    acquired = [runtime.slots.acquire(blocking=False) for _ in range(4)]
    assert all(acquired)
    for _ in acquired:
        runtime.slots.release()


@pytest.mark.parametrize(
    ("failed_stage", "error_code", "message"),
    [
        ("create_conversation", "AGENT_CONVERSATION_TIMEOUT", "创建会话超时"),
        ("chat_query_v2", "AGENT_REPLY_TIMEOUT", "等待回答超时"),
    ],
)
def test_timeouts_identify_stage_and_do_not_repeat_unknown_result(
    failed_stage,
    error_code,
    message,
    caplog,
):
    calls = []

    def upstream(endpoint, body, key, timeout):
        calls.append((endpoint, timeout))
        if endpoint == failed_stage:
            raise ProbeError("NETWORK_TIMEOUT")
        return {"Conversation": {"AppConversationID": "private-conversation"}}

    runtime = ChatRuntime("private-api-key", CODE, upstream)
    _, session = runtime.login(CODE)
    trace_id = uuid4()
    with caplog.at_level(logging.INFO, logger="twinnku.agent"):
        with pytest.raises(DomainError) as failure:
            runtime.generate(
                session, "turn", {"query": "private-question"}, "private-prompt", trace_id=trace_id
            )
    assert failure.value.code == error_code
    assert failure.value.status == 503 and message in failure.value.message
    assert calls == (
        [("create_conversation", 30)]
        if failed_stage == "create_conversation"
        else [("create_conversation", 30), ("chat_query_v2", 60)]
    )
    assert f"request_id={trace_id} stage={failed_stage} reason=NETWORK_TIMEOUT" in caplog.text
    assert "duration_ms=" in caplog.text
    for private in [
        "private-api-key",
        "private-prompt",
        "private-question",
        "private-conversation",
        session.user,
        CODE,
    ]:
        assert private not in caplog.text
    before = list(calls)
    with pytest.raises(DomainError) as replay:
        runtime.generate(session, "turn", {"query": "private-question"}, "private-prompt")
    assert replay.value.code == "RESULT_UNKNOWN" and calls == before
    assert_released(runtime, session)


@pytest.mark.parametrize("reason", ["NETWORK_ERROR", "TLS_ERROR", "TRANSPORT_ERROR"])
def test_connection_failures_are_specific_and_release_capacity(reason, caplog):
    calls = []

    def upstream(endpoint, body, key, timeout):
        calls.append(endpoint)
        raise ProbeError(reason)

    runtime = ChatRuntime("private-api-key", CODE, upstream)
    _, session = runtime.login(CODE)
    with caplog.at_level(logging.INFO, logger="twinnku.agent"):
        with pytest.raises(DomainError) as failure:
            runtime.generate(session, "turn", {}, "private-prompt", trace_id=uuid4())
    assert failure.value.code == "AGENT_UPSTREAM_CONNECTION_FAILED"
    assert "无法连通学校对话服务" in failure.value.message
    assert calls == ["create_conversation"]
    assert f"stage=create_conversation reason={reason}" in caplog.text
    assert_released(runtime, session)


def test_reused_conversation_keeps_budget_and_logs_actual_stage_duration(monkeypatch, caplog):
    clock = [1000.0]
    monkeypatch.setattr("app.integrations.chat_runtime.time.monotonic", lambda: clock[0])
    calls = []

    def upstream(endpoint, body, key, timeout):
        calls.append((endpoint, timeout, body.get("ResponseMode")))
        if endpoint == "create_conversation":
            clock[0] += 0.125
            return {"Conversation": {"AppConversationID": "private-conversation"}}
        clock[0] += 0.25
        return {"event": "message", "answer": "private-answer"}

    runtime = ChatRuntime("private-api-key", CODE, upstream)
    _, session = runtime.login(CODE)
    trace_id = uuid4()
    with caplog.at_level(logging.INFO, logger="twinnku.agent"):
        assert (
            runtime.generate(session, "first", {}, "private-prompt", trace_id=trace_id)
            == "private-answer"
        )
        assert (
            runtime.generate(session, "second", {}, "private-prompt", trace_id=trace_id)
            == "private-answer"
        )
        assert (
            runtime.generate(session, "second", {}, "private-prompt", trace_id=trace_id)
            == "private-answer"
        )
    assert calls == [
        ("create_conversation", 30, None),
        ("chat_query_v2", 60, "blocking"),
        ("chat_query_v2", 60, "blocking"),
    ]
    assert len(caplog.records) == 3
    assert "stage=create_conversation reason=SUCCESS duration_ms=125.0" in caplog.text
    assert caplog.text.count("stage=chat_query_v2 reason=SUCCESS duration_ms=250.0") == 2
    for private in [
        "private-api-key",
        "private-prompt",
        "private-answer",
        session.user,
        "private-conversation",
        CODE,
    ]:
        assert private not in caplog.text
    assert_released(runtime, session)


@pytest.mark.parametrize(
    "untrusted_reason", ["private-upstream-text\nAUTH_FAILED private-api-key", "SUCCESS"]
)
def test_unrecognized_upstream_exception_text_and_invalid_trace_are_not_logged(
    caplog, untrusted_reason
):
    def upstream(endpoint, body, key, timeout):
        raise ProbeError(untrusted_reason)

    runtime = ChatRuntime("private-api-key", CODE, upstream)
    _, session = runtime.login(CODE)
    with caplog.at_level(logging.INFO, logger="twinnku.agent"):
        with pytest.raises(DomainError) as failure:
            runtime.generate(session, "turn", {}, "private-prompt", trace_id="private-trace")
    assert failure.value.code == "AGENT_UPSTREAM_UNAVAILABLE"
    assert "request_id=- stage=create_conversation reason=UNKNOWN" in caplog.text
    assert all(record.levelno == logging.WARNING for record in caplog.records)
    for private in ["private-upstream-text", "private-api-key", "private-trace", "AUTH_FAILED"]:
        assert private not in caplog.text
    assert_released(runtime, session)


def test_invalid_conversation_shape_is_a_classified_failure(caplog):
    runtime = ChatRuntime(
        "private-api-key", CODE, lambda *args: {"Conversation": "private-upstream-text"}
    )
    _, session = runtime.login(CODE)
    with caplog.at_level(logging.INFO, logger="twinnku.agent"):
        with pytest.raises(DomainError) as failure:
            runtime.generate(session, "turn", {}, "private-prompt", trace_id=uuid4())
    assert failure.value.code == "AGENT_UPSTREAM_UNAVAILABLE"
    assert "reason=INVALID_CONVERSATION_RESPONSE" in caplog.text
    assert "private-upstream-text" not in caplog.text
    assert_released(runtime, session)
