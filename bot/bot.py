import asyncio
import logging
import os
from urllib.parse import urlparse, urlunparse

import requests
from aiogram import Bot, Dispatcher, F, types
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import CommandObject, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    BufferedInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaPhoto,
    KeyboardButton,
    ReplyKeyboardMarkup,
)

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
API_BASE = os.getenv("APP_BASE_URL", "http://api:8000")
BOT_API_SECRET = os.getenv("BOT_API_SECRET", "")
# Внутренний адрес MinIO (из docker network)
MINIO_INTERNAL_HOST = os.getenv("MINIO_INTERNAL_HOST", "minio:9000")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

session = AiohttpSession()

bot = Bot(token=BOT_TOKEN, session=session)

dp = Dispatcher(storage=MemoryStorage())

# ---------- Постоянная клавиатура ----------
MAIN_KB = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="Новое место"), KeyboardButton(text="Последние места")],
        [KeyboardButton(text="Ещё")],
    ],
    resize_keyboard=True,
)


# ---------- Хелпер: безопасный HTTP-запрос ----------

def api_request(method, url, **kwargs):
    """Обёртка над requests с try/except и timeout по умолчанию."""
    kwargs.setdefault("timeout", 10)
    kwargs.setdefault("headers", {})
    kwargs["headers"].setdefault("X-Bot-Secret", BOT_API_SECRET)
    try:
        return getattr(requests, method)(url, **kwargs)
    except requests.RequestException as e:
        logger.error("HTTP %s %s failed: %s", method.upper(), url, e)
        return None


# ---------- FSM ----------
class AddPoint(StatesGroup):
    waiting_group = State()
    waiting_title = State()
    waiting_note = State()
    waiting_photo = State()
    # Новые состояния для /mypoints
    selecting_point = State()
    waiting_new_group = State()
    waiting_new_location = State()
    waiting_delete_photo = State()
    confirming_delete_point = State()
    waiting_new_layer_name = State()


# ---------- Keyboards ----------

def make_edit_menu(include_manage=False):
    """Меню редактирования точки. include_manage=True — расширенное (для /mypoints)."""
    rows = [
        [InlineKeyboardButton(text="Изменить название", callback_data="add_title")],
        [InlineKeyboardButton(text="Изменить описание", callback_data="add_note")],
        [InlineKeyboardButton(text="Добавить фото", callback_data="add_photo")],
    ]
    if include_manage:
        rows.extend([
            [InlineKeyboardButton(text="Изменить слой", callback_data="change_group")],
            [InlineKeyboardButton(text="Изменить локацию", callback_data="change_location")],
            [InlineKeyboardButton(text="Удалить фото", callback_data="delete_photo")],
            [InlineKeyboardButton(text="Удалить точку", callback_data="delete_point")],
        ])
    rows.append([InlineKeyboardButton(text="Готово", callback_data="finish_point")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def back_menu():
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="Назад", callback_data="back")]]
    )


async def show_menu(chat_id: int, state: FSMContext, text: str):
    """Показываем меню, при этом старое меню (если было) удаляем."""
    data = await state.get_data()
    old_id = data.get("menu_message_id")
    if old_id:
        try:
            await bot.delete_message(chat_id=chat_id, message_id=old_id)
        except Exception:
            pass

    # Определяем расширенное меню по флагу manage_mode
    include_manage = data.get("manage_mode", False)

    msg = await bot.send_message(
        chat_id,
        text,
        reply_markup=make_edit_menu(include_manage=include_manage),
    )

    await state.update_data(menu_message_id=msg.message_id)
    # выходим в нейтральное состояние
    await state.set_state(None)


# ---------- Commands ----------

@dp.message(CommandStart())
async def cmd_start(m: types.Message, command: CommandObject, state: FSMContext):
    """Обработчик /start. Если передан deep_link код — привязываем Telegram."""
    # Очищаем stale-состояние при /start без deep link
    await state.clear()

    code = command.args  # текст после /start (None если просто /start)

    if not code:
        await m.answer(
            "Привет! Я бот MemoryMap.\n\n"
            "Отправьте геолокацию, чтобы сохранить место на карте.\n"
            "Для подключения Telegram к аккаунту используйте ссылку с сайта.",
            reply_markup=MAIN_KB,
        )
        return

    # deep link: /start <code> — подключение Telegram к аккаунту
    if not BOT_API_SECRET:
        await m.reply("Бот не настроен: нет BOT_API_SECRET.")
        return

    r = api_request(
        "post",
        f"{API_BASE}/v1/bot/link-telegram",
        json={"code": code, "tg_id": m.from_user.id},
    )

    if r is None:
        await m.reply("Ошибка связи с сервером. Попробуйте позже.")
        return

    if r.ok:
        await m.reply(
            "Готово! Telegram подключён к вашему профилю.\n"
            "Теперь вы можете отправлять геолокацию для создания точек."
        )
    elif r.status_code == 400:
        await m.reply("Код истёк. Сгенерируйте новый на сайте.")
    elif r.status_code == 404:
        await m.reply("Код не найден. Попробуйте сгенерировать новый на сайте.")
    elif r.status_code == 409:
        await m.reply("Код уже использован или этот Telegram уже подключён к другому аккаунту.")
    else:
        await m.reply(f"Ошибка подключения (код {r.status_code}).")


@dp.message(F.text == "/whoami")
async def whoami(m: types.Message):
    lines = [f"Ваш Telegram ID: {m.from_user.id}"]
    if m.from_user.username:
        lines.append(f"username: @{m.from_user.username}")
    await m.reply("\n".join(lines))


# ---------- Кнопка "Новое место" ----------

@dp.message(F.text == "Новое место")
async def btn_new_place(m: types.Message, state: FSMContext):
    await state.clear()
    await m.answer("Отправьте геолокацию для создания нового места.")


# ---------- Кнопка "Меню" ----------

@dp.message(F.text == "Ещё")
async def btn_menu(m: types.Message, state: FSMContext):
    await state.clear()
    await m.answer(
        "Выберите действие:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="Создать слой", callback_data="menu_new_layer")],
            [InlineKeyboardButton(text="Отключить Telegram", callback_data="menu_unlink_tg")],
        ]),
    )


@dp.callback_query(F.data == "menu_new_layer")
async def cb_menu_new_layer(c: types.CallbackQuery, state: FSMContext):
    await state.clear()
    await state.set_state(AddPoint.waiting_new_layer_name)
    await c.message.edit_text("Введите название нового слоя:")
    await c.answer()


@dp.callback_query(F.data == "menu_unlink_tg")
async def cb_menu_unlink_tg(c: types.CallbackQuery, state: FSMContext):
    """Подтверждение отвязки Telegram."""
    await c.message.edit_text(
        "Отключить Telegram от аккаунта MemoryMap?\n"
        "Вы больше не сможете добавлять точки через бота.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text="Да, отключить", callback_data="confirm_unlink_tg"),
                InlineKeyboardButton(text="Отмена", callback_data="cancel_unlink_tg"),
            ],
        ]),
    )
    await c.answer()


@dp.callback_query(F.data == "confirm_unlink_tg")
async def cb_confirm_unlink_tg(c: types.CallbackQuery, state: FSMContext):
    r = api_request(
        "delete",
        f"{API_BASE}/v1/bot/unlink-telegram",
        params={"tg_id": c.from_user.id},
    )

    if r is None:
        await c.answer("Ошибка связи с сервером.", show_alert=True)
        return

    if not r.ok:
        detail = ""
        try:
            detail = r.json().get("detail", "")
        except Exception:
            pass
        if detail == "set_password_first":
            await c.answer(
                "Сначала установите пароль на сайте, иначе не сможете войти в аккаунт.",
                show_alert=True,
            )
        elif detail == "telegram_not_linked":
            await c.answer("Telegram уже отключён.", show_alert=True)
        else:
            await c.answer(f"Ошибка ({detail or r.status_code}).", show_alert=True)
        return

    await c.message.edit_text(
        "Telegram отключён от аккаунта.\n"
        "Подключить снова можно на сайте MemoryMap."
    )
    await state.clear()
    await c.answer()


@dp.callback_query(F.data == "cancel_unlink_tg")
async def cb_cancel_unlink_tg(c: types.CallbackQuery):
    try:
        await c.message.delete()
    except Exception:
        pass
    await c.answer()


# ---------- /mypoints / "Последние места" — последние 5 точек ----------

@dp.message(F.text.in_({"/mypoints", "Последние места"}))
async def cmd_mypoints(m: types.Message, state: FSMContext):
    await state.clear()

    r = api_request(
        "get",
        f"{API_BASE}/v1/bot/places",
        params={"tg_id": m.from_user.id},
    )

    if r is None:
        await m.reply("Ошибка связи с сервером. Попробуйте позже.")
        return

    if r.status_code == 400:
        await m.reply("Ваш Telegram не подключён к аккаунту. Используйте /link <code>.")
        return
    if not r.ok:
        await m.reply(f"Ошибка получения точек (код {r.status_code}).")
        return

    items = r.json().get("items", [])
    if not items:
        await m.reply("У вас пока нет точек. Отправьте геолокацию, чтобы создать первую.")
        return

    # Сохраняем данные точек в FSM для быстрого доступа
    points_data = {}
    buttons = []
    for p in items:
        pid = p["id"]
        title = (p.get("title") or f"{p['lat']:.5f}, {p['lon']:.5f}")
        # Обрезаем до 40 символов для кнопки
        label = title[:40] + ("..." if len(title) > 40 else "")
        photo_count = p.get("photo_count", 0)
        label += f" ({photo_count} фото)" if photo_count else ""
        buttons.append([InlineKeyboardButton(
            text=label,
            callback_data=f"edit_point:{pid}",
        )])
        points_data[str(pid)] = {
            "lat": p["lat"],
            "lon": p["lon"],
            "title": title,
            "note": p.get("note") or "",
        }

    buttons.append([InlineKeyboardButton(text="Назад", callback_data="cancel_mypoints")])

    await state.update_data(
        points_data=points_data,
        tg_id=m.from_user.id,
        username=m.from_user.username,
    )
    await state.set_state(AddPoint.selecting_point)

    await m.reply(
        "Последние места. Выберите для редактирования:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
    )


# ---------- /newlayer — создание слоя ----------

@dp.message(F.text.startswith("/newlayer"))
async def cmd_newlayer(m: types.Message, state: FSMContext):
    parts = (m.text or "").strip().split(maxsplit=1)
    if len(parts) < 2 or not parts[1].strip():
        await m.reply(
            "Использование: /newlayer <название>\n"
            "Например: /newlayer Мои путешествия"
        )
        return

    name = parts[1].strip()
    if len(name) > 100:
        await m.reply("Название слоя слишком длинное (макс. 100 символов).")
        return

    r = api_request(
        "post",
        f"{API_BASE}/v1/bot/groups",
        json={"tg_id": m.from_user.id, "name": name, "visibility": "private"},
    )

    if r is None:
        await m.reply("Ошибка связи с сервером. Попробуйте позже.")
        return

    if r.status_code == 400:
        detail = ""
        try:
            detail = r.json().get("detail", "")
        except Exception:
            pass
        if detail == "telegram_not_linked":
            await m.reply("Ваш Telegram не подключён к аккаунту. Используйте /link <code>.")
        else:
            await m.reply(f"Ошибка: {detail or r.status_code}")
        return

    if not r.ok:
        await m.reply(f"Не удалось создать слой (код {r.status_code}).")
        return

    data = r.json()
    await m.reply(f"Слой «{data.get('name', name)}» создан.")


@dp.message(F.text.startswith("/link"))
async def link_account(m: types.Message):
    parts = (m.text or "").strip().split(maxsplit=1)
    if len(parts) != 2:
        await m.reply("Использование: /link <code> (код берётся на сайте).")
        return

    code = parts[1].strip()
    if not BOT_API_SECRET:
        await m.reply("Бот не настроен: нет BOT_API_SECRET.")
        return

    r = api_request(
        "post",
        f"{API_BASE}/v1/bot/link-telegram",
        json={"code": code, "tg_id": m.from_user.id},
    )

    if r is None:
        await m.reply("Ошибка связи с сервером. Попробуйте позже.")
        return

    if r.ok:
        await m.reply("Готово. Telegram подключён к вашему профилю.")
    else:
        if r.status_code == 400:
            await m.reply("Код истёк. Сгенерируйте новый на сайте.")
        elif r.status_code == 404:
            await m.reply("Код не найден. Проверьте, что скопировали правильно.")
        elif r.status_code == 409:
            await m.reply("Код уже использован или этот Telegram уже подключён к другому аккаунту.")
        else:
            await m.reply(f"Ошибка подключения (код {r.status_code}).")


# ---------- Callback: закрытие списка /mypoints ----------

@dp.callback_query(F.data == "cancel_mypoints")
async def cb_cancel_mypoints(c: types.CallbackQuery, state: FSMContext):
    await state.clear()
    try:
        await c.message.delete()
    except Exception:
        pass
    await c.answer()


# ---------- Callback: выбор точки из /mypoints ----------

@dp.callback_query(AddPoint.selecting_point, F.data.startswith("edit_point:"))
async def cb_edit_point(c: types.CallbackQuery, state: FSMContext):
    try:
        pid = int(c.data.split(":")[1])
    except (ValueError, IndexError):
        await c.answer("Ошибка выбора точки.")
        return

    data = await state.get_data()
    points_data = data.get("points_data", {})
    point_info = points_data.get(str(pid), {})

    await state.update_data(
        point_id=pid,
        manage_mode=True,
        point_lat=point_info.get("lat"),
        point_lon=point_info.get("lon"),
    )

    # Удаляем сообщение со списком точек
    try:
        await c.message.delete()
    except Exception:
        pass

    title = point_info.get("title", f"id {pid}")
    await show_menu(
        chat_id=c.message.chat.id,
        state=state,
        text=f"Точка «{title}». Выберите действие:",
    )
    await c.answer()


# ---------- FSM: смена локации (ПЕРЕД on_location!) ----------

@dp.message(AddPoint.waiting_new_location, F.location)
async def set_new_location(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data.get("point_id")
    if not pid:
        await m.reply("Ошибка состояния. Используйте /mypoints.")
        await state.clear()
        return

    r = api_request(
        "patch",
        f"{API_BASE}/v1/bot/places/{pid}",
        json={
            "lat": m.location.latitude,
            "lon": m.location.longitude,
            "tg_id": m.from_user.id,
        },
    )

    if r is None:
        await m.reply("Ошибка связи с сервером.")
        return
    if not r.ok:
        await m.reply(f"Не удалось обновить локацию (код {r.status_code}).")
        return

    # Обновляем сохранённые координаты
    await state.update_data(
        point_lat=m.location.latitude,
        point_lon=m.location.longitude,
    )

    await show_menu(
        chat_id=m.chat.id,
        state=state,
        text="Локация обновлена. Что дальше?",
    )


@dp.message(AddPoint.waiting_new_location)
async def wrong_new_location(m: types.Message, state: FSMContext):
    await m.reply("Отправьте геолокацию или нажмите «Назад».")


# ---------- Location handler: запрос выбора группы ----------

@dp.message(F.location)
async def on_location(m: types.Message, state: FSMContext):
    # Если юзер редактирует точку (есть point_id или активное FSM-состояние) — не перехватываем
    data = await state.get_data()
    current_state = await state.get_state()
    if current_state is not None or data.get("point_id"):
        await m.reply(
            "Вы сейчас в режиме редактирования. "
            "Нажмите «Готово», чтобы выйти, затем отправьте геолокацию."
        )
        return

    lat = m.location.latitude
    lon = m.location.longitude

    # Запрашиваем список доступных групп через backend
    r = api_request(
        "get",
        f"{API_BASE}/v1/bot/groups",
        params={"tg_id": m.from_user.id},
    )

    if r is None:
        await m.reply("Ошибка связи с сервером. Попробуйте позже.")
        return

    if r.status_code == 400:
        try:
            detail = r.json().get("detail")
        except Exception:
            detail = None
        if detail == "telegram_not_linked":
            await m.reply(
                "Ваш Telegram не подключён к аккаунту.\n"
                "Зайдите на сайт, войдите в аккаунт, "
                "сгенерируйте код подключения и отправьте мне:\n\n"
                "/link <code>"
            )
            return

    if not r.ok:
        await m.reply(f"Не удалось получить список групп (код {r.status_code})")
        return

    groups = r.json().get("items", [])
    if not groups:
        await m.reply("Нет доступных групп для добавления точки.")
        return

    # Сохраняем координаты и username в FSM
    await state.clear()
    await state.update_data(
        lat=lat,
        lon=lon,
        username=m.from_user.username,
        tg_id=m.from_user.id,
    )

    # Формируем inline-кнопки выбора группы
    buttons = []
    for g in groups:
        label = g["name"]
        buttons.append([InlineKeyboardButton(
            text=label,
            callback_data=f"select_group:{g['id']}",
        )])
    # Кнопка создания нового слоя
    buttons.append([InlineKeyboardButton(
        text="+ Создать слой",
        callback_data="create_layer_inline",
    )])

    await m.reply(
        "Куда добавить точку?",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
    )
    await state.set_state(AddPoint.waiting_group)


# ---------- Callback: создание слоя inline (при on_location) ----------

@dp.callback_query(AddPoint.waiting_group, F.data == "create_layer_inline")
async def cb_create_layer_inline(c: types.CallbackQuery, state: FSMContext):
    await c.message.edit_text(
        "Введите название нового слоя:",
        reply_markup=back_menu(),
    )
    await state.set_state(AddPoint.waiting_new_layer_name)
    await c.answer()


@dp.message(AddPoint.waiting_new_layer_name, F.text)
async def set_new_layer_name(m: types.Message, state: FSMContext):
    name = (m.text or "").strip()
    if not name or len(name) > 100:
        await m.reply("Название должно быть от 1 до 100 символов.")
        return

    data = await state.get_data()

    r = api_request(
        "post",
        f"{API_BASE}/v1/bot/groups",
        json={"tg_id": data.get("tg_id", m.from_user.id), "name": name, "visibility": "private"},
    )

    if r is None:
        await m.reply("Ошибка связи с сервером.")
        return
    if not r.ok:
        await m.reply(f"Не удалось создать слой (код {r.status_code}).")
        return

    new_group = r.json()
    group_id = new_group["id"]

    # Если нет lat/lon — слой создан из главного меню (без точки)
    if data.get("lat") is None:
        await m.reply(f"Слой «{name}» создан.")
        await state.clear()
        return

    # Сразу создаём точку в новом слое
    payload = {
        "group_id": group_id,
        "tg_id": data.get("tg_id", m.from_user.id),
        "username": data.get("username"),
        "title": None,
        "note": "",
        "lat": data["lat"],
        "lon": data["lon"],
        "media_keys": [],
    }

    r2 = api_request("post", f"{API_BASE}/v1/places/bot", json=payload)

    if r2 is None or not r2.ok:
        code = r2.status_code if r2 else "нет ответа"
        await m.reply(f"Слой создан, но не удалось создать точку (код {code}).")
        await state.clear()
        return

    pid = r2.json().get("id")
    await state.update_data(point_id=pid, manage_mode=False)

    await show_menu(
        chat_id=m.chat.id,
        state=state,
        text=f"Слой «{name}» создан. Точка создана (id {pid}). Что дальше?",
    )


@dp.message(AddPoint.waiting_new_layer_name)
async def wrong_new_layer_name(m: types.Message, state: FSMContext):
    await m.reply("Введите текстовое название для слоя.")


# ---------- Callback: выбор группы → создание точки ----------

@dp.callback_query(AddPoint.waiting_group, F.data.startswith("select_group:"))
async def cb_select_group(c: types.CallbackQuery, state: FSMContext):
    try:
        group_id = int(c.data.split(":")[1])
    except (ValueError, IndexError):
        await c.answer("Ошибка выбора группы.")
        return

    data = await state.get_data()

    payload = {
        "group_id": group_id,
        "tg_id": data["tg_id"],
        "username": data.get("username"),
        "title": None,
        "note": "",
        "lat": data["lat"],
        "lon": data["lon"],
        "media_keys": [],
    }

    r = api_request("post", f"{API_BASE}/v1/places/bot", json=payload)

    if r is None:
        await c.message.edit_text("Ошибка связи с сервером.")
        await state.clear()
        await c.answer()
        return

    if not r.ok:
        await c.message.edit_text(f"Не удалось создать точку (код {r.status_code})")
        await state.clear()
        await c.answer()
        return

    pid = r.json().get("id")

    # Новые точки — без расширенного меню
    await state.update_data(point_id=pid, manage_mode=False)

    # Удаляем сообщение с выбором группы и показываем меню
    try:
        await c.message.delete()
    except Exception:
        pass

    await show_menu(
        chat_id=c.message.chat.id,
        state=state,
        text=f"Точка создана (id {pid}). Выберите, что хотите сделать:",
    )
    await c.answer()


# ---------- Callback: menu actions ----------

@dp.callback_query(F.data == "add_title")
async def cb_add_title(c: types.CallbackQuery, state: FSMContext):
    data = await state.get_data()
    current_title = ""
    pid = data.get("point_id")
    if pid and data.get("manage_mode"):
        pd = data.get("points_data", {}).get(str(pid), {})
        current_title = pd.get("title", "")

    if current_title:
        text = f"Текущее название: {current_title}\n\nВведите новое название:"
    else:
        text = "Введите название:"

    await c.message.edit_text(text, reply_markup=back_menu())
    await state.set_state(AddPoint.waiting_title)
    await c.answer()


@dp.callback_query(F.data == "add_note")
async def cb_add_note(c: types.CallbackQuery, state: FSMContext):
    data = await state.get_data()
    # Показываем текущее описание, если есть
    current_note = ""
    pid = data.get("point_id")
    if pid and data.get("manage_mode"):
        pd = data.get("points_data", {}).get(str(pid), {})
        current_note = pd.get("note", "")

    if current_note:
        text = f"Текущее описание:\n\n{current_note}\n\nВведите новое описание:"
    else:
        text = "Введите описание:"

    await c.message.edit_text(text, reply_markup=back_menu())
    await state.set_state(AddPoint.waiting_note)
    await c.answer()


@dp.callback_query(F.data == "add_photo")
async def cb_add_photo(c: types.CallbackQuery, state: FSMContext):
    await c.message.edit_text("Отправьте фото:", reply_markup=back_menu())
    await state.set_state(AddPoint.waiting_photo)
    await c.answer()


@dp.callback_query(F.data == "change_group")
async def cb_change_group(c: types.CallbackQuery, state: FSMContext):
    """Смена слоя: показать список доступных групп."""
    data = await state.get_data()
    tg_id = data.get("tg_id", c.from_user.id)

    r = api_request(
        "get",
        f"{API_BASE}/v1/bot/groups",
        params={"tg_id": tg_id},
    )

    if r is None:
        await c.answer("Ошибка связи с сервером.", show_alert=True)
        return
    if not r.ok:
        await c.answer(f"Ошибка (код {r.status_code}).", show_alert=True)
        return

    groups = r.json().get("items", [])
    if not groups:
        await c.answer("Нет доступных слоёв.", show_alert=True)
        return

    buttons = []
    for g in groups:
        buttons.append([InlineKeyboardButton(
            text=g["name"],
            callback_data=f"set_group:{g['id']}",
        )])
    buttons.append([InlineKeyboardButton(text="Назад", callback_data="back")])

    await c.message.edit_text(
        "Выберите новый слой:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
    )
    await state.set_state(AddPoint.waiting_new_group)
    await c.answer()


@dp.callback_query(AddPoint.waiting_new_group, F.data.startswith("set_group:"))
async def cb_set_group(c: types.CallbackQuery, state: FSMContext):
    """Применить смену слоя."""
    try:
        new_group_id = int(c.data.split(":")[1])
    except (ValueError, IndexError):
        await c.answer("Ошибка.")
        return

    data = await state.get_data()
    pid = data.get("point_id")
    if not pid:
        await c.answer("Ошибка состояния.")
        return

    r = api_request(
        "patch",
        f"{API_BASE}/v1/bot/places/{pid}",
        json={"group_id": new_group_id, "tg_id": c.from_user.id},
    )

    if r is None:
        await c.answer("Ошибка связи с сервером.", show_alert=True)
        return
    if not r.ok:
        await c.answer(f"Не удалось сменить слой (код {r.status_code}).", show_alert=True)
        return

    try:
        await c.message.delete()
    except Exception:
        pass

    await show_menu(
        chat_id=c.message.chat.id,
        state=state,
        text="Слой обновлён. Что дальше?",
    )
    await c.answer()


@dp.callback_query(F.data == "change_location")
async def cb_change_location(c: types.CallbackQuery, state: FSMContext):
    """Смена локации: показать текущий пин и запросить новый."""
    data = await state.get_data()
    lat = data.get("point_lat")
    lon = data.get("point_lon")

    # Отправляем текущую локацию как пин на карте (если есть координаты)
    if lat is not None and lon is not None:
        try:
            await bot.send_location(
                chat_id=c.message.chat.id,
                latitude=lat,
                longitude=lon,
            )
        except Exception:
            logger.warning("Не удалось отправить текущую локацию", exc_info=True)

    await c.message.edit_text(
        "Текущая локация показана выше. Отправьте новую геолокацию:",
        reply_markup=back_menu(),
    )
    await state.set_state(AddPoint.waiting_new_location)
    await c.answer()


@dp.callback_query(F.data == "delete_photo")
async def cb_delete_photo(c: types.CallbackQuery, state: FSMContext):
    """Удаление фото: показать фото и кнопки удаления."""
    data = await state.get_data()
    pid = data.get("point_id")
    if not pid:
        await c.answer("Ошибка состояния.")
        return

    await c.answer()

    # Сообщение "загружаю" перед скачиванием
    loading_msg = await c.message.edit_text("Загружаю фото...")

    r = api_request(
        "get",
        f"{API_BASE}/v1/bot/places/{pid}/media",
        params={"tg_id": c.from_user.id},
    )

    if r is None:
        await loading_msg.edit_text(
            "Ошибка связи с сервером.",
            reply_markup=back_menu(),
        )
        return
    if not r.ok:
        await loading_msg.edit_text(
            f"Ошибка загрузки фото (код {r.status_code}).",
            reply_markup=back_menu(),
        )
        return

    items = r.json().get("items", [])
    if not items:
        await loading_msg.edit_text(
            "У этой точки нет фотографий.",
            reply_markup=back_menu(),
        )
        return

    # Скачиваем фото из MinIO и отправляем альбомом (до 10)
    media_group = []
    media_ids = []  # id фото, которые удалось показать пользователю
    all_media_ids = [item["id"] for item in items]  # все id для "удалить все"
    for i, item in enumerate(items):
        url = item["url"]
        media_id = item["id"]

        # Подменяем scheme+host на внутренний MinIO (http, без TLS)
        parsed = urlparse(url)
        internal_url = urlunparse(parsed._replace(scheme="http", netloc=MINIO_INTERNAL_HOST))

        try:
            img_resp = requests.get(internal_url, timeout=30)
            if not img_resp.ok:
                continue
            photo_file = BufferedInputFile(
                img_resp.content,
                filename=f"photo_{i + 1}.jpg",
            )
            # Добавляем в media_ids ТОЛЬКО после успешной загрузки
            media_ids.append(media_id)
            idx = len(media_ids)
            media_group.append(InputMediaPhoto(
                media=photo_file,
                caption=f"#{idx}",
            ))
        except requests.RequestException:
            logger.warning("Не удалось скачать фото %d", media_id, exc_info=True)
            continue

    if media_group:
        # Telegram позволяет альбом до 10 фото
        for chunk_start in range(0, len(media_group), 10):
            chunk = media_group[chunk_start:chunk_start + 10]
            try:
                await bot.send_media_group(
                    chat_id=c.message.chat.id,
                    media=chunk,
                )
            except Exception:
                logger.warning("Не удалось отправить альбом", exc_info=True)

    # Кнопки удаления — по успешно загруженным фото
    buttons = []
    for i, mid in enumerate(media_ids):
        buttons.append([InlineKeyboardButton(
            text=f"Удалить #{i + 1}",
            callback_data=f"del_photo:{mid}",
        )])
    # "Удалить все" удаляет ВСЕ фото (включая незагруженные для превью)
    if len(all_media_ids) > 1:
        buttons.append([InlineKeyboardButton(
            text="Удалить все",
            callback_data="del_all_photos",
        )])
    buttons.append([InlineKeyboardButton(text="Назад", callback_data="back")])

    # Сохраняем all_media_ids для "удалить все"
    await state.update_data(media_ids=all_media_ids)

    total = len(all_media_ids)
    shown = len(media_ids)
    label = f"Фото: {total} шт."
    if shown < total:
        label += f" (показано {shown}, остальные не удалось загрузить)"

    await loading_msg.edit_text(
        f"{label} Выберите для удаления:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
    )
    await state.set_state(AddPoint.waiting_delete_photo)


@dp.callback_query(AddPoint.waiting_delete_photo, F.data.startswith("del_photo:"))
async def cb_del_one_photo(c: types.CallbackQuery, state: FSMContext):
    """Удалить одно фото."""
    try:
        media_id = int(c.data.split(":")[1])
    except (ValueError, IndexError):
        await c.answer("Ошибка.")
        return

    r = api_request(
        "delete",
        f"{API_BASE}/v1/bot/media/{media_id}",
        params={"tg_id": c.from_user.id},
    )

    if r is None:
        await c.answer("Ошибка связи с сервером.", show_alert=True)
        return
    if not r.ok:
        await c.answer(f"Не удалось удалить фото (код {r.status_code}).", show_alert=True)
        return

    try:
        await c.message.delete()
    except Exception:
        pass

    await show_menu(
        chat_id=c.message.chat.id,
        state=state,
        text="Фото удалено. Что дальше?",
    )
    await c.answer()


@dp.callback_query(AddPoint.waiting_delete_photo, F.data == "del_all_photos")
async def cb_del_all_photos(c: types.CallbackQuery, state: FSMContext):
    """Удалить все фото точки."""
    data = await state.get_data()
    media_ids = data.get("media_ids", [])
    errors = 0

    for mid in media_ids:
        r = api_request(
            "delete",
            f"{API_BASE}/v1/bot/media/{mid}",
            params={"tg_id": c.from_user.id},
        )
        if r is None or not r.ok:
            errors += 1

    try:
        await c.message.delete()
    except Exception:
        pass

    msg = "Все фото удалены."
    if errors:
        msg = f"Удалено {len(media_ids) - errors} из {len(media_ids)} фото."

    await show_menu(
        chat_id=c.message.chat.id,
        state=state,
        text=f"{msg} Что дальше?",
    )
    await c.answer()


@dp.callback_query(F.data == "delete_point")
async def cb_delete_point(c: types.CallbackQuery, state: FSMContext):
    """Подтверждение удаления точки."""
    await c.message.edit_text(
        "Удалить эту точку? Это действие нельзя отменить.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text="Да, удалить", callback_data="confirm_delete_point"),
                InlineKeyboardButton(text="Нет", callback_data="cancel_delete_point"),
            ],
        ]),
    )
    await state.set_state(AddPoint.confirming_delete_point)
    await c.answer()


@dp.callback_query(AddPoint.confirming_delete_point, F.data == "confirm_delete_point")
async def cb_confirm_delete_point(c: types.CallbackQuery, state: FSMContext):
    data = await state.get_data()
    pid = data.get("point_id")
    if not pid:
        await c.answer("Ошибка состояния.")
        await state.clear()
        return

    r = api_request(
        "delete",
        f"{API_BASE}/v1/bot/places/{pid}",
        params={"tg_id": c.from_user.id},
    )

    if r is None:
        await c.answer("Ошибка связи с сервером.", show_alert=True)
        return
    if not r.ok:
        await c.answer(f"Не удалось удалить (код {r.status_code}).", show_alert=True)
        return

    await state.clear()

    try:
        await c.message.delete()
    except Exception:
        pass

    await c.message.answer("Точка удалена. Отправьте геолокацию для новой точки или /mypoints.")
    await c.answer()


@dp.callback_query(AddPoint.confirming_delete_point, F.data == "cancel_delete_point")
async def cb_cancel_delete_point(c: types.CallbackQuery, state: FSMContext):
    try:
        await c.message.delete()
    except Exception:
        pass

    await show_menu(
        chat_id=c.message.chat.id,
        state=state,
        text="Удаление отменено. Что дальше?",
    )
    await c.answer()


@dp.callback_query(F.data == "finish_point")
async def cb_finish(c: types.CallbackQuery, state: FSMContext):
    data = await state.get_data()
    menu_id = data.get("menu_message_id")
    if menu_id:
        try:
            await bot.delete_message(chat_id=c.message.chat.id, message_id=menu_id)
        except Exception:
            pass

    await state.clear()
    await c.message.answer(
        "Готово. Точка сохранена.\n"
        "Отправьте геолокацию для новой точки или /mypoints."
    )
    await c.answer()


@dp.callback_query(F.data == "back")
async def cb_back(c: types.CallbackQuery, state: FSMContext):
    data = await state.get_data()
    if not data.get("point_id"):
        # Если есть lat/lon — значит юзер создавал точку, вернём к выбору группы
        if data.get("lat") is not None:
            await state.clear()
            await c.message.answer(
                "Создание точки отменено. Отправьте геолокацию, чтобы начать заново."
            )
        else:
            await state.clear()
            await c.message.answer(
                "Отправьте геолокацию для создания точки или /mypoints."
            )
        await c.answer()
        return

    await show_menu(
        chat_id=c.message.chat.id,
        state=state,
        text="Редактирование точки. Выберите действие:",
    )
    await c.answer()


# ---------- Title ----------
@dp.message(AddPoint.waiting_title, F.text)
async def set_title(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data.get("point_id")
    if not pid:
        await m.reply("Ошибка состояния. Используйте /mypoints или отправьте геолокацию.")
        await state.clear()
        return

    r = api_request(
        "patch",
        f"{API_BASE}/v1/bot/places/{pid}",
        json={"title": m.text, "tg_id": m.from_user.id},
    )

    if r is None:
        await m.reply("Ошибка связи с сервером.")
        return
    if not r.ok:
        await m.reply(f"Не удалось обновить название (код {r.status_code}).")
        return

    # Обновляем кэш в FSM
    points_data = data.get("points_data", {})
    if str(pid) in points_data:
        points_data[str(pid)]["title"] = m.text
        await state.update_data(points_data=points_data)

    await show_menu(
        chat_id=m.chat.id,
        state=state,
        text="Название обновлено. Что дальше?",
    )


@dp.message(AddPoint.waiting_title)
async def wrong_title(m: types.Message, state: FSMContext):
    await m.reply("Напишите название точки. Или нажмите «Назад».")

# ---------- Note ----------
@dp.message(AddPoint.waiting_note, F.text)
async def set_note(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data.get("point_id")
    if not pid:
        await m.reply("Ошибка состояния. Используйте /mypoints или отправьте геолокацию.")
        await state.clear()
        return

    r = api_request(
        "patch",
        f"{API_BASE}/v1/bot/places/{pid}",
        json={"note": m.text, "tg_id": m.from_user.id},
    )

    if r is None:
        await m.reply("Ошибка связи с сервером.")
        return
    if not r.ok:
        await m.reply(f"Не удалось обновить описание (код {r.status_code}).")
        return

    # Обновляем кэш в FSM
    points_data = data.get("points_data", {})
    if str(pid) in points_data:
        points_data[str(pid)]["note"] = m.text
        await state.update_data(points_data=points_data)

    await show_menu(
        chat_id=m.chat.id,
        state=state,
        text="Описание обновлено. Что дальше?",
    )


@dp.message(AddPoint.waiting_note)
async def wrong_note(m: types.Message, state: FSMContext):
    await m.reply("Напишите описание точки. Или нажмите «Назад».")


# ---------- Photo ----------
@dp.message(AddPoint.waiting_photo, F.photo)
async def add_photo(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data.get("point_id")
    if not pid:
        await m.reply("Ошибка состояния. Используйте /mypoints или отправьте геолокацию.")
        await state.clear()
        return

    file_id = m.photo[-1].file_id
    f = await bot.get_file(file_id)
    file_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{f.file_path}"

    # 1. просим backend выдать presigned URL с учетом лимита
    u = api_request(
        "post",
        f"{API_BASE}/v1/bot/media/presign-upload",
        json={"mime": "image/jpeg", "ext": "jpg", "place_id": pid},
    )

    if u is None:
        await m.reply("Ошибка связи с сервером.")
        return
    if not u.ok:
        if u.status_code == 400:
            await m.reply("У этой точки уже 12 фотографий. Новые не добавляю.")
        else:
            await m.reply("Ошибка подготовки загрузки фото.")
        return

    data_u = u.json()
    public_url = data_u["url"]
    temp_key = data_u["key"]

    # внутренний URL для MinIO (http, без TLS)
    parsed = urlparse(public_url)
    internal_url = urlunparse(parsed._replace(scheme="http", netloc=MINIO_INTERNAL_HOST))

    # качаем фото из Telegram
    try:
        img = requests.get(file_url, timeout=30).content
    except requests.RequestException:
        await m.reply("Ошибка скачивания фото из Telegram.")
        return

    # кладем в MinIO
    try:
        r = requests.put(
            internal_url,
            data=img,
            headers={"Content-Type": "image/jpeg"},
            timeout=30,
        )
        if not r.ok:
            await m.reply("Ошибка загрузки фото в хранилище.")
            return
    except requests.RequestException:
        await m.reply("Ошибка загрузки фото в хранилище.")
        return

    # привязываем temp_key к точке
    link = api_request(
        "post",
        f"{API_BASE}/v1/bot/places/{pid}/media",
        json={"temp_key": temp_key, "tg_id": m.from_user.id},
    )

    if link is None or not link.ok:
        code = link.status_code if link else "нет ответа"
        await m.reply(f"Фото загрузилось, но не удалось привязать к точке (код {code}).")
        return

    # подтверждаем, остаёмся в waiting_photo для загрузки ещё фото
    done_kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Готово", callback_data="back")],
    ])
    await m.reply("Фото добавлено. Отправьте ещё или нажмите «Готово».", reply_markup=done_kb)


@dp.message(AddPoint.waiting_photo)
async def wrong_photo(m: types.Message, state: FSMContext):
    await m.reply("Присылайте фотографию или нажмите «Готово».")


# ---------- Catch-all для callback (stale кнопки после рестарта) ----------

@dp.callback_query()
async def cb_fallback(c: types.CallbackQuery):
    await c.answer(
        "Сессия истекла. Используйте /mypoints или отправьте геолокацию.",
        show_alert=True,
    )


@dp.message()
async def fallback_message(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data.get("point_id")

    # Исключаем команды, обрабатываемые выше
    known_commands = ("/start", "/whoami", "/mypoints", "/newlayer", "/link")
    known_buttons = ("Новое место", "Последние места", "Ещё")
    if m.text and (
        any(m.text.startswith(cmd) for cmd in known_commands)
        or m.text in known_buttons
    ):
        return

    # если активной точки ещё нет — просим сначала геолокацию
    if not pid:
        if not m.location:
            await m.reply(
                "Сначала отправьте геолокацию — я создам точку и покажу меню.\n"
                "Или /mypoints для редактирования существующих."
            )
        return

    # точка есть, но пользователь пишет не то
    await m.reply("Сейчас можно пользоваться меню под последним сообщением бота.")


# ---------- Run ----------
async def main():
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
