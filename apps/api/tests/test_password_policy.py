"""Local policy coverage, corrupt-policy fail closure and real credential boundaries."""

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select
from test_admin import BASE, TEST_PASSWORD, login, seed_staff

from app.core.errors import DomainError
from app.models import StaffCredentialRecord, StaffSessionRecord, StaffUserRecord
from app.modules.admin.security import HASHER, hash_password, verify_password
from app.password_policy import (
    ARTIFACT_COUNT,
    ARTIFACT_SHA256,
    BLOCKLIST,
    blocked_hashes,
    validate_password,
)


def test_bundled_corpus_integrity_and_policy_compatible_common_coverage():
    metadata = json.loads(BLOCKLIST.with_suffix(".json").read_text(encoding="utf-8"))
    assert metadata["source_lines"] == 1_000_000
    assert metadata["source_matching_policy_unique"] == 46296
    assert metadata["matching_policy_unique"] == 3000
    assert metadata["breached_sample_candidates"] == 10000
    assert BLOCKLIST.stat().st_size < 1_000_000
    assert (
        metadata["matching_policy_unique"] >= metadata["top_common_matching_policy_minimum"] >= 3000
    )
    assert (
        metadata["artifact_sha256"]
        == hashlib.sha256(BLOCKLIST.read_bytes()).hexdigest()
        == ARTIFACT_SHA256
    )
    assert metadata["artifact_hash_count"] == len(blocked_hashes()) == ARTIFACT_COUNT
    assert metadata["plain_passwords_stored"] is False


@pytest.mark.parametrize(
    "value",
    [
        "123456789012",
        "password1234",
        "PASSWORD1234",
        "Password123456!",
        "Nankai2026!!!",
        "TwInNkU2026!!",
        "南开大学12345678",
        "2512921.cn2026",
    ],
)
def test_known_common_and_context_related_passwords_are_rejected(value):
    with pytest.raises(DomainError) as result:
        hash_password(value)
    assert result.value.code == "PASSWORD_TOO_COMMON"


def test_accepted_password_is_hashed_exactly_including_case_and_unicode():
    value = "自由叙事 MoonLight 2026!"
    hashed = hash_password(value)
    assert verify_password(hashed, value)
    assert not verify_password(hashed, value.casefold())
    assert not verify_password(hashed, value + " ")


def test_missing_or_corrupt_policy_fails_closed_without_reporting_submitted_password(
    monkeypatch, tmp_path
):
    import app.password_policy as policy

    blocked_hashes.cache_clear()
    monkeypatch.setattr(policy, "BLOCKLIST", tmp_path / "missing")
    try:
        with pytest.raises(DomainError) as result:
            validate_password(TEST_PASSWORD)
        assert result.value.code == "PASSWORD_POLICY_UNAVAILABLE"
        assert TEST_PASSWORD not in str(result.value)
        (tmp_path / "missing").write_text("incorrect policy", encoding="ascii")
        with pytest.raises(DomainError) as result:
            validate_password(TEST_PASSWORD)
        assert result.value.code == "PASSWORD_POLICY_UNAVAILABLE"
    finally:
        blocked_hashes.cache_clear()


def test_verified_legacy_password_rehash_does_not_apply_new_password_policy(client, db):
    users, _ = seed_staff(client, db)
    old = "password1234"
    users["editor"].password_hash = PasswordHasher(
        time_cost=1, memory_cost=8192, parallelism=1
    ).hash(old)
    db.commit()
    response = client.post(BASE + "/auth/login", json={"username": "editor", "password": old})
    assert response.status_code == 200
    assert verify_password(users["editor"].password_hash, old)
    assert not HASHER.check_needs_rehash(users["editor"].password_hash)


def test_password_change_endpoint_rejects_known_common_before_credential_mutation(client, db):
    users, _ = seed_staff(client, db)
    login(client, "editor")
    before = users["editor"].password_hash
    response = client.post(
        BASE + "/auth/password",
        json={"current_password": TEST_PASSWORD, "new_password": "password1234"},
    )
    assert response.status_code == 422
    assert users["editor"].password_hash == before


def test_runtime_policy_makes_no_network_calls(monkeypatch):
    import urllib.request

    def forbidden(*args, **kwargs):
        raise AssertionError("Password policy must never call an external service")

    monkeypatch.setattr(urllib.request, "urlopen", forbidden)
    validate_password(TEST_PASSWORD)


def load_rebuilder():
    path = Path(__file__).resolve().parents[3] / "scripts/build_password_blocklist.py"
    spec = importlib.util.spec_from_file_location("build_password_blocklist", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_offline_rebuild_preserves_upstream_frequency_and_bounds_candidate_sets():
    # The source order defines popularity. Alphabetical sorting before selection
    # would incorrectly promote the final candidate and discard a prior entry.
    common = [f"Z common phrase {index:04d}" for index in range(3000)]
    less_common = "A less common phrase"
    breached = [f"short{index:04d}" for index in range(10000)]
    raw = ("\n".join(breached + common + [less_common]) + "\n").encode("utf-8")
    artifact, coverage = load_rebuilder().derive(raw)
    hashes = set(artifact.decode("ascii").splitlines())

    def digest(value):
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    assert digest(common[0]) in hashes
    assert digest(common[-1].casefold()) in hashes
    assert digest(breached[-1]) in hashes
    assert digest(less_common) not in hashes
    assert coverage["matching_policy_unique"] == 3000
    assert coverage["source_matching_policy_unique"] == 3001
    assert coverage["breached_sample_candidates"] == 10000
    assert coverage["artifact_hash_count"] <= 2 * (3000 + 10000)
    assert len(artifact) == 65 * coverage["artifact_hash_count"]


def test_offline_rebuild_rejects_changed_or_insufficient_source(tmp_path):
    builder = load_rebuilder()
    source = tmp_path / "source.txt"
    source.write_bytes(b"unreviewed upstream data")
    with pytest.raises(ValueError, match="reviewed version"):
        builder.checked_input(source, 12_000_000, builder.SOURCE_SHA256)
    with pytest.raises(ValueError, match="3000"):
        builder.derive(b"short\n")


def test_staff_creation_rejects_weak_password_before_creating_an_account(client, db):
    seed_staff(client, db)
    login(client, "admin")
    response = client.post(
        BASE + "/users",
        json={
            "username": "new.person",
            "display_name": "New member",
            "role": "viewer",
            "campus_ids": ["nku-jinnan"],
            "point_ids": [],
            "password": "password1234",
        },
    )
    assert response.status_code == 422
    assert (
        db.scalar(select(StaffUserRecord).where(StaffUserRecord.username == "new.person")) is None
    )


def test_administrative_password_reset_rejects_before_changing_any_user_fields(client, db):
    users, _ = seed_staff(client, db)
    login(client, "admin")
    user = users["editor"]
    before = (user.role, user.display_name, user.password_hash, user.revision)
    response = client.put(
        BASE + "/users/" + user.id,
        json={
            "expected_revision": user.revision,
            "display_name": "Should not change",
            "role": "viewer",
            "campus_ids": ["nku-jinnan"],
            "point_ids": [],
            "is_active": True,
            "new_password": "password1234",
        },
    )
    assert response.status_code == 422
    assert (user.role, user.display_name, user.password_hash, user.revision) == before


def test_console_reset_rejects_before_removing_existing_mfa_or_sessions(client, db):
    from test_staff_mfa import Authenticator, enroll

    from app.modules.admin.mfa_recover import recover_account

    users, _ = seed_staff(client, db)
    enroll(client, Authenticator(), "editor")
    before = (
        db.scalar(select(func.count()).select_from(StaffCredentialRecord)),
        db.scalar(select(func.count()).select_from(StaffSessionRecord)),
        users["editor"].password_hash,
    )
    with pytest.raises(DomainError):
        recover_account(
            db, username="editor", reason="Authorized test", new_password="password1234"
        )
    assert before == (
        db.scalar(select(func.count()).select_from(StaffCredentialRecord)),
        db.scalar(select(func.count()).select_from(StaffSessionRecord)),
        users["editor"].password_hash,
    )
