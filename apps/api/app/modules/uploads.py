"""Raw-file upload leases, bounded parsers, and a backup-coordinated storage lock.

API callers hold upload_slot through the file rename AND database commit. A
reservation is durable before body receipt, and is settled in the same database
transaction as the new upload. No image is rewritten by the parser.
"""

import asyncio
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import warnings
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select, update

from app.core.errors import DomainError
from app.models import UploadBudgetRecord, UploadReservationRecord, now_utc


@contextmanager
def storage_guard(settings, *, exclusive=False):
    """Cross-process advisory lock shared by uploads, imports, publication and backup.

    Linux flock is the production primitive. Windows tests use the platform's
    byte-range lock (exclusive even for readers); it is intentionally conservative.
    No recursive file operations are performed by this helper.
    """
    root = settings.floor_assets_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / ".maintenance.lock"
    if path.is_symlink():
        raise DomainError("STORAGE_UNAVAILABLE", "资料目录锁不可用", 503)
    fd = os.open(
        path,
        os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
        0o660,
    )
    with os.fdopen(fd, "r+b") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise DomainError("STORAGE_UNAVAILABLE", "资料目录锁不是普通文件", 503)
        try:
            if os.name == "posix":
                import fcntl

                fcntl.flock(file, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            else:
                import msvcrt

                if path.stat().st_size == 0:
                    file.write(b"\0")
                    file.flush()
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise DomainError("STORAGE_BUSY", "备份或资料维护正在进行，请稍后重试", 503) from exc
        try:
            yield
        finally:
            if os.name == "posix":
                fcntl.flock(file, fcntl.LOCK_UN)
            else:
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)


def ensure_budget(db, scope):
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        raise RuntimeError("Upload budgets require PostgreSQL or the SQLite test backend")
    db.execute(
        insert(UploadBudgetRecord)
        .values(scope=scope, used_bytes=0, reserved_bytes=0, active_uploads=0)
        .on_conflict_do_nothing(index_elements=["scope"])
    )


def quota_scopes(row):
    return ("actor:" + row.user_id, "campus:" + row.campus_id)


def reserve_copy(db, settings, user, point, *, asset_id, size_bytes):
    """Synchronous publication uses the caller transaction, without an early commit.

    The enclosing storage_guard must cover filesystem materialization and commit.
    Rolling back publication rolls back its budget and reservation together.
    """
    ensure_budget(db, "global")
    db.execute(
        update(UploadBudgetRecord)
        .where(UploadBudgetRecord.scope == "global")
        .values(active_uploads=UploadBudgetRecord.active_uploads)
    )
    for scope, limit in (
        ("actor:" + user.id, settings.upload_actor_budget_bytes),
        ("campus:" + point.campus_id, settings.upload_campus_budget_bytes),
    ):
        ensure_budget(db, scope)
        changed = db.execute(
            update(UploadBudgetRecord)
            .where(
                UploadBudgetRecord.scope == scope,
                UploadBudgetRecord.used_bytes + UploadBudgetRecord.reserved_bytes + size_bytes
                <= limit,
            )
            .values(used_bytes=UploadBudgetRecord.used_bytes + size_bytes)
        ).rowcount
        if not changed:
            raise DomainError("UPLOAD_QUOTA", "成员或校区资料容量不足，无法物化新的楼层版本", 413)
    db.add(
        UploadReservationRecord(
            kind="floor-copy",
            upload_id=asset_id,
            user_id=user.id,
            campus_id=point.campus_id,
            size_bytes=size_bytes,
            state="complete",
            expires_at=now_utc() + timedelta(minutes=settings.upload_reservation_minutes),
        )
    )


def release_reservation(db, row):
    if row.state != "reserved":
        return
    for scope in quota_scopes(row):
        db.execute(
            update(UploadBudgetRecord)
            .where(UploadBudgetRecord.scope == scope)
            .values(reserved_bytes=UploadBudgetRecord.reserved_bytes - row.size_bytes)
        )
    db.execute(
        update(UploadBudgetRecord)
        .where(UploadBudgetRecord.scope == "global")
        .values(active_uploads=UploadBudgetRecord.active_uploads - 1)
    )
    row.state = "failed"


def retain_orphan(db, row, size_bytes):
    """Keep stranded original bytes charged until a reviewed physical GC completes."""
    if row.state != "failed" or size_bytes <= 0:
        return
    db.execute(
        update(UploadBudgetRecord)
        .where(UploadBudgetRecord.scope == "global")
        .values(active_uploads=UploadBudgetRecord.active_uploads)
    )
    for scope in quota_scopes(row):
        db.execute(
            update(UploadBudgetRecord)
            .where(UploadBudgetRecord.scope == scope)
            .values(used_bytes=UploadBudgetRecord.used_bytes + size_bytes)
        )
    row.state, row.size_bytes = "orphaned", size_bytes


class UploadSlot:
    def __init__(self, db, row, timeout_seconds):
        self.db, self.id, self.timeout_seconds = db, row.id, timeout_seconds

    def complete(self, db, size_bytes):
        db.execute(
            update(UploadBudgetRecord)
            .where(UploadBudgetRecord.scope == "global")
            .values(active_uploads=UploadBudgetRecord.active_uploads)
        )
        row = db.scalar(
            select(UploadReservationRecord)
            .where(UploadReservationRecord.id == self.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if not row or row.state != "reserved" or not 0 < size_bytes <= row.size_bytes:
            raise DomainError("UPLOAD_RESERVATION_LOST", "上传预约已失效，请重新上传", 409)
        # Lock global first, consistent with reserve/recovery, to avoid lock inversions.
        db.execute(
            update(UploadBudgetRecord)
            .where(UploadBudgetRecord.scope == "global")
            .values(active_uploads=UploadBudgetRecord.active_uploads - 1)
        )
        for scope in quota_scopes(row):
            db.execute(
                update(UploadBudgetRecord)
                .where(UploadBudgetRecord.scope == scope)
                .values(
                    reserved_bytes=UploadBudgetRecord.reserved_bytes - row.size_bytes,
                    used_bytes=UploadBudgetRecord.used_bytes + size_bytes,
                )
            )
        row.state, row.size_bytes = "complete", size_bytes
        db.flush()


@contextmanager
def upload_slot(db, settings, user, point, *, kind, upload_id, max_bytes):
    """Reserve maximum bytes, not untrusted Content-Length. Caller commits completion.

    Wrap streaming in asyncio.timeout(slot.timeout_seconds). A crash leaves a
    durable reservation; maintenance GC releases expired leases under its exclusive
    storage lock. Runtime does not steal a possibly still-running parser's slot.
    """
    if kind not in {"floor", "media"} or max_bytes <= 0:
        raise ValueError("Invalid upload reservation")
    reservation_id = str(uuid4())
    with storage_guard(settings):
        try:
            ensure_budget(db, "global")
            limit = min(2, settings.upload_max_concurrency)
            changed = db.execute(
                update(UploadBudgetRecord)
                .where(
                    UploadBudgetRecord.scope == "global", UploadBudgetRecord.active_uploads < limit
                )
                .values(active_uploads=UploadBudgetRecord.active_uploads + 1)
            ).rowcount
            if not changed:
                raise DomainError("UPLOAD_BUSY", "最多同时处理2个上传，请稍后重试", 429)
            for scope, limit in (
                ("actor:" + user.id, settings.upload_actor_budget_bytes),
                ("campus:" + point.campus_id, settings.upload_campus_budget_bytes),
            ):
                ensure_budget(db, scope)
                changed = db.execute(
                    update(UploadBudgetRecord)
                    .where(
                        UploadBudgetRecord.scope == scope,
                        UploadBudgetRecord.used_bytes
                        + UploadBudgetRecord.reserved_bytes
                        + max_bytes
                        <= limit,
                    )
                    .values(reserved_bytes=UploadBudgetRecord.reserved_bytes + max_bytes)
                ).rowcount
                if not changed:
                    raise DomainError(
                        "UPLOAD_QUOTA", "成员或校区资料容量不足，请联系管理员整理未引用资料", 413
                    )
            seconds = settings.upload_reservation_minutes * 60
            row = UploadReservationRecord(
                id=reservation_id,
                kind=kind,
                upload_id=upload_id,
                user_id=user.id,
                campus_id=point.campus_id,
                size_bytes=max_bytes,
                state="reserved",
                expires_at=now_utc() + timedelta(seconds=seconds),
            )
            db.add(row)
            db.commit()
        except BaseException:
            db.rollback()
            raise
        try:
            yield UploadSlot(db, row, seconds)
        finally:
            # On any cancellation/commit failure undo the caller's uncommitted work
            # before inspecting the durable reservation. Success already committed it.
            db.rollback()
            db.execute(
                update(UploadBudgetRecord)
                .where(UploadBudgetRecord.scope == "global")
                .values(active_uploads=UploadBudgetRecord.active_uploads)
            )
            row = db.scalar(
                select(UploadReservationRecord)
                .where(UploadReservationRecord.id == reservation_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if row and row.state == "reserved":
                # Always global first; then actor, then campus.
                release_reservation(db, row)
                db.commit()
            else:
                db.rollback()
            if row and row.state == "failed" and kind in {"floor", "media"}:
                parent = settings.floor_assets_dir.resolve() / (
                    ".uploads" if kind == "floor" else ".experience-media"
                )
                target = parent / upload_id
                if target.is_symlink() or not target.resolve().is_relative_to(parent.resolve()):
                    raise ValueError("Invalid owned upload directory")
                if target.exists():
                    try:
                        shutil.rmtree(target)
                    except OSError:
                        actual = sum(
                            p.stat().st_size
                            for p in target.rglob("*")
                            if p.is_file() and not p.is_symlink()
                        )
                        retain_orphan(db, row, actual)
                        db.commit()
                        raise


async def inspect_upload(path, mime, *, kind, settings):
    """Run potentially hostile decoders outside the API/event loop, with bounded output.

    Linux additionally applies address-space, CPU, file-size and descriptor limits.
    ffprobe is file-only and inherits these limits. Both child processes are killed
    together on timeout/cancellation. Windows is for development, not OS-limit proof.
    """
    root = settings.floor_assets_dir.resolve()
    path = Path(path).resolve()
    if kind not in {"floor", "media"} or not path.is_relative_to(root) or not path.is_file():
        raise ValueError("Parser accepts only a local owned upload")
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "app.modules.uploads",
        "inspect",
        str(path),
        mime,
        kind,
        str(settings.upload_parser_memory_bytes),
        str(settings.upload_parser_cpu_seconds),
        stdin=subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=os.name == "posix",
        # Decoders do not need provider keys, staff configuration or database
        # credentials. The inert URL also prevents import-time DB configuration
        # from attempting to make a development directory on a read-only image.
        env={
            **{
                key: os.environ[key]
                for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL")
                if key in os.environ
            },
            "APP_ENV": "test",
            "DATABASE_URL": "sqlite://",
            "PYTHONUTF8": "1",
        },
    )
    try:
        async with asyncio.timeout(settings.upload_parser_timeout_seconds):
            # A bounded pipe read avoids collecting arbitrary ffprobe/decoder output.
            output = await process.stdout.read(65537)
            if len(output) > 65536:
                raise ValueError("Parser output limit")
            await process.wait()
        if process.returncode != 0:
            raise ValueError("Parser rejected original")
        result = json.loads(output)
        if result == {"error": "VIDEO_VALIDATION_UNAVAILABLE"}:
            raise DomainError("VIDEO_VALIDATION_UNAVAILABLE", "服务器尚未安装视频校验组件", 503)
        if not isinstance(result, dict) or result.get("error"):
            raise ValueError("Parser rejected original")
        return result
    except (ValueError, OSError, TimeoutError) as exc:
        raise DomainError(
            "INVALID_IMAGE" if kind == "floor" else "INVALID_MEDIA",
            "原文件无法读取、超出解析限制或格式不匹配，请核对源文件",
            422,
        ) from exc
    finally:
        # Kill the whole group even when the leader exited, so no probe child survives.
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.returncode is None:
            process.kill()
        await process.wait()


def _inspect_media(path, mime):
    from PIL import Image

    if mime.startswith("image/"):
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                expected = "PNG" if mime == "image/png" else "JPEG"
                if image.format != expected or image.width * image.height > 40_000_000:
                    raise ValueError("image type or dimensions")
                image.verify()
            with Image.open(path) as image:
                image.load()
        return {}
    if mime not in {"video/mp4", "video/webm"}:
        raise ValueError("Invalid media MIME")
    with path.open("rb") as source:
        header = source.read(16)
    if (mime == "video/mp4" and header[4:8] != b"ftyp") or (
        mime == "video/webm" and header[:4] != b"\x1a\x45\xdf\xa3"
    ):
        raise ValueError("Invalid container signature")
    executable = shutil.which("ffprobe")
    if not executable:
        return {"error": "VIDEO_VALIDATION_UNAVAILABLE"}
    result = subprocess.run(
        [
            executable,
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            "mov,matroska,webm",
            "-show_entries",
            "format=format_name,duration:stream=codec_type,codec_name",
            "-of",
            "json",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=True,
    )
    info = json.loads(result.stdout)
    formats = info.get("format", {}).get("format_name", "").split(",")
    valid = "mp4" in formats if mime == "video/mp4" else "webm" in formats
    codecs = {"h264", "hevc", "av1"} if mime == "video/mp4" else {"vp8", "vp9", "av1"}
    if (
        not valid
        or float(info.get("format", {}).get("duration", 0)) <= 0
        or not any(
            s.get("codec_type") == "video" and s.get("codec_name") in codecs
            for s in info.get("streams", [])
        )
    ):
        raise ValueError("Invalid video")
    return {}


def _worker():
    _, path, mime, kind, memory, cpu = sys.argv[1:]
    if os.name == "posix":
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (int(memory), int(memory)))
        resource.setrlimit(resource.RLIMIT_CPU, (int(cpu), int(cpu)))
        resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        path = Path(path)
        if kind == "floor":
            from app.modules.floors.import_bundle import inspect_image

            result = inspect_image(path)
            if result["media_type"] != mime:
                raise ValueError("MIME mismatch")
        else:
            if not 0 < path.stat().st_size <= 100 * 1024 * 1024:
                raise ValueError("Media size")
            result = _inspect_media(path, mime)
        print(json.dumps(result))
    except Exception:
        print(json.dumps({"error": "INVALID_UPLOAD"}))


if __name__ == "__main__":
    _worker()
