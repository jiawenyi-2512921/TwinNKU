"""Exercise the actual bounded parser with supported codecs, not a fake probe."""

import asyncio
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from app.core.errors import DomainError
from app.modules.uploads import inspect_upload


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="requires real ffmpeg fixture encoder")
@pytest.mark.parametrize(
    "encoder,extension,mime,extra",
    [
        ("libx264", "mp4", "video/mp4", []),
        (
            "libx265",
            "mp4",
            "video/mp4",
            ["-x265-params", "pools=1:frame-threads=1:log-level=error"],
        ),
        ("libaom-av1", "mp4", "video/mp4", ["-cpu-used", "8", "-row-mt", "0"]),
        ("libvpx", "webm", "video/webm", ["-deadline", "realtime", "-cpu-used", "8"]),
        ("libvpx-vp9", "webm", "video/webm", ["-deadline", "realtime", "-cpu-used", "8"]),
        ("libaom-av1", "webm", "video/webm", ["-cpu-used", "8", "-row-mt", "0"]),
    ],
)
def test_bounded_parser_accepts_real_supported_codec_and_preserves_original_bytes(
    tmp_path,
    encoder,
    extension,
    mime,
    extra,
):
    path = tmp_path / ("fixture." + extension)
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=64x64:rate=1",
            "-t",
            "1",
            "-c:v",
            encoder,
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            *extra,
            str(path),
        ],
        check=True,
        timeout=30,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    original = path.read_bytes()
    settings = SimpleNamespace(
        floor_assets_dir=tmp_path,
        upload_parser_memory_bytes=512 * 1024 * 1024,
        upload_parser_cpu_seconds=15,
        upload_parser_timeout_seconds=20,
    )
    assert asyncio.run(inspect_upload(path, mime, kind="media", settings=settings)) == {}
    assert path.read_bytes() == original
    wrong = "video/webm" if mime == "video/mp4" else "video/mp4"
    with pytest.raises(DomainError) as error:
        asyncio.run(inspect_upload(path, wrong, kind="media", settings=settings))
    assert error.value.code == "INVALID_MEDIA" and error.value.status == 422
    assert path.read_bytes() == original
