import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.config import Settings
from app.database import get_db
from app.main import create_app
from app.models import Base, CampusRecord


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)")
        )
        connection.execute(text("INSERT INTO alembic_version VALUES ('0004_admin_console')"))
    with Session(engine) as session:
        session.add(
            CampusRecord(id="nku-jinnan", name="南开大学津南校区", description="校园文化导览")
        )
        session.commit()
        yield session
    engine.dispose()


@pytest.fixture
def client(db):
    app = create_app(Settings(app_env="test"))

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as client:
        yield client
