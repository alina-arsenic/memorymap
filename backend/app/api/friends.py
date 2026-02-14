from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import User
from app.services.friends import FriendsService
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

router = APIRouter()

class CreateFriendRequest(BaseModel):
    to_user_id: int

@router.get("/friends")
def list_friends(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"items": FriendsService.list_friends(db, current_user)}


@router.delete("/friends/{other_user_id}")
def delete_friend(
    other_user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return FriendsService.remove_friendship(db, current_user, other_user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/friends/requests")
def create_request(
    req: CreateFriendRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return FriendsService.send_request(db, current_user, req.to_user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/friends/requests")
def list_requests(
    inbox: int = Query(0, ge=0, le=1),
    outbox: int = Query(0, ge=0, le=1),
    status: str | None = Query(None),
    limit: int = Query(100, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {
        "items": FriendsService.list_requests(
            db,
            current_user,
            inbox=bool(inbox),
            outbox=bool(outbox),
            status=status,
            limit=limit,
        )
    }

@router.post("/friends/requests/{request_id}/accept")
def accept_request(
    request_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return FriendsService.accept_request(db, current_user, request_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("/friends/requests/{request_id}/decline")
def decline_request(
    request_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return FriendsService.decline_request(db, current_user, request_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
