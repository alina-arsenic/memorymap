from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api import media, me, groups, places, auth, admin, moderation
from app.api import users, friends
from app.api import bot as bot_api
from app.api import bot_places


app = FastAPI(title="MemoryMap API")
app.include_router(auth.router, prefix="/v1")
app.include_router(bot_api.router, prefix="/v1")
app.include_router(bot_places.router, prefix="/v1")

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

app.include_router(media.router, prefix="/v1")
app.include_router(me.router, prefix="/v1")
app.include_router(groups.router, prefix="/v1")
app.include_router(places.router, prefix="/v1")
app.include_router(admin.router, prefix="/v1")
app.include_router(moderation.router, prefix="/v1")
app.include_router(users.router, prefix="/v1")
app.include_router(friends.router, prefix="/v1")

# static frontend
app.mount("/", StaticFiles(directory="frontend", html=True), name="static")
