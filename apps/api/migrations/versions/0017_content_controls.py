"""Point, resource and navigation immutable history and exact write receipts.

Revision ID: 0017_content_controls
Revises: 0016_import_jobs
"""

import hashlib
import json
from datetime import UTC, datetime
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision = "0017_content_controls"
down_revision = "0016_import_jobs"
branch_labels = None
depends_on = None


def sha(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def upgrade():
    op.create_table(
        "content_versions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("entity_type", sa.String(24), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("event", sa.String(24), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("published_revision", sa.Integer, nullable=False),
        sa.Column("content", sa.JSON, nullable=False),
        sa.Column("content_sha256", sa.String(64), nullable=False),
        sa.Column("contributor_ids", sa.JSON, nullable=False),
        sa.Column(
            "actor_id",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    for name in ("entity_type", "entity_id", "created_at"):
        op.create_index("ix_content_versions_" + name, "content_versions", [name])
    op.create_table(
        "content_operations",
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("entity_type", sa.String(24), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("result", sa.JSON, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_content_operations_entity_id", "content_operations", ["entity_id"])
    op.create_table(
        "content_submissions",
        sa.Column("entity_type", sa.String(24), primary_key=True),
        sa.Column("entity_id", sa.String(36), primary_key=True),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("content_sha256", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("entity_type", "entity_id"),
    )
    connection = op.get_bind()
    metadata = sa.MetaData()
    tables = {
        name: sa.Table(name, metadata, autoload_with=connection)
        for name in (
            "points",
            "point_changes",
            "resource_changes",
            "floors",
            "panoramas",
            "navigation_graphs",
            "point_geometries",
        )
    }
    versions = sa.Table("content_versions", metadata, autoload_with=connection)
    submissions = sa.Table("content_submissions", metadata, autoload_with=connection)

    def store(kind, key, value):
        connection.execute(
            versions.insert().values(
                id=str(uuid4()),
                entity_type=kind,
                entity_id=key,
                event="migration",
                revision=value["revision"],
                published_revision=value["published_revision"],
                content=value,
                content_sha256=sha(value),
                contributor_ids=value["contributor_ids"],
                actor_id=None,
                created_at=datetime.now(UTC),
            )
        )
        if value["state"] == "in_review":
            frozen = {
                name: value.get(name)
                for name in (
                    "draft",
                    "operation",
                    "base_revision",
                    "contributor_ids",
                    "submitted_by",
                )
            }
            connection.execute(
                submissions.insert().values(
                    entity_type=kind,
                    entity_id=key,
                    revision=value["revision"],
                    content_sha256=sha(frozen),
                    created_at=datetime.now(UTC),
                )
            )

    changes = {
        r["point_id"]: r for r in connection.execute(sa.select(tables["point_changes"])).mappings()
    }
    for point in connection.execute(sa.select(tables["points"])).mappings():
        change = changes.get(point["id"])
        geometries = [
            dict(r)
            for r in connection.execute(
                sa.select(tables["point_geometries"]).where(
                    tables["point_geometries"].c.point_id == point["id"]
                )
            ).mappings()
        ]
        raw = {k: v for k, v in point.items() if k not in {"updated_at", "created_at"}}
        store(
            "point",
            point["id"],
            {
                "draft": change["payload"] if change else None,
                "published": {"raw": raw, "geometries": geometries},
                "revision": change["revision"] if change else 0,
                "published_revision": point["revision"],
                "operation": change["operation"] if change else "upsert",
                "state": change["state"] if change else "published",
                "contributor_ids": change["contributor_ids"] if change else [],
                "submitted_by": change["submitted_by"] if change else None,
                "base_revision": change["base_revision"] if change else point["revision"],
            },
        )
    resources = {
        r["resource_id"]: r
        for r in connection.execute(sa.select(tables["resource_changes"])).mappings()
    }
    for table_name, kind in (("floors", "floor"), ("panoramas", "vr")):
        for current in connection.execute(sa.select(tables[table_name])).mappings():
            change = resources.pop(current["id"], None)
            if kind == "floor":
                content = {
                    "kind": "floor",
                    "label": current["label"],
                    "ordinal": current["ordinal"],
                    "attribution": current["attribution"],
                    "images": [
                        {
                            "section": img.get("section", "main"),
                            "section_label": img.get("section_label"),
                        }
                        for img in current["images"]
                        if img["variant"] == "labeled"
                    ],
                }
            else:
                content = {
                    "kind": "panorama",
                    **{k: current[k] for k in ("title", "url", "description")},
                }
            store(
                kind,
                current["id"],
                {
                    "draft": change["payload"] if change else None,
                    "published": {
                        "content": content,
                        "revision": current["revision"],
                        "status": current["status"],
                        "images": current["images"] if kind == "floor" else [],
                    },
                    "revision": change["revision"] if change else 0,
                    "published_revision": current["revision"],
                    "operation": change["operation"] if change else "upsert",
                    "state": change["state"] if change else "published",
                    "contributor_ids": change["contributor_ids"] if change else [],
                    "submitted_by": change["submitted_by"] if change else None,
                    "base_revision": change["base_revision"] if change else current["revision"],
                },
            )
    for key, change in resources.items():
        store(
            "floor" if change["kind"] == "floor" else "vr",
            key,
            {
                "draft": change["payload"],
                "published": None,
                "revision": change["revision"],
                "published_revision": 0,
                "operation": change["operation"],
                "state": change["state"],
                "contributor_ids": change["contributor_ids"],
                "submitted_by": change["submitted_by"],
                "base_revision": change["base_revision"],
            },
        )
    for row in connection.execute(sa.select(tables["navigation_graphs"])).mappings():
        store(
            "navigation",
            row["map_id"],
            {
                "draft": row["draft"],
                "published": row["published"],
                "revision": row["revision"],
                "published_revision": row["published_revision"],
                "state": row["state"],
                "operation": "upsert",
                "contributor_ids": row["contributor_ids"],
                "submitted_by": None,
            },
        )


def downgrade():
    for table in ("content_submissions", "content_operations", "content_versions"):
        op.drop_table(table)
