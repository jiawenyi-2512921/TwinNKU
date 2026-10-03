import logging
import time
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm.exc import StaleDataError
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import (
    backup_models,  # noqa: F401 -- register current metadata before DB initialization
    content_control_models,  # noqa: F401 -- register current metadata before DB initialization
)
from app.api import router
from app.core.config import Settings, get_settings
from app.core.errors import (
    DomainError,
    domain_error_handler,
    error_response,
    http_error_handler,
    validation_error_handler,
)
from app.integrations.chat_runtime import ChatRuntime
from app.modules.admin.resources import router as resources_router
from app.modules.admin.router import router as admin_router
from app.modules.admin.workbench import router as workbench_router
from app.modules.assistant import router as assistant_router
from app.modules.backups.router import router as backups_router
from app.modules.configurations import router as configurations_router
from app.modules.content_control import router as content_control_router
from app.modules.experience_history_preview import router as experience_history_preview_router
from app.modules.experiences import router as experiences_router
from app.modules.floors.router import router as floors_router
from app.modules.guide.router import router as guide_router
from app.modules.guide_settings import router as guide_settings_router
from app.modules.imports.router import router as imports_router
from app.modules.maps.router import router as maps_router
from app.modules.narration.router import router as narration_router
from app.modules.navigation import router as navigation_router
from app.modules.road_assist import router as road_assist_router
from app.modules.voice.router import router as voice_router

logger = logging.getLogger("twinnku")


def _fallback_log_filter(record: logging.LogRecord) -> bool:
    # Keep propagation available for externally configured handlers (and caplog)
    # without printing twice if a parent handler is installed after startup.
    parent = logger.parent
    while parent is not None:
        if any(handler.level <= record.levelno for handler in parent.handlers):
            return False
        if not parent.propagate:
            break
        parent = parent.parent
    return True


def _configure_application_logging() -> None:
    # Uvicorn's default configuration has no root handler. Enable only this
    # application's safe metadata logs, leaving third-party loggers untouched.
    if not logger.hasHandlers():
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
        handler.addFilter(_fallback_log_filter)
        logger.addHandler(handler)
        if logger.level == logging.NOTSET:
            logger.setLevel(logging.INFO)


def create_app(settings: Settings | None = None) -> FastAPI:
    _configure_application_logging()
    settings = settings or get_settings()
    production = settings.app_env == "production"
    app = FastAPI(
        title="Twin NKU API",
        version=settings.app_version,
        description="Implemented foundation and map endpoints. Full target contract: contracts/openapi.json.",
        docs_url=None if production else "/docs",
        redoc_url=None if production else "/redoc",
        openapi_url=None if production else "/openapi.json",
    )
    app.state.settings = settings
    app.state.agent_runtime = ChatRuntime(
        settings.nk_genios_api_key.get_secret_value(),
        settings.agent_access_code.get_secret_value() if settings.agent_access_code else "",
    ) if settings.api_agent_configured else None
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    app.add_exception_handler(DomainError, domain_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(HTTPException, http_error_handler)

    @app.exception_handler(StaleDataError)
    async def revision_conflict(request: Request, _exc: StaleDataError):
        return error_response(
            request, 409, "REVISION_CONFLICT", "内容已被他人修改，请重新加载后再保存"
        )

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, _exc: SQLAlchemyError):
        return error_response(request, 503, "DATABASE_NOT_READY", "服务暂不可用，请稍后重试")

    @app.middleware("http")
    async def trace_request(request: Request, call_next):
        request.state.request_id = uuid4()
        started = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            # Log type-neutral metadata only: URLs, database errors and user text may contain secrets.
            logger.error("unhandled_error request_id=%s", request.state.request_id)
            response = error_response(request, 500, "INTERNAL_ERROR", "服务暂不可用，请稍后重试")
        response.headers["X-Request-ID"] = str(request.state.request_id)
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Resource endpoints may opt in to private, revalidated byte reuse after
        # authorization. JSON and every error response must remain uncacheable.
        if response.status_code >= 400:
            response.headers["Cache-Control"] = "no-store"
        else:
            response.headers.setdefault("Cache-Control", "no-store")
        logger.info(
            "request id=%s method=%s status=%s duration_ms=%.1f",
            request.state.request_id,
            request.method,
            response.status_code,
            (time.monotonic() - started) * 1000,
        )
        return response

    app.include_router(router)
    app.include_router(maps_router)
    app.include_router(floors_router)
    app.include_router(admin_router)
    app.include_router(workbench_router)
    app.include_router(resources_router)
    app.include_router(guide_router)
    app.include_router(navigation_router)
    app.include_router(road_assist_router)
    app.include_router(assistant_router)
    app.include_router(experiences_router)
    app.include_router(experience_history_preview_router)
    app.include_router(guide_settings_router)
    app.include_router(voice_router)
    app.include_router(narration_router)
    app.include_router(configurations_router)
    app.include_router(imports_router)
    app.include_router(content_control_router)
    app.include_router(backups_router)
    return app


app = create_app()
