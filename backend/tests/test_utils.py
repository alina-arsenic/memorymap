"""Unit-тесты утилит: validate_temp_key, detect_mime, JWT."""


import pytest
from app.core.jwt import create_access_token, decode_access_token
from app.storage import detect_mime, validate_temp_key
from fastapi import HTTPException

# ---------- validate_temp_key ----------

def test_validate_temp_key_valid():
    """Корректный ключ проходит валидацию."""
    validate_temp_key("uploads/42/550e8400-e29b-41d4-a716-446655440000.jpg", user_id=42)


def test_validate_temp_key_path_traversal():
    """Path traversal блокируется."""
    with pytest.raises(HTTPException) as exc_info:
        validate_temp_key("uploads/42/../../../etc/passwd", user_id=42)
    assert exc_info.value.status_code == 400


def test_validate_temp_key_wrong_user():
    """Чужой user_id в ключе → 403."""
    with pytest.raises(HTTPException) as exc_info:
        validate_temp_key("uploads/99/550e8400-e29b-41d4-a716-446655440000.jpg", user_id=42)
    assert exc_info.value.status_code == 403


def test_validate_temp_key_invalid_format():
    """Невалидный формат ключа."""
    with pytest.raises(HTTPException) as exc_info:
        validate_temp_key("invalid/key/format")
    assert exc_info.value.status_code == 400


def test_validate_temp_key_no_user_check():
    """Без user_id — проверяет только формат."""
    validate_temp_key("uploads/1/550e8400-e29b-41d4-a716-446655440000.png")


# ---------- detect_mime ----------

def test_detect_mime_jpg():
    assert detect_mime("photo.jpg") == "image/jpeg"


def test_detect_mime_jpeg():
    assert detect_mime("photo.jpeg") == "image/jpeg"


def test_detect_mime_png():
    assert detect_mime("photo.png") == "image/png"


def test_detect_mime_webp():
    assert detect_mime("photo.webp") == "image/webp"


def test_detect_mime_gif():
    assert detect_mime("photo.gif") == "image/gif"


def test_detect_mime_unknown():
    """Неизвестное расширение → fallback image/jpeg."""
    assert detect_mime("file.bmp") == "image/jpeg"


def test_detect_mime_no_extension():
    """Без расширения → fallback image/jpeg."""
    assert detect_mime("noext") == "image/jpeg"


# ---------- JWT ----------

def test_create_and_decode_token():
    token = create_access_token(user_id=42)
    payload = decode_access_token(token)
    assert payload["sub"] == "42"
    assert payload["type"] == "access"
    assert "exp" in payload
    assert "iat" in payload


def test_decode_invalid_token():
    """Невалидный токен → исключение."""
    with pytest.raises(Exception):
        decode_access_token("invalid.token.here")
