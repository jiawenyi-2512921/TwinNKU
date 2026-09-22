from uuid import uuid4

from sqlalchemy import text

from app.models import CampusRecord, PointRecord


def add_point(db, **kwargs):
    data = {
        "id": str(uuid4()),
        "campus_id": "nku-jinnan",
        "name": "审核点位",
        "category": "history",
        "summary": "测试资料",
        "status": "published",
        "visibility": "public",
    }
    data.update(kwargs)
    point = PointRecord(**data)
    db.add(point)
    db.commit()
    return point.id


def test_empty_catalog_and_request_id(client):
    response = client.get("/api/v1/campuses/nku-jinnan/points")
    assert response.status_code == 200
    assert response.json()["data"] == []
    assert response.json()["meta"]["pagination"] == {"page": 1, "page_size": 20, "total": 0}
    assert response.json()["meta"]["request_id"] == response.headers["x-request-id"]


def test_nonpublic_points_never_leak(client, db):
    public_id = add_point(db)
    hidden_ids = [
        add_point(db, status="draft", name="草稿秘密"),
        add_point(db, visibility="internal", name="内部秘密"),
        add_point(db, visibility="restricted", name="受限秘密"),
        add_point(db, status="retired", name="撤回秘密"),
    ]
    result = client.get("/api/v1/campuses/nku-jinnan/points").json()
    assert [p["id"] for p in result["data"]] == [public_id]
    assert "秘密" not in str(result)
    for point_id in hidden_ids:
        response = client.get(f"/api/v1/points/{point_id}")
        assert response.status_code == 404
        assert "秘密" not in response.text


def test_inactive_campus_hides_detail(client, db):
    point_id = add_point(db)
    db.get(CampusRecord, "nku-jinnan").is_active = False
    db.commit()
    assert client.get(f"/api/v1/points/{point_id}").status_code == 404
    assert client.get("/api/v1/campuses/nku-jinnan/points").status_code == 404
    assert client.get("/api/v1/campuses").json()["data"] == []


def test_search_literal_wildcard_and_pagination(client, db):
    add_point(db, name="图书馆")
    literal = add_point(db, name="100%示例")
    result = client.get("/api/v1/campuses/nku-jinnan/points", params={"q": "%"}).json()
    assert [p["id"] for p in result["data"]] == [literal]
    page = client.get(
        "/api/v1/campuses/nku-jinnan/points", params={"page_size": 1, "page": 2}
    ).json()
    assert len(page["data"]) == 1 and page["meta"]["pagination"]["total"] == 2


def test_invalid_parameters_do_not_echo_input(client):
    for query in ["page=0", "page_size=101", "category=private-secret-value"]:
        response = client.get(f"/api/v1/campuses/nku-jinnan/points?{query}")
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
        assert "private-secret-value" not in response.text
    assert client.get("/api/v1/points/not-a-uuid").status_code == 422


def test_readiness_detects_missing_schema(client, db):
    assert client.get("/health/ready").status_code == 200
    db.execute(text("DROP TABLE alembic_version"))
    db.commit()
    result = client.get("/health/ready")
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "DATABASE_NOT_READY"
    assert client.get("/health/live").status_code == 200


def test_unimplemented_features_are_not_exposed(client):
    status = client.get("/api/v1/system/status").json()["data"]
    assert not any(status["capabilities"].values())
    assert client.post("/api/v1/chat/sessions", json={}).status_code == 404
    assert client.post("/api/v1/admin/points", json={}).status_code == 404
    assert all(
        op.get("x-implementation-status") == "implemented"
        for methods in client.get("/openapi.json").json()["paths"].values()
        for op in methods.values()
    )
