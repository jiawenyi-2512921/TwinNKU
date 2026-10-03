"""Reviewed pixel-camera defaults never become arbitrary layers or public drafts."""

from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from test_admin import login
from test_configurations import CONFIG, SHOWCASE, action, create, publish, save
from test_configurations import staff as staff

from app.configuration_models import ConfigurationRecord
from app.models import CampusRecord, MapRecord
from app.modules.configuration_schemas import MapDefaultView, VisitDefaultsContent


def view(record, **values):
    return {
        "map_id": record.id, "map_revision": record.revision,
        "center": {"x": 300, "y": 240}, "zoom": -0.5,
        "min_zoom": -2, "max_zoom": record.max_native_zoom + 1, **values,
    }


def current_map(db):
    return db.scalar(select(MapRecord).where(MapRecord.campus_id == "nku-jinnan"))


def other_map(db):
    db.add(CampusRecord(id="other-campus", name="另一真实测试校区", description="测试"))
    record = MapRecord(id=str(uuid4()), campus_id="other-campus", title="另一校区底图",
        revision=4, width_px=900, height_px=700, image_asset_id=str(uuid4()),
        source_sha256="b" * 64, tile_size=256, max_native_zoom=2,
        attribution="测试", kind="campus", status="published", visibility="public")
    db.add(record)
    db.commit()
    return record


def test_defaults_keep_legacy_fit_labels_and_only_registered_existing_layers():
    old = VisitDefaultsContent(map_show_labels=False)
    assert old.map_default_view is None and old.map_layers == ["point_regions"]
    assert old.map_focus_effect == "short" and old.map_show_labels is False
    for fields in ({"map_layers": ["https://evil.test/tile"]},
        {"map_layers": ["point_regions", "point_regions"]},
        {"map_focus_effect": "script"}, {"map_categories": ["academic", "academic"]}):
        with pytest.raises(ValidationError):
            VisitDefaultsContent(**fields)


@pytest.mark.parametrize("values", [
    {"zoom": float("nan")}, {"center": {"x": float("inf"), "y": 1}},
    {"zoom": -9}, {"min_zoom": 2, "zoom": 1, "max_zoom": 3},
    {"min_zoom": -2, "zoom": 3, "max_zoom": 1},
])
def test_pixel_camera_schema_rejects_nonfinite_and_inverted_ranges(values):
    with pytest.raises(ValidationError):
        MapDefaultView.model_validate({"map_id": str(uuid4()), "map_revision": 1,
            "center": {"x": 1, "y": 1}, "min_zoom": -2, "zoom": 0, "max_zoom": 1, **values})


def test_reviewed_default_can_use_negative_camera_zoom_and_stays_private_until_independent_review(client, db, staff):
    record = current_map(db)
    login(client)
    camera = view(record)
    item = create(client, "visit_defaults", content={"kind": "visit_defaults",
        "map_default_view": camera, "map_layers": [], "map_show_labels": False,
        "map_focus_effect": "instant", "map_categories": ["history", "academic"]})
    assert client.get(SHOWCASE).json()["data"]["visit_defaults"]["map_default_view"] is None
    checked = action(client, item, "preflight")
    assert checked["valid"] is True
    item = publish(client, item)
    client.cookies.clear()
    public = client.get(SHOWCASE).json()["data"]["visit_defaults"]
    assert public["map_default_view"] == camera
    assert public["map_layers"] == [] and public["map_show_labels"] is False
    assert public["map_categories"] == ["history", "academic"]
    assert db.get(ConfigurationRecord, item["id"]).published["map_default_view"] == camera


@pytest.mark.parametrize("values", [
    {"center": {"x": 1001, "y": 1}}, {"center": {"x": 1, "y": 801}},
    {"max_zoom": 3},
])
def test_save_blocks_current_pixel_bounds_and_camera_zoom_above_actual_native_limit(client, db, staff, values):
    login(client)
    create(client, "visit_defaults", content={"kind": "visit_defaults",
        "map_default_view": view(current_map(db), **values)}, expected=422)
    assert db.scalar(select(ConfigurationRecord)) is None


def test_cross_campus_and_out_of_staff_scope_map_defaults_are_rejected(client, db, staff):
    foreign = other_map(db)
    login(client)
    create(client, "visit_defaults", content={"kind": "visit_defaults",
        "map_default_view": view(foreign)}, expected=403)
    login(client, "admin")
    create(client, "visit_defaults", scope="nku-jinnan", content={"kind": "visit_defaults",
        "map_default_view": view(foreign)}, expected=403)


def test_map_version_race_blocks_review_and_existing_public_default_falls_back_without_rewriting_snapshot(client, db, staff):
    record = current_map(db)
    login(client)
    item = create(client, "visit_defaults", content={"kind": "visit_defaults", "map_default_view": view(record)})
    item = publish(client, item)
    original = db.get(ConfigurationRecord, item["id"]).published.copy()
    record.revision += 1
    db.commit()
    assert client.get(SHOWCASE).json()["data"]["visit_defaults"]["map_default_view"] is None
    assert db.get(ConfigurationRecord, item["id"]).published == original
    login(client)
    item = save(client, item, {"kind": "visit_defaults", "map_default_view": original["map_default_view"], "welcome_text": "保留失效视角，等待取景"})
    report = action(client, item, "preflight")
    assert not report["valid"]
    issue = next(i for i in report["issues"] if i["code"] == "MAP_DEFAULT_REVISION")
    assert issue["path"] == "map_default_view" and issue["expected_revision"] == 1 and issue["actual_revision"] == 2
    action(client, item, "submit", expected=409)
    repaired = save(client, item, {"kind": "visit_defaults", "map_default_view": view(record)})
    submitted = action(client, repaired, "submit")
    record.revision += 1
    db.commit()
    login(client, "reviewer")
    action(client, submitted, "publish", expected=409)


def test_global_single_map_default_applies_only_to_that_campus_and_campus_null_is_explicit_fit_override(client, db, staff):
    other_map(db)
    record = current_map(db)
    login(client)
    global_record = create(client, "visit_defaults", content={"kind": "visit_defaults", "map_default_view": view(record)})
    publish(client, global_record)
    assert client.get("/api/v1/campuses/other-campus/showcase").json()["data"]["visit_defaults"]["map_default_view"] is None
    login(client)
    campus = create(client, "visit_defaults", scope="nku-jinnan", content={"kind": "visit_defaults", "map_default_view": None})
    campus = publish(client, campus)
    assert client.get(SHOWCASE).json()["data"]["visit_defaults"]["map_default_view"] is None
    login(client)
    campus = save(client, campus, {"kind": "visit_defaults"})
    publish(client, campus)
    assert client.get(SHOWCASE).json()["data"]["visit_defaults"]["map_default_view"]["map_id"] == record.id


def test_retired_or_internal_base_map_cannot_be_adopted_and_is_hidden_from_public_defaults(client, db, staff):
    record = current_map(db)
    login(client)
    item = create(client, "visit_defaults", content={"kind": "visit_defaults", "map_default_view": view(record)})
    item = publish(client, item)
    record.visibility = "internal"
    db.commit()
    assert client.get(SHOWCASE).json()["data"]["visit_defaults"]["map_default_view"] is None
    login(client)
    # Existing configuration is still readable; adopting the now-private map fails.
    assert client.get(f"{CONFIG}/{item['id']}").status_code == 200
    report = action(client, item, "preflight")
    issue = next(i for i in report["issues"] if i["code"] == "MAP_DEFAULT_NOT_PUBLIC")
    assert issue["actual_revision"] is None
    save(client, item, {"kind": "visit_defaults", "map_default_view": view(record)}, expected=409)


def test_sparse_map_fields_report_true_builtin_global_and_campus_sources_without_private_write(client, db, staff):
    login(client)
    global_record = create(client, "visit_defaults", content={"kind": "visit_defaults", "map_default_view": view(current_map(db)), "map_categories": ["academic", "history"]})
    publish(client, global_record)
    login(client)
    campus = create(client, "visit_defaults", scope="nku-jinnan", content={"kind": "visit_defaults", "map_show_labels": False})
    publish(client, campus)
    public = client.get(SHOWCASE).json()["data"]
    assert public["visit_default_sources"]["map_default_view"] == "global"
    assert public["visit_default_sources"]["map_categories"] == "global"
    assert public["visit_default_sources"]["map_show_labels"] == "campus"
    assert public["visit_default_sources"]["map_layers"] == "builtin"
    login(client)
    preview = client.post(f"{CONFIG}/preview", json={"kind": "visit_defaults", "scope": "nku-jinnan", "campus_id": "nku-jinnan", "content": {"kind": "visit_defaults", "map_default_view": None}})
    assert preview.status_code == 200
    assert preview.json()["data"]["visit_default_sources"]["map_default_view"] == "campus"
    assert preview.json()["data"]["visit_defaults"]["map_default_view"] is None
    assert client.get(SHOWCASE).json()["data"]["visit_defaults"]["map_default_view"] is not None
    assert db.get(ConfigurationRecord, campus["id"]).published == {"kind": "visit_defaults", "map_show_labels": False}
