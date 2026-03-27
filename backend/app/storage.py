import io
import logging
import os
import re
from urllib.parse import urlparse, urlunparse

import boto3
from botocore.exceptions import ClientError
from fastapi import HTTPException
from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

BUCKET = os.getenv("S3_BUCKET", "memorymap-media")
S3_ENDPOINT = os.getenv("S3_ENDPOINT", "http://minio:9000")
S3_PUBLIC_ENDPOINT = os.getenv("S3_PUBLIC_ENDPOINT")

# Формат temp_key: uploads/{user_id}/{uuid}.{ext}
_UPLOAD_KEY_RE = re.compile(r"^uploads/(\d+)/[0-9a-f\-]{36}\.\w{1,5}$")

# Маппинг расширения → MIME-тип
_EXT_TO_MIME = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}


def validate_temp_key(key: str, user_id: int | None = None) -> None:
    """Проверяет формат temp_key: uploads/{user_id}/{uuid}.{ext}.
    Защита от path traversal, S3 key injection и использования чужих ключей."""
    m = _UPLOAD_KEY_RE.match(key)
    if not m:
        raise HTTPException(status_code=400, detail="invalid_temp_key")
    if user_id is not None and m.group(1) != str(user_id):
        raise HTTPException(status_code=403, detail="temp_key_owner_mismatch")


def detect_mime(key: str) -> str:
    """Определяет MIME-тип по расширению файла в S3-ключе."""
    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return _EXT_TO_MIME.get(ext, "image/jpeg")


_s3_cached = None
_bucket_ensured = False


def s3_client():
    """Возвращает singleton S3-клиент (один на процесс)."""
    global _s3_cached  # noqa: PLW0603
    if _s3_cached is None:
        _s3_cached = boto3.client(
            "s3",
            endpoint_url=S3_ENDPOINT,
            aws_access_key_id=os.getenv("S3_ACCESS_KEY", "minioadmin"),
            aws_secret_access_key=os.getenv("S3_SECRET_KEY", "minioadmin"),
            region_name=os.getenv("S3_REGION", "us-east-1"),
            use_ssl=os.getenv("S3_USE_SSL", "false").lower() == "true",
        )
    return _s3_cached


def ensure_bucket(s3):
    """Проверяет/создаёт bucket. Вызывается один раз за процесс."""
    global _bucket_ensured  # noqa: PLW0603
    if _bucket_ensured:
        return
    try:
        s3.head_bucket(Bucket=BUCKET)
    except ClientError:
        try:
            s3.create_bucket(Bucket=BUCKET)
        except ClientError:
            logger.warning("Не удалось создать bucket %s", BUCKET, exc_info=True)
    _bucket_ensured = True

def _apply_public_endpoint(url: str) -> str:
    """Меняем host в presigned-URL на тот, что доступен браузеру."""
    if not S3_PUBLIC_ENDPOINT:
        return url
    u = urlparse(url)
    pu = urlparse(S3_PUBLIC_ENDPOINT)
    return urlunparse((pu.scheme, pu.netloc, u.path, u.params, u.query, u.fragment))

def presign_put(key: str, content_type: str, expires: int = 600) -> str:
    s3 = s3_client()
    ensure_bucket(s3)
    url = s3.generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": BUCKET, "Key": key, "ContentType": content_type},
        ExpiresIn=expires,
        HttpMethod="PUT",
    )
    return _apply_public_endpoint(url)

def presign_get(key: str, expires: int = 300) -> str:
    s3 = s3_client()
    url = s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={"Bucket": BUCKET, "Key": key},
        ExpiresIn=expires,
        HttpMethod="GET",
    )
    return _apply_public_endpoint(url)

def move_to_place_folder(old_key: str, place_id: int) -> str:
    """
    Перемещает объект в папку places/<place_id>/ и возвращает новый ключ.
    Реализация через copy + delete.
    """
    s3 = s3_client()
    ensure_bucket(s3)

    # только имя файла из старого ключа
    filename = old_key.split("/")[-1]
    new_key = f"places/{place_id}/{filename}"

    copy_source = {"Bucket": BUCKET, "Key": old_key}

    # копируем
    s3.copy_object(Bucket=BUCKET, CopySource=copy_source, Key=new_key)
    # удаляем старый объект
    try:
        s3.delete_object(Bucket=BUCKET, Key=old_key)
    except Exception:
        logger.warning("Не удалось удалить %s после копирования в %s", old_key, new_key)

    return new_key

def delete_place_folder(place_id: int) -> None:
    """
    Удаляет все объекты в S3 с префиксом places/<place_id>/.
    """
    s3 = s3_client()
    ensure_bucket(s3)

    prefix = f"places/{place_id}/"
    paginator = s3.get_paginator("list_objects_v2")

    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        contents = page.get("Contents", [])
        if not contents:
            continue
        objects = [{"Key": obj["Key"]} for obj in contents]
        s3.delete_objects(Bucket=BUCKET, Delete={"Objects": objects})

def delete_user_uploads(user_id: int) -> None:
    """Удаляет все временные загрузки пользователя (uploads/{user_id}/) из S3."""
    s3 = s3_client()
    ensure_bucket(s3)

    prefix = f"uploads/{user_id}/"
    paginator = s3.get_paginator("list_objects_v2")

    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        contents = page.get("Contents", [])
        if not contents:
            continue
        objects = [{"Key": obj["Key"]} for obj in contents]
        s3.delete_objects(Bucket=BUCKET, Delete={"Objects": objects})


def delete_object(key: str) -> None:
    s3 = s3_client()
    ensure_bucket(s3)
    s3.delete_object(Bucket=BUCKET, Key=key)


# Размер миниатюры (макс. сторона)
THUMB_MAX_SIZE = 200


def generate_thumbnail(s3_key: str) -> str | None:
    """Скачивает фото из S3, создаёт миниатюру (200px), загружает обратно.

    Возвращает S3-ключ миниатюры или None при ошибке.
    Миниатюра сохраняется в ту же папку с префиксом t_ на имя файла.
    """
    s3 = s3_client()
    try:
        resp = s3.get_object(Bucket=BUCKET, Key=s3_key)
        data = resp["Body"].read()
    except Exception:
        logger.warning("Не удалось скачать %s для миниатюры", s3_key, exc_info=True)
        return None

    try:
        img = Image.open(io.BytesIO(data))
        # Авто-поворот по EXIF
        img = ImageOps.exif_transpose(img)
        img.thumbnail((THUMB_MAX_SIZE, THUMB_MAX_SIZE), Image.LANCZOS)
        # Конвертируем в RGB для JPEG (RGBA / P не поддерживаются)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=75, optimize=True)
        buf.seek(0)
    except Exception:
        logger.warning("Не удалось создать миниатюру для %s", s3_key, exc_info=True)
        return None

    # Ключ миниатюры: та же папка, префикс t_ на имя файла
    parts = s3_key.rsplit("/", 1)
    if len(parts) == 2:
        thumb_key = f"{parts[0]}/t_{parts[1].rsplit('.', 1)[0]}.jpg"
    else:
        thumb_key = f"t_{s3_key.rsplit('.', 1)[0]}.jpg"

    try:
        s3.put_object(Bucket=BUCKET, Key=thumb_key, Body=buf.getvalue(), ContentType="image/jpeg")
    except Exception:
        logger.warning("Не удалось загрузить миниатюру %s", thumb_key, exc_info=True)
        return None

    return thumb_key
