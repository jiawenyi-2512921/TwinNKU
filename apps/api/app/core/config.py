from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    app_env: Literal["development", "test", "production"] = "development"
    app_version: str = "0.4.0"
    practice_mode: bool = False
    map_enabled: bool = True
    map_assets_dir: Path = Path("var/map-assets")
    floors_enabled: bool = True
    vr_enabled: bool = True
    floor_assets_dir: Path = Path("var/floor-assets")
    upload_actor_budget_bytes: int = Field(default=1073741824, ge=104857600)
    upload_campus_budget_bytes: int = Field(default=5368709120, ge=104857600)
    upload_max_concurrency: int = Field(default=2, ge=1, le=2)
    upload_parser_timeout_seconds: int = Field(default=20, ge=1, le=60)
    upload_parser_memory_bytes: int = Field(default=536870912, ge=134217728)
    upload_parser_cpu_seconds: int = Field(default=15, ge=1, le=30)
    upload_reservation_minutes: int = Field(default=20, ge=5, le=60)
    upload_orphan_days: int = Field(default=7, ge=7)
    admin_enabled: bool = False
    admin_public_origin: str | None = None
    admin_session_hours: int = Field(default=8, ge=1, le=24)
    admin_mfa_enforced: bool = False
    backup_requests_enabled: bool = False
    backup_staff_requests_per_day: int = Field(default=2, ge=1, le=2)
    backup_global_requests_per_day: int = Field(default=6, ge=1, le=6)
    backup_min_interval_seconds: int = Field(default=3600, ge=3600)
    admin_session_idle_minutes: int = Field(default=30, ge=5, le=120)
    database_url: SecretStr | None = None
    db_host: str = "db"
    db_port: int = Field(default=5432, ge=1, le=65535)
    db_name: str = "twinnku"
    db_user: str = "twinnku"
    db_password: SecretStr | None = None
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "testserver", "api"]
    nk_genios_api_key: SecretStr | None = None
    nk_genios_api_enabled: bool = False
    agent_access_code: SecretStr | None = None
    agent_public_enabled: bool = False
    agent_session_seconds: int = Field(default=3600, ge=300, le=86400)
    agent_trusted_proxy_ips: list[str] = []
    agent_ip_requests_per_hour: int = Field(default=180, ge=1)
    agent_ip_requests_per_day: int = Field(default=1080, ge=1)
    agent_http_requests_per_hour: int = Field(default=2400, ge=1)
    agent_http_requests_per_day: int = Field(default=14400, ge=1)
    agent_supplier_requests_per_day: int = Field(default=1920, ge=1)
    agent_model_requests_per_day: int = Field(default=720, ge=1)
    agent_voice_requests_per_day: int = Field(default=1200, ge=1)
    agent_supplier_characters_per_day: int = Field(default=360000, ge=1)
    agent_supplier_ip_requests_per_day: int = Field(default=1080, ge=1)
    agent_supplier_session_requests_per_day: int = Field(default=450, ge=1)
    agent_model_concurrency: int = Field(default=4, ge=1, le=16)
    agent_voice_concurrency: int = Field(default=4, ge=1, le=16)

    @property
    def api_agent_configured(self) -> bool:
        return bool(self.nk_genios_api_enabled and self.nk_genios_api_key and (
            self.agent_public_enabled or self.agent_access_code
        ))
    # WebSDK appKey is a browser-visible embed identifier, never a server API token.
    nk_genios_web_enabled: bool = False
    nk_genios_web_app_key: SecretStr | None = None
    nk_genios_web_context_enabled: bool = False
    nk_genios_web_hide_sidebar: bool = True
    public_site_origin: str = "https://2512921.cn"
    voice_enabled: bool = False
    voice_api_key: SecretStr | None = None
    voice_base_url: str = ""
    voice_tier: Literal["standard", "demo"] = "standard"
    voice_timeout_seconds: float = Field(default=20.0, gt=0, le=120)
    voice_max_characters: int = Field(default=300, ge=1, le=2000)
    voice_cache_ttl_seconds: int = Field(default=86400, ge=0, le=2592000)
    voice_visitor_requests_per_hour: int = Field(default=45, ge=1, le=1000)
    voice_total_requests_per_hour: int = Field(default=200, ge=1, le=10000)
    voice_allowed_audio_hosts: list[str] = []
    voice_max_audio_bytes: int = Field(default=8 * 1024 * 1024, ge=1024, le=32 * 1024 * 1024)
    voice_cache_max_bytes: int = Field(default=64 * 1024 * 1024, ge=1024, le=256 * 1024 * 1024)
    narration_generation_enabled: bool = False
    narration_staff_requests_per_hour: int = Field(default=45, ge=1, le=1000)
    narration_staff_requests_per_day: int = Field(default=270, ge=1, le=6000)
    narration_max_storage_bytes: int = Field(default=2147483648, ge=104857600)
    narration_unadopted_days: int = Field(default=30, ge=7, le=365)

    @property
    def web_agent_configured(self) -> bool:
        return bool(self.nk_genios_web_enabled and self.nk_genios_web_app_key)

    @property
    def resolved_database_url(self) -> str:
        if self.database_url is not None:
            return self.database_url.get_secret_value()
        if self.app_env != "production":
            return "sqlite:///./var/development.db"
        return URL.create(
            "postgresql+psycopg",
            username=self.db_user,
            password=self.db_password.get_secret_value() if self.db_password else None,
            host=self.db_host,
            port=self.db_port,
            database=self.db_name,
        ).render_as_string(hide_password=False)

    @model_validator(mode="after")
    def production_is_explicit(self):
        if self.nk_genios_api_enabled and (
            not self.nk_genios_api_key or (not self.agent_public_enabled and (
                not self.agent_access_code
                or len(self.agent_access_code.get_secret_value()) < 16
            ))
        ):
            raise ValueError("NK_GENIOS_API_ENABLED requires API key and 16+ character AGENT_ACCESS_CODE")
        origin = urlsplit(self.public_site_origin)
        practice_http = (
            self.practice_mode and origin.scheme == "http" and origin.hostname == "localhost"
            and origin.port is not None and 1024 <= origin.port <= 65535
        )
        if (
            (origin.scheme != "https" and not practice_http)
            or not origin.hostname
            or origin.path
            or origin.query
            or origin.fragment
            or origin.username
            or origin.password
            or (origin.port not in (None, 443) and not practice_http)
            or any(c.isspace() for c in self.public_site_origin)
            or "\\" in self.public_site_origin
        ):
            raise ValueError(
                "PUBLIC_SITE_ORIGIN must be an HTTPS origin without path or credentials"
            )
        if self.nk_genios_web_app_key:
            import re

            if not re.fullmatch(
                r"[A-Za-z0-9_-]{8,128}", self.nk_genios_web_app_key.get_secret_value()
            ):
                raise ValueError("NK_GENIOS_WEB_APP_KEY must be the WebSDK embed identifier")
        if self.nk_genios_web_enabled and not self.nk_genios_web_app_key:
            raise ValueError("NK_GENIOS_WEB_ENABLED requires NK_GENIOS_WEB_APP_KEY")
        if self.voice_enabled:
            if not self.voice_api_key:
                raise ValueError("VOICE_ENABLED requires VOICE_API_KEY")
            origin = urlsplit(self.voice_base_url)
            if origin.scheme != "https" or not origin.hostname or origin.query or origin.fragment:
                raise ValueError("VOICE_BASE_URL must be an HTTPS origin without query")
        if self.admin_public_origin:
            origin = urlsplit(self.admin_public_origin)
            if (
                origin.scheme not in {"http", "https"}
                or not origin.netloc
                or origin.path
                or origin.query
                or origin.fragment
                or origin.username
            ):
                raise ValueError("ADMIN_PUBLIC_ORIGIN must be an exact origin without path")
        if self.app_env == "production":
            if self.admin_mfa_enforced and self.admin_public_origin != "https://2512921.cn":
                raise ValueError("enforced WebAuthn requires ADMIN_PUBLIC_ORIGIN=https://2512921.cn")
            if self.admin_enabled and (
                not self.admin_public_origin or not self.admin_public_origin.startswith("https://")
            ):
                raise ValueError(
                    "enabled production admin requires an explicit HTTPS ADMIN_PUBLIC_ORIGIN"
                )
            url = make_url(self.resolved_database_url)
            if url.drivername != "postgresql+psycopg":
                raise ValueError("production requires PostgreSQL with psycopg")
            password = url.password or ""
            if len(password) < 24 or any(
                token in password.lower() for token in ["change-me", "changeme", "example"]
            ):
                raise ValueError(
                    "production requires a non-placeholder DB password of 24+ characters"
                )
            if "*" in self.allowed_hosts:
                raise ValueError("production ALLOWED_HOSTS must be explicit")
        return self

    @model_validator(mode="after")
    def practice_is_isolated(self):
        if not self.practice_mode:
            return self
        if self.app_env == "production" or self.admin_mfa_enforced:
            raise ValueError("Practice is a separate local content-training environment")
        if self.backup_requests_enabled:
            raise ValueError("Practice mode forbids host backup operations")
        if any((self.nk_genios_api_enabled, self.nk_genios_web_enabled,
                self.agent_public_enabled, self.voice_enabled, self.narration_generation_enabled)):
            raise ValueError("Practice mode forbids supplier and paid-generation capabilities")
        if any(value and value.get_secret_value() for value in (
            self.nk_genios_api_key, self.nk_genios_web_app_key,
            self.voice_api_key, self.agent_access_code,
        )):
            raise ValueError("Practice mode must not receive supplier or public-agent credentials")
        url = make_url(self.resolved_database_url)
        if (
            url.drivername != "postgresql+psycopg" or url.host != "db" or url.port not in (None, 5432) or url.query
            or url.database != "twinnku_practice" or url.username not in {
                "practice_owner", "practice_runtime"
            }
            or len(url.password or "") < 24
        ):
            raise ValueError("Practice requires its dedicated PostgreSQL database and role")
        origin = urlsplit(self.admin_public_origin or "")
        if (
            origin.scheme != "http" or origin.hostname != "localhost"
            or origin.port is None or not 1024 <= origin.port <= 65535
            or origin.password or origin.username or origin.path or origin.query or origin.fragment
            or self.admin_public_origin != self.public_site_origin
        ):
            raise ValueError("Practice origins must match the explicit localhost HTTP port")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
