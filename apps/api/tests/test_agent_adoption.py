import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

SPEC = importlib.util.spec_from_file_location(
    "adopt_demo", Path(__file__).resolve().parents[3] / "scripts/adopt_agent_demo.py"
)
adoption = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adoption)


def test_existing_credentials_are_migrated_privately_without_losing_settings(tmp_path, monkeypatch):
    root, state = tmp_path / "repo", tmp_path / "state"
    root.mkdir()
    state.mkdir()
    original = "DB_PASSWORD='test-original-password'\nMAP_ENABLED=true\nNK_GENIOS_API_KEY=\n"
    (root / ".env").write_text(original)
    (state / "demo.env").write_text(
        "NK_GENIOS_API_KEY=test-$-key\nDEMO_CODE=test-code-with-'quote-and-\\slash\n"
    )
    monkeypatch.setattr(adoption.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1))
    assert adoption.adopt(root, state)
    values = adoption.parse_env((root / ".env").read_text())
    assert values["NK_GENIOS_API_KEY"] == "test-$-key"
    assert values["AGENT_ACCESS_CODE"] == "test-code-with-'quote-and-\\slash"
    assert values["MAP_ENABLED"] == "true" and values["NK_GENIOS_API_ENABLED"] == "true"
    backup = list(root.glob(".env.before-native-agent-*"))[0]
    assert backup.read_text() == original and backup.stat().st_mode & 0o777 == 0o600
    assert (root / ".env").stat().st_mode & 0o777 == 0o600
    assert not adoption.adopt(root, state)


def test_adoption_never_overwrites_different_native_credentials(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("NK_GENIOS_API_KEY=already-configured-key\n")
    (tmp_path / "demo.env").write_text(
        "NK_GENIOS_API_KEY=another-key\nDEMO_CODE=test-only-demo-code\n"
    )
    monkeypatch.setattr(adoption.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1))
    with pytest.raises(ValueError, match="differ"):
        adoption.adopt(tmp_path, tmp_path)
    assert (tmp_path / ".env").read_text() == "NK_GENIOS_API_KEY=already-configured-key\n"
    assert not list(tmp_path.glob(".env.before-native-agent-*"))
