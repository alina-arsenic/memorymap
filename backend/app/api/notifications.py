"""API: уведомления пользователей."""

from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import User
from app.services.notifications import NotificationService
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

router = APIRouter()


@router.get("/notifications")
def list_notifications(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Список уведомлений текущего пользователя."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    items = NotificationService.list_notifications(db, current_user.id)
    return {"items": items}


@router.patch("/notifications/read-all")
def mark_all_notifications_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Пометить все уведомления прочитанными."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    count = NotificationService.mark_all_as_read(db, current_user.id)
    return {"status": "ok", "updated": count}


@router.patch("/notifications/{notification_id}/read")
def mark_notification_read(
    notification_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Пометить уведомление прочитанным."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    found = NotificationService.mark_as_read(db, current_user.id, notification_id)
    if not found:
        raise HTTPException(status_code=404, detail="notification_not_found")

    return {"status": "ok"}
