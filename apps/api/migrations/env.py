from alembic import context

from app import (  # noqa: F401 -- migration metadata
    backup_models,
    configuration_models,
    content_control_models,
    content_history_models,
    import_models,
    narration_models,
)
from app.database import engine
from app.integrations import public_agent_security  # noqa: F401 -- migration metadata
from app.models import Base

if context.is_offline_mode():
    context.configure(url=engine.url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
