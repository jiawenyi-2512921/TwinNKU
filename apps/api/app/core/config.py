from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    app_version: str = "0.4.0"
    map_enabled: bool = True
    map_assets_dir: Path = Path("var/map-assets")
    floors_enabled: bool = True
    vr_enabled: bool = True
    floor_assets_dir: Path = Path("var/floor-assets")
    admin_enabled: bool = False
    admin_public_origin: str | None = None
    admin_session_hours: int = Field(default=8, ge=1, le=24)
    database_url: SecretStr | None = None
    db_host: str = "db"
    db_port: int = Field(default=5432, ge=1, le=65535)
    db_name: str = "twinnku"
    db_user: str = "twinnku"
    db_password: SecretStr | None = None
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "testserver", "api"]
    nk_genios_api_key: SecretStr | None = None
    # WebSDK appKey is a browser-visible embed identifier, never a server API token.
    nk_genios_web_enabled: bool = False
    nk_genios_web_app_key: SecretStr | None = None
    nk_genios_web_context_enabled: bool = False
    nk_genios_web_hide_sidebar: bool = True
    public_site_origin: str = "https://2512921.cn"

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
        origin = urlsplit(self.public_site_origin)
        if (
            origin.scheme != "https"
            or not origin.hostname
            or origin.path
            or origin.query
            or origin.fragment
            or origin.username
            or origin.password
            or origin.port not in (None, 443)
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
