"""API: комментарии к точкам."""

import logging
from typing import Optional

from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import Comment, User
from app.services.comments import CommentService
from app.services.notifications import NotificationService
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter()


class CommentRequest(BaseModel):
    text: str
    parent_id: Optional[int] = None


class CommentEditRequest(BaseModel):
    text: str


@router.post("/places/{place_id}/comments")
def create_comment(
    place_id: int,
    req: CommentRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Создать комментарий к точке."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        comment_data, place, parent_comment, resolved_parent_id = CommentService.create_comment(
            db=db,
            user=current_user,
            place_id=place_id,
            comment_text=req.text,
            parent_id=req.parent_id,
        )
    except ValueError as e:
        msg = str(e)
        if msg == "place_not_found":
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=400, detail=msg)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))

    # Создаём уведомление
    try:
        # Получаем свежесозданный комментарий для передачи в NotificationService
        new_comment = db.query(Comment).filter(Comment.id == comment_data["id"]).one_or_none()
        if new_comment:
            # Определяем parent для уведомления:
            # если resolved_parent_id != req.parent_id, значит был ответ на ответ,
            # и уведомляем автора оригинального комментария, на который ответили
            actual_parent = parent_comment
            NotificationService.create_comment_notification(
                db=db,
                actor=current_user,
                place=place,
                comment=new_comment,
                parent_comment=actual_parent,
            )
    except Exception as e:
        logging.getLogger(__name__).warning("Не удалось создать уведомление: %s", e)

    return {"status": "ok", "comment": comment_data}


@router.get("/places/{place_id}/comments")
def list_comments(
    place_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Получить комментарии к точке.

    Публичные группы — доступны всем (включая гостей).
    Приватные — только участникам.
    """
    try:
        comments = CommentService.list_comments(db, current_user, place_id)
    except ValueError as e:
        msg = str(e)
        if msg == "place_not_found":
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=400, detail=msg)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))

    return {"comments": comments}


@router.patch("/comments/{comment_id}")
def edit_comment(
    comment_id: int,
    req: CommentEditRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Редактировать комментарий (только автор)."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        result = CommentService.edit_comment(db, current_user, comment_id, req.text)
    except ValueError as e:
        msg = str(e)
        if msg == "comment_not_found":
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=400, detail=msg)
    except PermissionError:
        raise HTTPException(status_code=403, detail="no_permission")

    return {"status": "ok", "comment": result}


@router.delete("/comments/{comment_id}")
def delete_comment(
    comment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Удалить комментарий."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        CommentService.delete_comment(db, current_user, comment_id)
    except ValueError as e:
        msg = str(e)
        if msg == "comment_not_found":
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=400, detail=msg)
    except PermissionError:
        raise HTTPException(status_code=403, detail="no_permission")

    return {"status": "ok"}
