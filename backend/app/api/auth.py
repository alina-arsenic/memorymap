from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.core.security import hash_password
from app.models.models import User
from app.core.security import verify_password
from app.core.jwt import create_access_token

router = APIRouter()

class RegisterReq(BaseModel):
    login: str
    password: str

@router.post("/auth/register")
def register(req: RegisterReq, db: Session = Depends(get_db)):
    # нормализуем логин
    login = (req.login or "").strip()
    if not login:
        raise HTTPException(status_code=400, detail="empty_login")

    # проверяем пароль
    password = req.password or ""
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="password_too_short")

    # проверка уникальности логина
    exists = db.query(User).filter(User.login == login).first()
    if exists:
        raise HTTPException(status_code=409, detail="login_taken")

    # создаем пользователя
    user = User(
        login=login,
        password_hash=hash_password(password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return {"id": user.id}

class LoginReq(BaseModel):
    login: str
    password: str

@router.post("/auth/login")
def login(req: LoginReq, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.login == req.login).one_or_none()
    if not user or not user.password_hash:
        raise HTTPException(status_code=401, detail="bad_credentials")

    if not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="bad_credentials")

    token = create_access_token(user.id)
    return {"access_token": token, "token_type": "bearer", "expires_minutes": 30}
