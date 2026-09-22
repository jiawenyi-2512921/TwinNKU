from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.contracts import XY, AgentAction, ChatTurnRequest, MediaRegistration, TourPlanRequest
from app.core.config import Settings
from app.main import create_app


def test_production_rejects_unsafe_configuration():
    for kwargs in [
        {"database_url": "sqlite:///test.db"},
        {"db_password": "short"},
        {"db_password": "change-me-to-a-random-48-character-hex-value"},
        {"db_password": "e7a946ea56434bd2823eabb10b4d4a77", "allowed_hosts": ["*"]},
    ]:
        with pytest.raises(ValidationError):
            Settings(app_env="production", **kwargs)


def test_production_disables_interactive_docs():
    app = create_app(Settings(app_env="production", db_password="e7a946ea56434bd2823eabb10b4d4a77"))
    assert app.docs_url is None and app.openapi_url is None


def test_client_cannot_assign_role_or_executable_action():
    with pytest.raises(ValidationError):
        ChatTurnRequest(
            client_message_id=uuid4(),
            message="介绍这里",
            context={"campus_id": "nku-jinnan", "revision": 1},
            role="admin",
        )
    with pytest.raises(ValidationError):
        AgentAction(
            action_id=uuid4(),
            type="run_code",
            resource_id=uuid4(),
            resource_revision=1,
            context_revision=1,
            requires_user_gesture=False,
        )


def test_walking_requires_start_and_coordinates_are_finite():
    with pytest.raises(ValidationError):
        TourPlanRequest(campus_id="nku-jinnan", mode="walking", theme="校史", duration_minutes=20)
    for value in [-1, float("nan"), float("inf")]:
        with pytest.raises(ValidationError):
            XY(x=value, y=1)


def test_media_location_must_be_unambiguous():
    fields = {"kind": "image", "title": "示例", "visibility": "public", "rights_note": "测试"}
    with pytest.raises(ValidationError):
        MediaRegistration(**fields)
    with pytest.raises(ValidationError):
        MediaRegistration(
            **fields, external_url="https://example.com/a.png", uploaded_file_id=uuid4()
        )
