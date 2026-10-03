"""Private job-owned flat temporary folders with cross-process active leases."""

import json
import os
import shutil
import stat
from contextlib import contextmanager
from uuid import UUID

from app.core.errors import DomainError

MARKER = "twinnku-import-temp-v1"
FILES = {"owner.json", ".active.lock", "data.csv", "data.xlsx"}


def temporary_root(settings):
    base = settings.floor_assets_dir.resolve()
    parent = base / ".import-temp"
    if parent.is_symlink() or parent.resolve().parent != base:
        raise DomainError("IMPORT_STORAGE", "导入临时目录不可用", 503)
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    return parent


def owned_folder(settings, job_id):
    key = str(UUID(str(job_id)))
    parent = temporary_root(settings)
    folder = parent / ("job-" + key)
    if folder.is_symlink() or folder.resolve().parent != parent or not folder.resolve().is_relative_to(settings.floor_assets_dir.resolve()):
        raise DomainError("IMPORT_STORAGE", "导入临时目录不可用", 503)
    return folder


def flat_files(folder):
    children = list(folder.iterdir())
    if len(children) > 4 or any(child.name not in FILES or child.is_symlink() or not child.is_file() for child in children):
        raise DomainError("IMPORT_STORAGE", "导入临时目录包含未知文件，保留供维护检查", 503)
    return children


@contextmanager
def active_lock(folder, *, create=False):
    path = folder / ".active.lock"
    if path.is_symlink():
        raise DomainError("IMPORT_STORAGE", "导入临时锁不可用", 503)
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    if create:
        flags |= os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "r+b") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise DomainError("IMPORT_STORAGE", "导入临时锁不是普通文件", 503)
        try:
            if os.name == "posix":
                import fcntl

                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                import msvcrt

                if os.fstat(stream.fileno()).st_size == 0:
                    stream.write(b"\0")
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise DomainError("IMPORT_ACTIVE", "导入任务仍在使用临时文件", 503) from exc
        try:
            yield
        finally:
            if os.name == "posix":
                fcntl.flock(stream, fcntl.LOCK_UN)
            else:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def read_marker(folder):
    flat_files(folder)
    path = folder / "owner.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 2048:
        raise DomainError("IMPORT_STORAGE", "导入临时归属标记无效", 503)
    value = json.loads(path.read_text(encoding="utf-8"))
    if set(value) != {"format", "job_id", "created_at", "expires_at"} or value["format"] != MARKER or folder.name != "job-" + str(UUID(value["job_id"])):
        raise DomainError("IMPORT_STORAGE", "导入临时归属标记无效", 503)
    return value


def remove_owned(settings, job_id):
    folder = owned_folder(settings, job_id)
    read_marker(folder)
    # Check the absolute target immediately before the only recursive removal.
    if folder.resolve().parent != temporary_root(settings):
        raise DomainError("IMPORT_STORAGE", "导入临时目录不可用", 503)
    shutil.rmtree(folder)


@contextmanager
def import_temporary(settings, job):
    folder = owned_folder(settings, job.id)
    folder.mkdir(mode=0o700, exist_ok=False)
    try:
        with active_lock(folder, create=True):
            marker = {"format": MARKER, "job_id": job.id, "created_at": job.created_at.isoformat(), "expires_at": job.expires_at.isoformat()}
            fd = os.open(folder / "owner.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(marker, stream, separators=(",", ":"))
            yield folder
    finally:
        # inspect_table stops its child before this lease ends. Windows cannot
        # unlink an open byte-range lock; UUID folders are never reused.
        if (folder / "owner.json").is_file():
            remove_owned(settings, job.id)
