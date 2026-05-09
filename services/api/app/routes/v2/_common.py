from __future__ import annotations

from typing import Any


def build_response(project_id: str, data: list[dict[str, Any]], page: int = 1) -> dict[str, Any]:
    return {
        "data": data,
        "meta": {
            "project_id": project_id,
            "total": len(data),
            "page": page,
        },
    }


def decorate_entity(entity_id: str, entity_type: str, title: str, source_ref: str) -> dict[str, Any]:
    return {
        "id": entity_id,
        "type": entity_type,
        "title": title,
        "lifecycle_state": "active",
        "provenance": {
            "source_type": "system",
            "source_ref": source_ref,
        },
        "entity_links": {
            "self": f"/api/v2/{entity_type}/{entity_id}",
            "project": f"/api/v2/projects/{{project_id}}/{entity_type}",
        },
    }
