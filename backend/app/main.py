from typing import Optional, List, Dict
from fastapi import FastAPI, Query, Depends, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from .storage import presign_put, presign_get
from .services import PlaceService, GroupService, UserService
from .auth import get_current_user
from .db import SessionLocal
from .models import User
import uuid
from fastapi import FastAPI, Query, Depends, HTTPException


app = FastAPI(title="MemoryMap API")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


# ---------- Media ----------

class PresignUploadReq(BaseModel):
    mime: str
    ext: str | None = None


@app.post("/v1/media/presign-upload")
def api_presign_upload(req: PresignUploadReq):
    ext = (req.ext or "").strip(".")
    fname = f"uploads/{uuid.uuid4()}" + (f".{ext}" if ext else "")
    url = presign_put(fname, req.mime)
    return {"key": fname, "url": url, "expires_in": 600}


@app.get("/v1/media/presign-download")
def api_presign_download(key: str = Query(...)):
    url = presign_get(key)
    return {"url": url, "expires_in": 300}


# ---------- Auth / Profile ----------

class AddFriendReq(BaseModel):
    friend_tg_id: int


@app.get("/v1/me")
def api_me(current_user: User = Depends(get_current_user)):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    db = SessionLocal()
    try:
        groups = GroupService.list_groups(db, current_user)
        friends = UserService.list_friends(db, current_user)
        return {
            "id": current_user.id,
            "tg_id": current_user.tg_id,
            "username": current_user.username,
            "groups": groups,
            "friends": friends,
        }
    finally:
        db.close()


@app.post("/v1/friends")
def api_add_friend(req: AddFriendReq, current_user: User = Depends(get_current_user)):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    db = SessionLocal()
    try:
        friend = UserService.add_friend(db, current_user, req.friend_tg_id)
        return friend
    finally:
        db.close()


# ---------- Groups ----------

class GroupCreate(BaseModel):
    name: str
    visibility: str = "private"  # private | friends | public
    add_friends: bool = False    # добавить всех друзей как редакторов


@app.get("/v1/groups")
def list_groups(current_user: Optional[User] = Depends(get_current_user)):
    db = SessionLocal()
    try:
        items = GroupService.list_groups(db, current_user)
        return {"items": items}
    finally:
        db.close()


@app.post("/v1/groups")
def create_group(g: GroupCreate, current_user: User = Depends(get_current_user)):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    db = SessionLocal()
    try:
        gid = GroupService.create_group(
            db,
            owner=current_user,
            name=g.name,
            visibility=g.visibility,
            add_friends=g.add_friends,
        )
        return {"id": gid}
    finally:
        db.close()


# ---------- Places ----------

class PlaceCreate(BaseModel):
    group_id: int
    user_id: Optional[int] = None
    tg_id: Optional[int] = None
    username: Optional[str] = None

    title: Optional[str] = None
    note: Optional[str] = None
    lat: float
    lon: float
    media_keys: List[str] = []


@app.post("/v1/places")
def create_place(p: PlaceCreate):
    pid = PlaceService.create_place(
        group_id=p.group_id,
        user_id=p.user_id,
        tg_id=p.tg_id,
        username=p.username,
        title=p.title,
        note=p.note,
        lat=p.lat,
        lon=p.lon,
        media_keys=p.media_keys,
    )
    return {"id": pid}


@app.get("/v1/places")
def list_places(group_id: int, bbox: str):
    items = PlaceService.list_places(group_id=group_id, bbox=bbox)
    return {"items": items}


@app.delete("/v1/places/{place_id}")
def delete_place(place_id: int, current_user: User = Depends(get_current_user)):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    db = SessionLocal()
    try:
        ok = PlaceService.delete_place(db, place_id, current_user)
        if not ok:
            # либо точка не найдена, либо не твоя
            raise HTTPException(status_code=403, detail="Forbidden")
        return {"status": "ok"}
    finally:
        db.close()


# ---------- Static frontend ----------

app.mount("/", StaticFiles(directory="frontend", html=True), name="static")
