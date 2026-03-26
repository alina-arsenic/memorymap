from app.api import (
    admin,
    auth,
    blocks,
    bot_places,
    comments,
    friends,
    group_invites,
    groups,
    layers,
    me,
    media,
    moderation,
    notifications,
    places,
    reports,
    users,
)
from app.api import bot as bot_api
from fastapi import FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

app = FastAPI(title="MemoryMap API")


# Security headers
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response

app.include_router(auth.router, prefix="/v1")
app.include_router(bot_api.router, prefix="/v1")
app.include_router(bot_places.router, prefix="/v1")

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

app.include_router(media.router, prefix="/v1")
app.include_router(me.router, prefix="/v1")
app.include_router(group_invites.router, prefix="/v1")
app.include_router(groups.router, prefix="/v1")
app.include_router(layers.router, prefix="/v1")
app.include_router(places.router, prefix="/v1")
app.include_router(reports.router, prefix="/v1")
app.include_router(comments.router, prefix="/v1")
app.include_router(notifications.router, prefix="/v1")
app.include_router(admin.router, prefix="/v1")
app.include_router(moderation.router, prefix="/v1")
app.include_router(users.router, prefix="/v1")
app.include_router(friends.router, prefix="/v1")
app.include_router(blocks.router, prefix="/v1")

# SPA fallback — прямой переход на /settings (закладка, F5) отдаёт index.html
@app.get("/settings")
async def spa_settings():
    return FileResponse("frontend/index.html")

# static frontend
app.mount("/", StaticFiles(directory="frontend", html=True), name="static")
