from uuid import uuid4

from test_admin import seed_staff

from app.models import CampusRecord, PanoramaRecord, PointRecord, ResourceChangeRecord


def place(
    db, *, campus="nku-jinnan", status="published", visibility="public", category="public_area"
):
    point = PointRecord(
        id=str(uuid4()),
        campus_id=campus,
        name="独立视点",
        category=category,
        aliases=[],
        summary="",
        status=status,
        visibility=visibility,
        revision=1,
    )
    db.add(point)
    db.flush()
    return point


def panorama(db, point, *, status="published", title="湖畔"):
    vr = PanoramaRecord(
        id=str(uuid4()),
        point_id=point.id,
        title=title,
        url="https://stjgpt.nankai.edu.cn/index-jn.php#scene_4028/-75.9/89.9/132.0",
        description="",
        status=status,
        revision=1,
    )
    db.add(vr)
    return vr


def test_directory_only_returns_current_public_panoramas_in_requested_active_campus(client, db):
    staff, _ = seed_staff(client, db)
    db.add(CampusRecord(id="nku-other", name="其他校区"))
    db.flush()
    public = panorama(db, place(db))
    panorama(db, place(db, campus="nku-other"), title="其他校区场景")
    panorama(db, place(db, status="draft"), title="未发布地点")
    panorama(db, place(db, status="retired"), title="下架地点")
    panorama(db, place(db, visibility="restricted"), title="受限地点")
    draft_point = place(db)
    for resource_id, point_id in ((str(uuid4()), draft_point.id), (public.id, public.point_id)):
        db.add(
            ResourceChangeRecord(
                resource_id=resource_id,
                point_id=point_id,
                kind="panorama",
                revision=1,
                base_revision=0 if resource_id != public.id else 1,
                state="draft",
                editor_id=staff["editor"].id,
                contributor_ids=[staff["editor"].id],
                payload={
                    "content": {
                        "kind": "panorama",
                        "title": "未发布全景修改",
                        "url": "https://example.org/draft",
                        "description": "",
                    },
                    "source_note": "未审核资料",
                },
            )
        )
    panorama(db, place(db), status="retired", title="下架全景")
    db.commit()
    response = client.get("/api/v1/campuses/nku-jinnan/panoramas")
    assert response.status_code == 200
    rows = response.json()["data"]
    assert [r["id"] for r in rows] == [public.id]
    assert rows[0]["point_name"] == "独立视点"
    assert rows[0]["point_category"] == "public_area"
    assert rows[0]["campus_id"] == "nku-jinnan"
    assert rows[0]["url"] == public.url
    assert response.json()["meta"]["pagination"]["total"] == 1
    other = client.get("/api/v1/campuses/nku-other/panoramas").json()["data"]
    assert len(other) == 1 and other[0]["title"] == "其他校区场景"
    db.get(CampusRecord, "nku-other").is_active = False
    db.commit()
    assert client.get("/api/v1/campuses/nku-other/panoramas").status_code == 404
    assert client.get("/api/v1/campuses/nku-missing/panoramas").status_code == 404


def test_directory_paginated_duplicates_and_vr_capability(client, db):
    point = place(db, category="academic")
    for _ in range(105):
        panorama(db, point, title="同名视点")
    db.commit()
    first = client.get("/api/v1/campuses/nku-jinnan/panoramas").json()
    second = client.get("/api/v1/campuses/nku-jinnan/panoramas?page=2").json()
    rows = first["data"] + second["data"]
    assert len(first["data"]) == 100 and len(second["data"]) == 5
    assert len({r["id"] for r in rows}) == 105
    assert first["meta"]["pagination"]["total"] == 105
    assert all(r["point_category"] == "academic" for r in rows)
    assert client.get("/api/v1/campuses/nku-jinnan/panoramas?page=0").status_code == 422
    assert client.get("/api/v1/campuses/nku-jinnan/panoramas?page_size=101").status_code == 422
    client.app.state.settings.vr_enabled = False
    disabled = client.get("/api/v1/campuses/nku-jinnan/panoramas").json()
    assert disabled["data"] == [] and disabled["meta"]["pagination"]["total"] == 0
