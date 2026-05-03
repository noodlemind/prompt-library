from fastapi import APIRouter

from ._common import build_response, decorate_entity

router = APIRouter()


@router.get("")
def list_entities(project_id: str) -> dict:
    entity_type = __name__.rsplit('.', 1)[-1]
    entity = decorate_entity("1", entity_type, f"Sample {entity_type[:-1]}", f"{entity_type}:1")
    entity["entity_links"]["project"] = f"/api/v2/projects/{project_id}/{entity_type}"
    return build_response(project_id, [entity])
