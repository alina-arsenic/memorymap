"""Сервис отправки email через SMTP."""

import html
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import SMTP_FROM, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_USER

log = logging.getLogger(__name__)


def _send_email(to: str, subject: str, text_body: str, html_body: str) -> bool:
    """Общая отправка письма через SMTP.

    Возвращает True при успехе, False при ошибке (логирует, не бросает).
    """
    if not SMTP_HOST or not SMTP_USER:
        log.warning("SMTP не настроен — письмо не отправлено (to=%s)", to)
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM or SMTP_USER
    msg["To"] = to

    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.sendmail(msg["From"], [to], msg.as_string())
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.sendmail(msg["From"], [to], msg.as_string())
        log.info("Email sent to %s (subject=%s)", to, subject)
        return True
    except (smtplib.SMTPException, OSError):
        log.exception("Failed to send email to %s (subject=%s)", to, subject)
        return False


def _code_html_block(code: str) -> str:
    """HTML-блок с 6-значным кодом (общий для всех писем)."""
    return (
        f"<p style='font-size:36px;font-weight:bold;letter-spacing:8px;"
        f"text-align:center;margin:16px 0;'>{html.escape(code)}</p>"
    )


def _wrap_html(inner: str) -> str:
    """Обёртка email-письма в общий стиль."""
    return (
        "<div style='font-family:sans-serif;max-width:480px;margin:auto;"
        "padding:24px;border:1px solid #e5e7eb;border-radius:12px;'>"
        "<h2 style='color:#4f46e5;margin-top:0;'>MemoryMap</h2>"
        f"{inner}"
        "<hr style='border:none;border-top:1px solid #e5e7eb;margin:20px 0;'>"
        "<p style='color:#9ca3af;font-size:12px;'>С уважением,<br>"
        "Команда проекта MemoryMap</p>"
        "</div>"
    )


def send_verification_email(to: str, code: str) -> bool:
    """Отправить письмо с 6-значным кодом подтверждения email при регистрации."""
    subject = "Подтверждение электронной почты MemoryMap"
    text_body = (
        "Здравствуйте!\n\n"
        "Для подтверждения адреса электронной почты "
        "Вам необходимо ввести код подтверждения.\n\n"
        f"Ваш код подтверждения:\n\n{code}\n\n"
        "Если это были не вы, просто проигнорируйте это письмо.\n\n"
        "С уважением,\nКоманда проекта MemoryMap"
    )
    html_body = _wrap_html(
        "<p>Здравствуйте!</p>"
        "<p>Для подтверждения адреса электронной почты "
        "Вам необходимо ввести код подтверждения.</p>"
        "<p style='margin:24px 0;font-size:14px;color:#6b7280;'>"
        "Ваш код подтверждения:</p>"
        + _code_html_block(code)
        + "<p style='color:#9ca3af;font-size:13px;margin-top:24px;'>"
        "Если это были не вы, просто проигнорируйте это письмо.</p>"
    )
    return _send_email(to, subject, text_body, html_body)


def send_password_reset_email(to: str, code: str) -> bool:
    """Отправить письмо с кодом сброса пароля."""
    subject = "Сброс пароля MemoryMap"
    text_body = (
        "Здравствуйте!\n\n"
        "Вы запросили сброс пароля.\n\n"
        f"Ваш код сброса:\n\n{code}\n\n"
        "Если это были не вы, просто проигнорируйте это письмо.\n\n"
        "С уважением,\nКоманда проекта MemoryMap"
    )
    html_body = _wrap_html(
        "<p>Здравствуйте!</p>"
        "<p>Вы запросили сброс пароля.</p>"
        "<p style='margin:24px 0;font-size:14px;color:#6b7280;'>"
        "Ваш код сброса:</p>"
        + _code_html_block(code)
        + "<p style='color:#9ca3af;font-size:13px;margin-top:24px;'>"
        "Если это были не вы, просто проигнорируйте это письмо. "
        "Ваш пароль не будет изменён.</p>"
    )
    return _send_email(to, subject, text_body, html_body)


def send_email_change_email(to: str, code: str) -> bool:
    """Отправить письмо с кодом подтверждения смены email."""
    subject = "Смена email MemoryMap"
    text_body = (
        "Здравствуйте!\n\n"
        "Вы запросили смену email на этот адрес.\n\n"
        f"Ваш код подтверждения:\n\n{code}\n\n"
        "Если это были не вы, просто проигнорируйте это письмо.\n\n"
        "С уважением,\nКоманда проекта MemoryMap"
    )
    html_body = _wrap_html(
        "<p>Здравствуйте!</p>"
        "<p>Вы запросили смену email на этот адрес.</p>"
        "<p style='margin:24px 0;font-size:14px;color:#6b7280;'>"
        "Ваш код подтверждения:</p>"
        + _code_html_block(code)
        + "<p style='color:#9ca3af;font-size:13px;margin-top:24px;'>"
        "Если это были не вы, просто проигнорируйте это письмо.</p>"
    )
    return _send_email(to, subject, text_body, html_body)
