"""A custom-built C component must stay visible to vulnerability scanning."""

import importlib.util
import json
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "verify_ffprobe", Path(__file__).resolve().parents[3] / "scripts" / "verify_ffprobe.py"
)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


def scoped_header():
    flags = {
        f"CONFIG_{name}_{category}": "1"
        for category, names in probe.ALLOWED.items()
        for name in names
    }
    flags.update(CONFIG_DVDSUB_PARSER="0", CONFIG_DVDSUB_DECODER="0", CONFIG_MPEGPS_DEMUXER="0")
    return "\n".join(f"#define {key} {value}" for key, value in flags.items())


@pytest.mark.parametrize(
    "extra",
    ["CONFIG_HTTP_PROTOCOL", "CONFIG_DVDSUB_PARSER", "CONFIG_MPEGPS_DEMUXER"],
)
def test_expanding_probe_attack_surface_blocks_build(extra):
    header = scoped_header().replace(f"#define {extra} 0", "")
    with pytest.raises(ValueError):
        probe.validate_components(header + f"\n#define {extra} 1")


def test_dvd_vex_needs_positive_absence_evidence():
    assert probe.validate_components(scoped_header())["PROTOCOL"] == ["FILE"]
    with pytest.raises(ValueError, match="not excluded"):
        probe.validate_components(scoped_header().replace("#define CONFIG_DVDSUB_DECODER 0", ""))
    value = probe.vex()
    assert len(value["statements"]) == 1
    statement = value["statements"][0]
    assert statement["vulnerability"]["name"] == "CVE-2026-6385"
    assert statement["products"] == [{"@id": probe.PURL}]
    assert statement["justification"] == "vulnerable_code_not_present"


def test_missing_source_inventory_is_not_a_clean_scan(tmp_path):
    with pytest.raises(FileNotFoundError):
        probe.inventory(tmp_path, tmp_path / "ffprobe")
    (tmp_path / f"ffmpeg-{probe.VERSION}.tar.xz").write_bytes(b"changed source")
    with pytest.raises(ValueError, match="checksum"):
        probe.inventory(tmp_path, tmp_path / "ffprobe")


def test_component_scan_canary_rejects_empty_or_unrelated_matches(tmp_path):
    path = tmp_path / "scan.json"
    for artifact in ({}, {"name": "ffmpeg", "version": probe.VERSION}):
        path.write_text(
            json.dumps({"matches": [{"artifact": artifact, "vulnerability": {"severity": "High"}}]})
        )
        with pytest.raises(ValueError, match="did not detect"):
            probe.canary(path)
    path.write_text(
        json.dumps(
            {
                "matches": [
                    {
                        "artifact": {"name": "ffmpeg", "version": "7.1.5"},
                        "vulnerability": {"severity": "Critical"},
                    }
                ]
            }
        )
    )
    probe.canary(path)
    assert probe.sbom()["components"][0]["cpe"].startswith("cpe:2.3:a:ffmpeg:ffmpeg:9.0.2:")
