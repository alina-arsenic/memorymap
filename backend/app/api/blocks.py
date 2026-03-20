from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import User
from app.services.blocks import BlockService
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter(tags=["blocks"])


class BlockRequest(BaseModel):
    user_id: int


@router.post("/blocks")
def block_user(
    req: BlockRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Заблокировать пользователя."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return BlockService.block_user(db, current_user, req.user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/blocks/{user_id}")
def unblock_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Разблокировать пользователя."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return BlockService.unblock_user(db, current_user, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/blocks")
def list_blocked(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Список заблокированных пользователей."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"items": BlockService.list_blocked(db, current_user)}
