from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings


def build_engine(url: str):
    kwargs = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        if url == "sqlite:///./var/development.db":
            Path("var").mkdir(exist_ok=True)
    else:
        kwargs["connect_args"] = {"connect_timeout": 5}
    engine = create_engine(url, **kwargs)
    if engine.dialect.name == "sqlite":

        @event.listens_for(engine, "connect")
        def enable_foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")

    return engine


engine = build_engine(get_settings().resolved_database_url)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    with SessionLocal() as db:
        yield db
