"""API: жалобы на точки (постмодерация)."""

from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import User
from app.services.reports import ReportService
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter()


class ReportRequest(BaseModel):
    category: str
    comment: str | None = None


@router.post("/places/{place_id}/report")
def create_report(
    place_id: int,
    req: ReportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Пожаловаться на точку."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        report = ReportService.create_report(
            db=db,
            user=current_user,
            place_id=place_id,
            category=req.category,
            comment=req.comment,
        )
    except ValueError as e:
        msg = str(e)
        if msg == "place_not_found":
            raise HTTPException(status_code=404, detail=msg)
        # Все остальные — 400
        raise HTTPException(status_code=400, detail=msg)

    return {"status": "ok", "report_id": report.id}
