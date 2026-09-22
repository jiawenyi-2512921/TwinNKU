from uuid import UUID, uuid4

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.contracts import ErrorEnvelope, ErrorInfo, FieldError, Meta


class DomainError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status


def request_id(request: Request) -> UUID:
    return getattr(request.state, "request_id", uuid4())


def error_response(request: Request, status: int, code: str, message: str, details=None):
    payload = ErrorEnvelope(
        error=ErrorInfo(code=code, message=message, details=details or []),
        meta=Meta(request_id=request_id(request)),
    )
    return JSONResponse(payload.model_dump(mode="json", exclude_none=True), status_code=status)


async def domain_error_handler(request: Request, exc: DomainError):
    return error_response(request, exc.status, exc.code, exc.message)


async def validation_error_handler(request: Request, exc: RequestValidationError):
    # Never echo rejected input or exception context: they may contain private text.
    details = [
        FieldError(field=".".join(map(str, err["loc"])), message="字段格式或取值不符合接口要求")
        for err in exc.errors()
    ]
    return error_response(request, 422, "VALIDATION_ERROR", "请检查请求参数", details)


async def http_error_handler(request: Request, exc: HTTPException):
    code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "HTTP_ERROR")
    message = "请求的资源不存在" if exc.status_code == 404 else "请求无法处理"
    return error_response(request, exc.status_code, code, message)
