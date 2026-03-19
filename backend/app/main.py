from app.api import (
    admin,
    auth,
    bot_places,
    friends,
    group_invites,
    groups,
    layers,
    me,
    media,
    moderation,
    places,
    reports,
    users,
)
from app.api import bot as bot_api
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="MemoryMap API")
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
app.include_router(admin.router, prefix="/v1")
app.include_router(moderation.router, prefix="/v1")
app.include_router(users.router, prefix="/v1")
app.include_router(friends.router, prefix="/v1")

# static frontend
app.mount("/", StaticFiles(directory="frontend", html=True), name="static")
