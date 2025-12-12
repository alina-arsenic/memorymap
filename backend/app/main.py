from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api import media, me, groups, places

app = FastAPI(title="MemoryMap API")

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

app.include_router(media.router, prefix="/v1")
app.include_router(me.router, prefix="/v1")
app.include_router(groups.router, prefix="/v1")
app.include_router(places.router, prefix="/v1")

# Static frontend (монтируется из volume: ./frontend -> /app/frontend)
app.mount("/", StaticFiles(directory="frontend", html=True), name="static")
