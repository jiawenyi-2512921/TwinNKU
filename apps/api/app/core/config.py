from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    app_version: str = "0.1.0"
    database_url: SecretStr | None = None
    db_host: str = "db"
    db_port: int = Field(default=5432, ge=1, le=65535)
    db_name: str = "twinnku"
    db_user: str = "twinnku"
    db_password: SecretStr | None = None
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "testserver", "api"]
    nk_genios_api_key: SecretStr | None = None

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
        if self.app_env == "production":
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
