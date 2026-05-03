from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_v2_auth_required() -> None:
    response = client.get("/api/v2/projects/p1/decisions")
    assert response.status_code == 401


def test_v2_decisions_shape() -> None:
    response = client.get(
        "/api/v2/projects/p1/decisions",
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["meta"] == {"project_id": "p1", "total": 1, "page": 1}
    entity = payload["data"][0]
    assert entity["lifecycle_state"] == "active"
    assert entity["provenance"]["source_type"] == "system"
    assert entity["provenance"]["source_ref"] == "decisions:1"
    assert "entity_links" in entity


def test_v2_knowledge_search() -> None:
    response = client.get(
        "/api/v2/projects/p1/knowledge",
        params={"q": "roadmap"},
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["meta"]["project_id"] == "p1"
    assert payload["data"][0]["title"] == "Result for: roadmap"


def test_v2_openapi_available() -> None:
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()
    assert "/api/v2/projects/{project_id}/knowledge" in schema["paths"]
