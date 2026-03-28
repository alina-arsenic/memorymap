"""Фикстуры для интеграционных тестов: SQLite in-memory, моки S3/SMTP."""

import os
import tempfile
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event, text

# ---------- Фикс: SQLite возвращает naive datetime, а код сравнивает с aware ----------
# SQLite не хранит таймзону — SQLAlchemy возвращает naive datetime.
# Код использует datetime.now(timezone.utc) (aware) → сравнение падает.
# Патчим SQLite-диалект DATETIME чтобы добавлять UTC к naive datetime.
from sqlalchemy.dialects.sqlite import DATETIME as _SQLiteDATETIME
from sqlalchemy.orm import sessionmaker

_orig_sqlite_dt_rp = _SQLiteDATETIME.result_processor


def _tz_aware_sqlite_rp(self, dialect, coltype):
    orig_fn = _orig_sqlite_dt_rp(self, dialect, coltype)
    if orig_fn is None:
        return None

    def process(value):
        result = orig_fn(value)
        if result is not None and isinstance(result, datetime) and result.tzinfo is None:
            result = result.replace(tzinfo=timezone.utc)
        return result

    return process


_SQLiteDATETIME.result_processor = _tz_aware_sqlite_rp

# ---------- Подготовка SQLite-движка ДО импорта приложения ----------
# db.py создаёт engine при импорте, поэтому подменяем DATABASE_URL заранее

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
_SQLITE_URL = f"sqlite:///{_tmp_db.name}"

# Устанавливаем переменные окружения ДО импорта приложения
os.environ["JWT_SECRET"] = "test-secret-key-for-tests"
os.environ["BOT_API_SECRET"] = "test-bot-secret"
os.environ["TELEGRAM_BOT_TOKEN"] = ""
os.environ["SMTP_HOST"] = ""

# Создаём dummy-директорию frontend (main.py монтирует StaticFiles)
_frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if not os.path.isdir(_frontend_dir):
    os.makedirs(_frontend_dir, exist_ok=True)
    with open(os.path.join(_frontend_dir, "index.html"), "w") as f:
        f.write("<html><body>test</body></html>")

# Патчим DATABASE_URL в config до того, как db.py создаст engine
import app.core.config as _cfg  # noqa: E402

_cfg.DATABASE_URL = _SQLITE_URL

# Импортируем db и пересоздаём engine с SQLite
import app.core.db as _db  # noqa: E402

_db.engine = create_engine(_SQLITE_URL, echo=False)
_db.SessionLocal = sessionmaker(bind=_db.engine, autoflush=False, autocommit=False)


@event.listens_for(_db.engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


# ВАЖНО: импортируем модели, чтобы Base.metadata знала о таблицах
import app.models.models  # noqa: E402, F401
from app.core.db import Base  # noqa: E402
from app.core.deps import get_db  # noqa: E402

# ---------- Инициализация тестовой БД ----------

def _init_db():
    """Создаёт все таблицы: ORM + membership (raw SQL) + колонки без ORM-модели."""
    Base.metadata.create_all(bind=_db.engine)
    with _db.engine.connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS membership (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                group_id INTEGER NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
                role TEXT NOT NULL DEFAULT 'viewer',
                PRIMARY KEY (user_id, group_id)
            )
        """))
        # last_active_at — нет в ORM-модели, используется raw SQL в get_current_user
        # Без неё UPDATE падает → rollback на каждом auth-запросе
        try:
            conn.execute(text("ALTER TABLE users ADD COLUMN last_active_at TIMESTAMP"))
        except Exception:
            pass  # уже существует
        conn.commit()


_init_db()

# Собираем имена всех таблиц для очистки
_ALL_TABLES = [t.name for t in reversed(Base.metadata.sorted_tables)] + ["membership"]


# ---------- Фикстуры ----------

@pytest.fixture()
def db_session():
    """Сессия с очисткой данных после каждого теста."""
    session = _db.SessionLocal()
    yield session
    session.close()

    # Очищаем все таблицы после теста
    with _db.engine.connect() as conn:
        conn.execute(text("PRAGMA foreign_keys=OFF"))
        for tname in _ALL_TABLES:
            try:
                conn.execute(text(f'DELETE FROM "{tname}"'))
            except Exception:
                pass
        conn.execute(text("PRAGMA foreign_keys=ON"))
        conn.commit()


@pytest.fixture()
def client(db_session):
    """FastAPI TestClient с подменённой БД и замоканными внешними сервисами."""
    from app.main import app
    from starlette.testclient import TestClient

    # Подменяем get_db на тестовую сессию
    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db

    # Моки S3 — патчим в местах импорта (from app.storage import X → локальная ссылка)
    _move = lambda key, pid: f"places/{pid}/{key.split('/')[-1]}"  # noqa: E731
    s3_patches = [
        # presign_put
        patch("app.api.media.presign_put", return_value="https://s3.test/upload"),
        patch("app.api.bot.presign_put", return_value="https://s3.test/upload"),
        # presign_get
        patch("app.api.media.presign_get", return_value="https://s3.test/download"),
        patch("app.api.moderation.presign_get", return_value="https://s3.test/download"),
        patch("app.api.bot_places.presign_get", return_value="https://s3.test/download"),
        patch("app.services.places.presign_get", return_value="https://s3.test/download"),
        # move_to_place_folder
        patch("app.api.places.move_to_place_folder", side_effect=_move),
        patch("app.api.bot_places.move_to_place_folder", side_effect=_move),
        patch("app.services.places.move_to_place_folder", side_effect=_move),
        # generate_thumbnail
        patch("app.api.places.generate_thumbnail", return_value="places/1/t_thumb.jpg"),
        patch("app.api.bot_places.generate_thumbnail", return_value="places/1/t_thumb.jpg"),
        patch("app.services.places.generate_thumbnail", return_value="places/1/t_thumb.jpg"),
        # delete_object
        patch("app.api.media.delete_object", return_value=None),
        patch("app.api.bot_places.delete_object", return_value=None),
        # delete_place_folder
        patch("app.api.groups.delete_place_folder", return_value=None),
        patch("app.api.me.delete_place_folder", return_value=None),
        patch("app.services.places.delete_place_folder", return_value=None),
        # delete_user_uploads
        patch("app.api.me.delete_user_uploads", return_value=None),
    ]

    # Мок SMTP — патчим в местах импорта
    smtp_patches = [
        patch("app.api.auth.send_verification_email", return_value=True),
        patch("app.api.auth.send_password_reset_email", return_value=True),
        patch("app.api.me.send_email_change_email", return_value=True),
    ]

    # Мок Telegram — патчим в месте импорта
    telegram_patches = [
        patch("app.api.me.get_bot_username", return_value="test_bot"),
    ]

    all_patches = s3_patches + smtp_patches + telegram_patches
    for p in all_patches:
        p.start()

    with TestClient(app) as c:
        yield c

    for p in all_patches:
        p.stop()

    app.dependency_overrides.clear()


# ---------- Хелперы ----------

def create_user(client, login, email, password="TestPass123"):
    """Регистрация + верификация email + логин → возвращает (token, user_id)."""
    # Регистрация
    r = client.post("/v1/auth/register", json={
        "login": login,
        "email": email,
        "password": password,
    })
    assert r.status_code == 200, f"Register failed: {r.text}"
    user_id = r.json()["id"]

    # Верификация — получаем код напрямую из БД
    from app.models.models import EmailVerificationCode
    db = next(client.app.dependency_overrides[get_db]())
    code_row = (
        db.query(EmailVerificationCode)
        .filter(EmailVerificationCode.user_id == user_id)
        .order_by(EmailVerificationCode.id.desc())
        .first()
    )
    assert code_row is not None, "Verification code not found"

    r = client.post("/v1/auth/verify-email", json={
        "email": email,
        "code": code_row.code,
    })
    assert r.status_code == 200, f"Verify failed: {r.text}"

    # Логин
    r = client.post("/v1/auth/login", json={
        "login": login,
        "password": password,
    })
    assert r.status_code == 200, f"Login failed: {r.text}"
    token = r.json()["access_token"]

    return token, user_id


def auth_headers(token):
    """Формирует заголовок авторизации."""
    return {"Authorization": f"Bearer {token}"}
