import re
import uuid

from app.core.auth import get_current_user
from app.core.config import ALLOWED_IMAGE_EXTENSIONS, ALLOWED_IMAGE_MIMES, MEDIA_LIMIT_PER_PLACE
from app.core.deps import get_db
from app.models.models import Group, Media, Place, User
from app.services.groups import GroupService
from app.storage import delete_object, presign_get, presign_put
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

# Паттерны S3-ключей
_PLACE_KEY_RE = re.compile(r"^places/(\d+)/[0-9a-f\-]{36}\.\w{1,5}$")
_UPLOAD_KEY_RE = re.compile(r"^uploads/(\d+)/[0-9a-f\-]{36}\.\w{1,5}$")

router = APIRouter()

class PresignUploadReq(BaseModel):
    mime: str
    ext: str | None = None
    place_id: int | None = None

@router.post("/media/presign-upload")
def api_presign_upload(req: PresignUploadReq, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Валидация расширения
    ext = (req.ext or "").strip(".").lower()
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="invalid_extension")

    # Валидация MIME-типа
    if req.mime not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(status_code=400, detail="invalid_mime")

    if req.place_id is not None:
        count = db.query(Media).filter(Media.place_id == req.place_id).count()
        if count >= MEDIA_LIMIT_PER_PLACE:
            raise HTTPException(status_code=400, detail="media_limit")

    fname = f"uploads/{current_user.id}/{uuid.uuid4()}.{ext}"
    url = presign_put(fname, req.mime)
    return {"key": fname, "url": url, "expires_in": 600}

@router.get("/media/presign-download")
def presign_download(
    key: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Проверка прав доступа по формату ключа
    place_match = _PLACE_KEY_RE.match(key)
    upload_match = _UPLOAD_KEY_RE.match(key)

    if place_match:
        # places/{place_id}/... — проверяем доступ к группе
        place_id = int(place_match.group(1))
        place = db.query(Place).filter(Place.id == place_id).one_or_none()
        if not place:
            raise HTTPException(status_code=404, detail="place_not_found")
        group = db.query(Group).filter(Group.id == place.group_id).one_or_none()
        if not group:
            raise HTTPException(status_code=404, detail="group_not_found")
        try:
            GroupService.require_can_view(db, current_user, group)
        except PermissionError:
            raise HTTPException(status_code=403, detail="no_access")
    elif upload_match:
        # uploads/{user_id}/... — только владелец
        owner_id = int(upload_match.group(1))
        if owner_id != current_user.id:
            raise HTTPException(status_code=403, detail="no_access")
    else:
        raise HTTPException(status_code=400, detail="invalid_key")

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

    # сначала s3: оригинал + миниатюра
    delete_object(m.s3_key)
    if m.thumb_key:
        delete_object(m.thumb_key)

    # потом db
    db.delete(m)
    db.commit()
    return {"status": "ok"}
