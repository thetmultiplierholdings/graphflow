"""Request bodies (pydantic). Responses are plain dicts — snake_case, integer
ids; ArtifactMeta never carries payload bytes."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class EngagementCreate(BaseModel):
    label: str = Field(min_length=1)


class WorkspaceCreate(BaseModel):
    workflow_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    copy_from: int | None = None


class WorkspacePatch(BaseModel):
    label: str | None = None
    workflow_id: str | None = None


class ArchiveBody(BaseModel):
    archived: bool


class AttachBody(BaseModel):
    artifact_id: int


class ArtifactPatch(BaseModel):
    label: str = Field(min_length=1)


class HumanTaskSubmit(BaseModel):
    reviewer: str = Field(min_length=1)
    result: dict[str, Any]
