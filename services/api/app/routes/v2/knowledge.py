from fastapi import APIRouter, Query

from ._common import build_response, decorate_entity

router = APIRouter()


@router.get("")
def search_knowledge(project_id: str, q: str = Query(..., min_length=1)) -> dict:
    result = decorate_entity("knowledge-1", "knowledge", f"Result for: {q}", f"knowledge:{q}")
    result["entity_links"]["project"] = f"/api/v2/projects/{project_id}/knowledge"
    return build_response(project_id, [result])
