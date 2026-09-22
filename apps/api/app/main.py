import logging
import time
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api import router
from app.core.config import Settings, get_settings
from app.core.errors import (
    DomainError,
    domain_error_handler,
    error_response,
    http_error_handler,
    validation_error_handler,
)

logger = logging.getLogger("twinnku")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    production = settings.app_env == "production"
    app = FastAPI(
        title="Twin NKU API",
        version=settings.app_version,
        description="M00 implemented endpoints only. Full target contract: contracts/openapi.json.",
        docs_url=None if production else "/docs",
        redoc_url=None if production else "/redoc",
        openapi_url=None if production else "/openapi.json",
    )
    app.state.settings = settings
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    app.add_exception_handler(DomainError, domain_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(HTTPException, http_error_handler)

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
        response.headers["Cache-Control"] = "no-store"
        logger.info(
            "request id=%s method=%s status=%s duration_ms=%.1f",
            request.state.request_id,
            request.method,
            response.status_code,
            (time.monotonic() - started) * 1000,
        )
        return response

    app.include_router(router)
    return app


app = create_app()
