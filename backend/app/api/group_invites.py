from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import User
from app.services.group_invites import GroupInviteService
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter()


class GroupInviteCreate(BaseModel):
    user_id: int
    role: str = "viewer"  # editor | viewer


@router.post("/groups/{group_id}/invites")
def send_invite(
    group_id: int,
    req: GroupInviteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Отправить инвайт в группу (слой). Только owner, только друзьям."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return GroupInviteService.send_invite(db, current_user, group_id, req.user_id, req.role)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/groups/invites")
def list_invites(
    inbox: int = Query(0, ge=0, le=1),
    outbox: int = Query(0, ge=0, le=1),
    status: str | None = Query(None),
    limit: int = Query(100, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Список инвайтов (входящие/исходящие)."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {
        "items": GroupInviteService.list_invites(
            db, current_user,
            inbox=bool(inbox),
            outbox=bool(outbox),
            status=status,
            limit=limit,
        )
    }


@router.post("/groups/invites/{invite_id}/accept")
def accept_invite(
    invite_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Принять инвайт в группу."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return GroupInviteService.accept_invite(db, current_user, invite_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/groups/invites/{invite_id}/decline")
def decline_invite(
    invite_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Отклонить инвайт в группу."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return GroupInviteService.decline_invite(db, current_user, invite_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/groups/invites/{invite_id}")
def cancel_invite(
    invite_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Отмена инвайта владельцем группы."""
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return GroupInviteService.cancel_invite(db, current_user, invite_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
