from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.contracts import DTO

BackupPermission = Literal["backup.read", "backup.request"]
BackupState = Literal["queued", "running", "succeeded", "failed", "unknown", "cancelled", "expired"]
BackupPhase = Literal[
    "queued", "preflight", "dump", "encrypt", "retention", "integrity", "complete"
]


class BackupRequest(DTO):
    operation_id: UUID
    reason: str = Field(min_length=5, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_required(cls, value):
        value = value.strip()
        if len(value) < 5 or any(ord(char) < 32 for char in value):
            raise ValueError("请填写至少5字的备份原因，不含控制字符")
        return value


class BackupCancel(DTO):
    operation_id: UUID


class BackupSnapshot(DTO):
    id: str = Field(pattern=r"^[a-f0-9]{64}$")
    created_at: datetime


class BackupSummary(DTO):
    status: Literal["unknown", "success", "failed", "running"] = "unknown"
    last_success_at: datetime | None = None
    attempted_at: datetime | None = None
    repository_bytes: int | None = Field(default=None, ge=0)
    free_bytes: int | None = Field(default=None, ge=0)
    reserve_bytes: int | None = Field(default=None, ge=0)
    coverage: list[Literal["database", "maps", "uploaded_media", "deployment_configuration"]] = (
        Field(default_factory=list, max_length=4)
    )
    offsite: Literal[False] = False
    snapshots: list[BackupSnapshot] = Field(default_factory=list, max_length=20)
    restore_status: Literal["unknown", "passed", "failed"] = "unknown"
    restore_verified_at: datetime | None = None


class BackupJob(DTO):
    id: UUID
    operation_id: UUID
    user_id: UUID
    reason: str
    state: BackupState
    phase: BackupPhase
    created_at: datetime
    authorized_until: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cancel_requested: bool
    cancel_operation_id: UUID | None
    failure_code: str | None
    result: BackupSummary | None


class BackupJobPage(DTO):
    items: list[BackupJob]
    page: int
    page_size: int
    has_more: bool


class BackupStatus(DTO):
    requests_enabled: bool
    executor_available: bool
    observed_at: datetime | None
    summary: BackupSummary
    active_job: BackupJob | None
    staff_requests_per_day: int
    global_requests_per_day: int
    min_interval_seconds: int


class BackupCapabilities(DTO):
    requests_enabled: bool
    executor_available: bool
    staff_requests_per_day: int
    global_requests_per_day: int
    min_interval_seconds: int


class BackupGrantUpdate(DTO):
    permissions: list[BackupPermission] = Field(max_length=2)
    note: str = Field(min_length=5, max_length=500)

    @field_validator("permissions")
    @classmethod
    def unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("权限不能重复")
        return value


class BackupGrants(DTO):
    user_id: UUID
    permissions: list[BackupPermission]
