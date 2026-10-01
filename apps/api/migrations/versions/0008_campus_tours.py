"""Campus-owned tours; keep all reviewed JSON and publication revisions intact."""

import sqlalchemy as sa
from alembic import op

revision = "0008_campus_tours"
down_revision = "0007_experiences"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("experiences", sa.Column("campus_id", sa.String(64), nullable=True))
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "UPDATE experiences SET campus_id = "
            "(SELECT points.campus_id FROM points WHERE points.id = experiences.point_id)"
        )
    )
    if connection.scalar(sa.text("SELECT count(*) FROM experiences WHERE campus_id IS NULL")):
        raise RuntimeError("Experience campus backfill requires valid existing point references")
    with op.batch_alter_table("experiences") as batch:
        batch.alter_column("campus_id", existing_type=sa.String(64), nullable=False)
        batch.create_foreign_key(
            "fk_experiences_campus_id_campuses",
            "campuses",
            ["campus_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        batch.alter_column("point_id", existing_type=sa.String(36), nullable=True)
    connection.execute(sa.text("UPDATE experiences SET point_id = NULL WHERE kind = 'tour'"))
    with op.batch_alter_table("experiences") as batch:
        batch.create_check_constraint(
            "ck_experiences_point_binding",
            "(kind = 'tour' AND point_id IS NULL) OR (kind <> 'tour' AND point_id IS NOT NULL)",
        )
        batch.create_index("ix_experiences_campus_id", ["campus_id"])


def downgrade():
    # Preserve new campus-tour content when adapting to the previous point-based schema.
    table = sa.table(
        "experiences",
        sa.column("id", sa.String),
        sa.column("kind", sa.String),
        sa.column("point_id", sa.String),
        sa.column("draft", sa.JSON),
        sa.column("published", sa.JSON),
    )
    connection = op.get_bind()
    rows = connection.execute(sa.select(table).where(table.c.kind == "tour")).mappings().all()
    with op.batch_alter_table("experiences") as batch:
        batch.drop_constraint("ck_experiences_point_binding", type_="check")
    for row in rows:
        reference = row["published"] or row["draft"]
        if not reference:
            raise RuntimeError("Tour has no recoverable stop reference; restore a verified backup")
        legacy_owners = {
            content["point_id"]
            for content in (row["published"], row["draft"])
            if content and content.get("point_id")
        }
        if len(legacy_owners) > 1:
            raise RuntimeError("Tour snapshots disagree on legacy owner; restore a verified backup")
        owner = next(iter(legacy_owners), None) or reference["stops"][0]["point_id"]
        values = {"point_id": owner}
        for field in ("draft", "published"):
            content = row[field]
            if content:
                content = dict(content)
                content.pop("campus_id", None)
                # The prior API treats this owner as immutable across snapshots,
                # even if editors changed the first route stop in a new draft.
                content.setdefault("point_id", owner)
                values[field] = content
        connection.execute(table.update().where(table.c.id == row["id"]).values(**values))
    with op.batch_alter_table("experiences") as batch:
        batch.alter_column("point_id", existing_type=sa.String(36), nullable=False)
        batch.drop_index("ix_experiences_campus_id")
        batch.drop_constraint("fk_experiences_campus_id_campuses", type_="foreignkey")
        batch.drop_column("campus_id")
