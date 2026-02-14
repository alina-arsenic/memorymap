"""Утилиты для взаимодействия с Telegram Bot API на стороне бэкенда."""

import json
import logging
from urllib.error import URLError
from urllib.request import Request, urlopen

from app.core.config import TELEGRAM_BOT_TOKEN

log = logging.getLogger(__name__)

# Кэш username бота (запрашивается один раз при первом вызове)
_bot_username: str | None = None


def get_bot_username() -> str | None:
    """Получить username бота через Telegram Bot API (getMe).

    Результат кэшируется на всё время жизни процесса.
    Возвращает None, если токен не задан или запрос не удался.
    """
    global _bot_username

    if _bot_username is not None:
        return _bot_username

    if not TELEGRAM_BOT_TOKEN:
        log.warning("TELEGRAM_BOT_TOKEN не задан — deep link недоступен")
        return None

    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getMe"
        req = Request(url, method="GET")
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())

        if data.get("ok"):
            _bot_username = data["result"]["username"]
            log.info("Telegram bot username: @%s", _bot_username)
            return _bot_username

        log.error("getMe вернул ошибку: %s", data)
    except (URLError, OSError):
        log.exception("Не удалось получить username бота через getMe")

    return None
