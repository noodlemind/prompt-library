from fastapi import Depends, FastAPI, Header, HTTPException

from app.routes.v2 import alerts, decisions, knowledge, questions, tasks, wiki

app = FastAPI(title="Prompt Library API", version="2.0.0")


def require_project_auth(authorization: str | None = Header(default=None)) -> None:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization")


app.include_router(
    decisions.router,
    prefix="/api/v2/projects/{project_id}/decisions",
    tags=["v2"],
    dependencies=[Depends(require_project_auth)],
)
app.include_router(
    tasks.router,
    prefix="/api/v2/projects/{project_id}/tasks",
    tags=["v2"],
    dependencies=[Depends(require_project_auth)],
)
app.include_router(
    questions.router,
    prefix="/api/v2/projects/{project_id}/questions",
    tags=["v2"],
    dependencies=[Depends(require_project_auth)],
)
app.include_router(
    wiki.router,
    prefix="/api/v2/projects/{project_id}/wiki",
    tags=["v2"],
    dependencies=[Depends(require_project_auth)],
)
app.include_router(
    alerts.router,
    prefix="/api/v2/projects/{project_id}/alerts",
    tags=["v2"],
    dependencies=[Depends(require_project_auth)],
)
app.include_router(
    knowledge.router,
    prefix="/api/v2/projects/{project_id}/knowledge",
    tags=["v2"],
    dependencies=[Depends(require_project_auth)],
)
