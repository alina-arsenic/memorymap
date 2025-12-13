import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.core.config import MEDIA_LIMIT_PER_PLACE
from app.models.models import Media, User, Place
from app.storage import presign_put, presign_get, delete_object
from app.core.auth import get_current_user

router = APIRouter()

class PresignUploadReq(BaseModel):
    mime: str
    ext: str | None = None
    place_id: int | None = None

@router.post("/media/presign-upload")
def api_presign_upload(req: PresignUploadReq, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if req.place_id is not None:
        count = db.query(Media).filter(Media.place_id == req.place_id).count()
        if count >= MEDIA_LIMIT_PER_PLACE:
            raise HTTPException(status_code=400, detail="media_limit")

    ext = (req.ext or "").strip(".")
    fname = f"uploads/{uuid.uuid4()}" + (f".{ext}" if ext else "")
    url = presign_put(fname, req.mime)
    return {"key": fname, "url": url, "expires_in": 600}

@router.get("/media/presign-download")
def presign_download(key: str = Query(...)):
    url = presign_get(key)
    return {"url": url, "expires_in": 300}

@router.delete("/media/{media_id}")
def delete_media(
    media_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    m = db.query(Media).filter(Media.id == media_id).one_or_none()
    if not m:
        raise HTTPException(404, "Not found")

    place = db.query(Place).filter(Place.id == m.place_id).one_or_none()
    if not place:
        raise HTTPException(404, "Not found")

    if place.user_id != current_user.id:
        raise HTTPException(403, "Forbidden")

    # сначала s3
    delete_object(m.s3_key)

    # потом db
    db.delete(m)
    db.commit()
    return {"status": "ok"}
