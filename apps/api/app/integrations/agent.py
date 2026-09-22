"""Domain boundary only. No guessed NK-GeniOS endpoint or fake model output."""

from typing import Protocol
from uuid import UUID

from pydantic import Field

from app.contracts import DTO, AgentAction, SourceRef, ViewContext
from app.core.errors import DomainError


class AgentInput(DTO):
    turn_id: UUID
    message: str = Field(min_length=1, max_length=2000)
    context: ViewContext
    allowed_point_ids: list[UUID]


class AgentOutput(DTO):
    answer_text: str
    sources: list[SourceRef]
    proposed_actions: list[AgentAction]


class AgentProvider(Protocol):
    async def generate(self, request: AgentInput) -> AgentOutput: ...


class DisabledAgentProvider:
    async def generate(self, request: AgentInput) -> AgentOutput:
        raise DomainError("AGENT_UNAVAILABLE", "智能导览尚未接通，请先浏览已发布资料", 503)
