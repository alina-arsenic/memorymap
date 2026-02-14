from app.core.auth import get_current_user
from app.core.deps import get_db
from app.models.models import User
from app.services.users import UserService
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

router = APIRouter()

@router.get("/users/search")
def search_users(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"items": UserService.search_users(db, q=q, limit=limit)}
