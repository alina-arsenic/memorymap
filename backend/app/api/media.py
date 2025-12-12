import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.core.config import MEDIA_LIMIT_PER_PLACE
from app.models.models import Media
from app.storage import presign_put, presign_get

router = APIRouter()

class PresignUploadReq(BaseModel):
    mime: str
    ext: str | None = None
    place_id: int | None = None

@router.post("/media/presign-upload")
def presign_upload(req: PresignUploadReq, db: Session = Depends(get_db)):
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
