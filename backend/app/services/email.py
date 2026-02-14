"""Сервис отправки email через SMTP (подтверждение регистрации)."""

import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import SMTP_FROM, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_USER

log = logging.getLogger(__name__)


def send_verification_email(to: str, code: str) -> bool:
    """Отправить письмо с 6-значным кодом подтверждения.

    Возвращает True при успехе, False при ошибке (логирует, не бросает).
    """
    if not SMTP_HOST or not SMTP_USER:
        log.warning("SMTP не настроен — письмо не отправлено (to=%s)", to)
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Подтверждение электронной почты MemoryMap"
    msg["From"] = SMTP_FROM or SMTP_USER
    msg["To"] = to

    text_body = (
        "Здравствуйте!\n\n"
        "Для подтверждения адреса электронной почты "
        "Вам необходимо ввести код подтверждения.\n\n"
        f"Ваш код подтверждения:\n\n{code}\n\n"
        "Если это были не вы, просто проигнорируйте это письмо.\n\n"
        "С уважением,\nКоманда проекта MemoryMap"
    )
    html_body = (
        "<div style='font-family:sans-serif;max-width:480px;margin:auto;"
        "padding:24px;border:1px solid #e5e7eb;border-radius:12px;'>"
        "<h2 style='color:#4f46e5;margin-top:0;'>MemoryMap</h2>"
        "<p>Здравствуйте!</p>"
        "<p>Для подтверждения адреса электронной почты "
        "Вам необходимо ввести код подтверждения.</p>"
        "<p style='margin:24px 0;font-size:14px;color:#6b7280;'>"
        "Ваш код подтверждения:</p>"
        f"<p style='font-size:36px;font-weight:bold;letter-spacing:8px;"
        f"text-align:center;margin:16px 0;'>{code}</p>"
        "<p style='color:#9ca3af;font-size:13px;margin-top:24px;'>"
        "Если это были не вы, просто проигнорируйте это письмо.</p>"
        "<hr style='border:none;border-top:1px solid #e5e7eb;margin:20px 0;'>"
        "<p style='color:#9ca3af;font-size:12px;'>С уважением,<br>"
        "Команда проекта MemoryMap</p>"
        "</div>"
    )

    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(msg["From"], [to], msg.as_string())
        log.info("Verification email sent to %s", to)
        return True
    except Exception:
        log.exception("Failed to send verification email to %s", to)
        return False
