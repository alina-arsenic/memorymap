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
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
API_BASE = os.getenv("APP_BASE_URL", "http://api:8000")
BOT_API_SECRET = os.getenv("BOT_API_SECRET", "")

logging.basicConfig(level=logging.INFO)

session = AiohttpSession()

bot = Bot(token=BOT_TOKEN, session=session)

dp = Dispatcher(storage=MemoryStorage())


# ---------- FSM ----------
class AddPoint(StatesGroup):
    waiting_group = State()
    waiting_title = State()
    waiting_note = State()
    waiting_photo = State()


# ---------- Keyboards ----------

def make_edit_menu():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Добавить название", callback_data="add_title")],
        [InlineKeyboardButton(text="Добавить описание", callback_data="add_note")],
        [InlineKeyboardButton(text="Добавить фото", callback_data="add_photo")],
        [InlineKeyboardButton(text="Готово", callback_data="finish_point")],
    ])


def back_menu():
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="Назад", callback_data="back")]]
    )


async def show_menu(chat_id: int, state: FSMContext, text: str):
    """
    Показываем меню внизу, при этом старое меню (если было) удаляем.
    """
    data = await state.get_data()
    old_id = data.get("menu_message_id")
    if old_id:
        try:
            await bot.delete_message(chat_id=chat_id, message_id=old_id)
        except Exception:
            # уже удалено / старое - игнорируем
            pass

    msg = await bot.send_message(
        chat_id,
        text,
        reply_markup=make_edit_menu()
    )

    await state.update_data(menu_message_id=msg.message_id)
    # выходим в нейтральное состояние
    await state.set_state(None)


# ---------- Commands ----------

@dp.message(CommandStart())
async def cmd_start(m: types.Message, command: CommandObject):
    """Обработчик /start. Если передан deep_link код — привязываем Telegram."""
    code = command.args  # текст после /start (None если просто /start)

    if not code:
        await m.reply(
            "Привет! Я бот MemoryMap.\n\n"
            "Отправьте мне геолокацию, чтобы сохранить место на карте.\n"
            "Для привязки аккаунта используйте ссылку с сайта."
        )
        return

    # deep link: /start <code> — привязка Telegram к аккаунту
    if not BOT_API_SECRET:
        await m.reply("Бот не настроен: нет BOT_API_SECRET.")
        return

    r = requests.post(
        f"{API_BASE}/v1/bot/link-telegram",
        headers={"X-Bot-Secret": BOT_API_SECRET},
        json={"code": code, "tg_id": m.from_user.id},
        timeout=10,
    )

    if r.ok:
        await m.reply(
            "Готово! Telegram привязан к вашему профилю.\n"
            "Теперь вы можете отправлять геолокацию для создания точек."
        )
    elif r.status_code == 400:
        await m.reply("Код истёк. Сгенерируйте новый на сайте.")
    elif r.status_code == 404:
        await m.reply("Код не найден. Попробуйте сгенерировать новый на сайте.")
    elif r.status_code == 409:
        await m.reply("Код уже использован или этот Telegram уже привязан к другому аккаунту.")
    else:
        await m.reply(f"Ошибка привязки (код {r.status_code}).")


@dp.message(F.text == "/whoami")
async def whoami(m: types.Message):
    await m.reply(
        f"Ваш Telegram ID: {m.from_user.id}\n"
        f"username: @{m.from_user.username}" if m.from_user.username else ""
    )


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

    r = requests.post(
        f"{API_BASE}/v1/bot/link-telegram",
        headers={"X-Bot-Secret": BOT_API_SECRET},
        json={"code": code, "tg_id": m.from_user.id},
        timeout=10,
    )
    if r.ok:
        await m.reply("Готово. Telegram привязан к вашему профилю.")
    else:
        # важные кейсы
        if r.status_code == 400:
            await m.reply("Код истёк. Сгенерируйте новый на сайте.")
        elif r.status_code == 404:
            await m.reply("Код не найден. Проверьте, что скопировали правильно.")
        elif r.status_code == 409:
            await m.reply("Код уже использован или этот Telegram уже привязан к другому аккаунту.")
        else:
            await m.reply(f"Ошибка привязки (код {r.status_code}).")

# ---------- Location handler: запрос выбора группы ----------
@dp.message(F.location)
async def on_location(m: types.Message, state: FSMContext):
    lat = m.location.latitude
    lon = m.location.longitude

    # Запрашиваем список доступных групп через backend
    r = requests.get(
        f"{API_BASE}/v1/bot/groups",
        params={"tg_id": m.from_user.id},
        headers={"X-Bot-Secret": BOT_API_SECRET},
        timeout=10,
    )

    if r.status_code == 400 and r.json().get("detail") == "telegram_not_linked":
        await m.reply(
            "Ваш Telegram не привязан к аккаунту.\n"
            "Зайдите на сайт, войдите в аккаунт, "
            "сгенерируйте код привязки и отправьте мне:\n\n"
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
    await state.update_data(lat=lat, lon=lon, username=m.from_user.username, tg_id=m.from_user.id)

    # Формируем inline-кнопки выбора группы
    buttons = []
    for g in groups:
        label = g["name"]
        buttons.append([InlineKeyboardButton(
            text=label,
            callback_data=f"select_group:{g['id']}",
        )])

    await m.reply(
        "Куда добавить точку?",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons),
    )
    await state.set_state(AddPoint.waiting_group)


# ---------- Callback: выбор группы → создание точки ----------
@dp.callback_query(AddPoint.waiting_group, F.data.startswith("select_group:"))
async def cb_select_group(c: types.CallbackQuery, state: FSMContext):
    group_id = int(c.data.split(":")[1])
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

    r = requests.post(
        f"{API_BASE}/v1/places/bot",
        json=payload,
        headers={"X-Bot-Secret": BOT_API_SECRET},
        timeout=10,
    )

    if not r.ok:
        await c.message.edit_text(f"Не удалось создать точку (код {r.status_code})")
        await state.clear()
        await c.answer()
        return

    pid = r.json().get("id")

    # Начинаем сеанс редактирования точки
    await state.update_data(point_id=pid)

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
    await c.message.edit_text("Введите название:", reply_markup=back_menu())
    await state.set_state(AddPoint.waiting_title)


@dp.callback_query(F.data == "add_note")
async def cb_add_note(c: types.CallbackQuery, state: FSMContext):
    await c.message.edit_text("Введите описание:", reply_markup=back_menu())
    await state.set_state(AddPoint.waiting_note)


@dp.callback_query(F.data == "add_photo")
async def cb_add_photo(c: types.CallbackQuery, state: FSMContext):
    await c.message.edit_text("Отправьте фото:", reply_markup=back_menu())
    await state.set_state(AddPoint.waiting_photo)


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
    await c.message.answer("Готово. Точка сохранена. Чтобы создать новую, отправьте геолокацию.")
    await c.answer()


@dp.callback_query(F.data == "back")
async def cb_back(c: types.CallbackQuery, state: FSMContext):
    data = await state.get_data()
    if not data.get("point_id"):
        await state.clear()
        await c.message.answer("Ошибка состояния. Отправьте геолокацию, чтобы создать точку.")
        return

    await show_menu(
        chat_id=c.message.chat.id,
        state=state,
        text="Редактирование точки. Выберите действие:"
    )
    await c.answer()


# ---------- Title ----------
@dp.message(AddPoint.waiting_title, F.text)
async def set_title(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data["point_id"]

    r = requests.patch(
        f"{API_BASE}/v1/bot/places/{pid}",
        headers={"X-Bot-Secret": BOT_API_SECRET},
        json={"title": m.text, "tg_id": m.from_user.id},
        timeout=10,
    )
    if not r.ok:
        await m.reply(f"Не удалось обновить название (код {r.status_code}).")
        return

    await show_menu(chat_id=m.chat.id, state=state, text="Название обновлено. Что дальше сделать с этой точкой?")


@dp.message(AddPoint.waiting_title)
async def wrong_title(m: types.Message, state: FSMContext):
    await m.reply("Напишите название точки. Или нажмите «Назад».")

# ---------- Note ----------
@dp.message(AddPoint.waiting_note, F.text)
async def set_note(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data["point_id"]

    r = requests.patch(
        f"{API_BASE}/v1/bot/places/{pid}",
        headers={"X-Bot-Secret": BOT_API_SECRET},
        json={"note": m.text, "tg_id": m.from_user.id},
        timeout=10,
    )
    if not r.ok:
        await m.reply(f"Не удалось обновить описание (код {r.status_code}).")
        return

    await show_menu(chat_id=m.chat.id, state=state, text="Описание обновлено. Что дальше сделать с этой точкой?")


@dp.message(AddPoint.waiting_note)
async def wrong_note(m: types.Message, state: FSMContext):
    await m.reply("Напишите описание точки. Или нажмите «Назад».")


# ---------- Photo ----------
@dp.message(AddPoint.waiting_photo, F.photo)
async def add_photo(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data["point_id"]

    file_id = m.photo[-1].file_id
    f = await bot.get_file(file_id)
    file_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{f.file_path}"

    # 1. просим backend выдать presigned URL с учетом лимита
    u = requests.post(
        f"{API_BASE}/v1/bot/media/presign-upload",
        headers={"X-Bot-Secret": BOT_API_SECRET},
        json={"mime": "image/jpeg", "ext": "jpg", "place_id": pid},
        timeout=10,
    )

    if not u.ok:
        if u.status_code == 400:
            await m.reply("У этой точки уже 12 фотографий. Новые не добавляю.")
        else:
            await m.reply("Ошибка подготовки загрузки фото.")
        return

    data_u = u.json()
    public_url = data_u["url"]
    temp_key = data_u["key"]

    # внутренний URL для MinIO
    parsed = urlparse(public_url)
    internal_url = urlunparse(parsed._replace(netloc="minio:9000"))

    # качаем фото из Telegram
    img = requests.get(file_url).content

    # кладем в MinIO
    r = requests.put(internal_url, data=img, headers={"Content-Type": "image/jpeg"})
    if not r.ok:
        await m.reply("Ошибка загрузки фото в хранилище.")
        return

    # привязываем temp_key к точке
    link = requests.post(
        f"{API_BASE}/v1/bot/places/{pid}/media",
        headers={"X-Bot-Secret": BOT_API_SECRET},
        json={"temp_key": temp_key, "tg_id": m.from_user.id},
        timeout=10,
    )
    if not link.ok:
        await m.reply(f"Фото загрузилось, но не удалось привязать к точке (код {link.status_code}).")
        return

    # просто подтверждаем, остаемся в режиме ожидания фото
    await m.reply("Фото добавлено.")


@dp.message(AddPoint.waiting_photo)
async def wrong_photo(m: types.Message, state: FSMContext):
    await m.reply("Присылайте фотографию. Или нажмите «Назад».")


@dp.message()
async def fallback_message(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data.get("point_id")

    # если активной точки ещё нет - просим сначала геолокацию
    if not pid:
        # не трогаем /whoami и локацию, они обрабатываются выше
        if not m.location and m.text not in ("/start", "/whoami"):
            await m.reply("Сначала отправьте геолокацию - я создам точку и покажу меню.")
        return

    # точка есть, но пользователь пишет лажу
    await m.reply("Сейчас можно пользоваться меню под последним сообщением бота.")


# ---------- Run ----------
async def main():
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
