import os, asyncio, logging, requests
from urllib.parse import urlparse, urlunparse
from aiogram import Bot, Dispatcher, F, types
from aiogram.fsm.state import StatesGroup, State
from aiogram.fsm.context import FSMContext
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
API_BASE = os.getenv("APP_BASE_URL", "http://api:8000")

logging.basicConfig(level=logging.INFO)

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher(storage=MemoryStorage())


# ---------- FSM ----------
class AddPoint(StatesGroup):
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


# ---------- Commands ----------
@dp.message(F.text == "/whoami")
async def whoami(m: types.Message):
    await m.reply(
        f"Ваш Telegram ID: {m.from_user.id}\n"
        f"username: @{m.from_user.username}" if m.from_user.username else ""
    )


# ---------- Location handler: create point ----------
@dp.message(F.location)
async def on_location(m: types.Message, state: FSMContext):
    lat = m.location.latitude
    lon = m.location.longitude

    payload = {
        "group_id": 1,
        "tg_id": m.from_user.id,
        "username": m.from_user.username,
        "title": None,
        "note": "",
        "lat": lat,
        "lon": lon,
        "media_keys": [],
    }

    r = requests.post(f"{API_BASE}/v1/places", json=payload)

    if not r.ok:
        await m.reply(f"Не удалось создать точку (код {r.status_code})")
        return

    pid = r.json().get("id")

    # сбрасываем старое состояние/данные
    await state.clear()

    # отправляем сообщение-«меню» и запоминаем его id
    menu_msg = await m.reply(
        f"Точка создана (id {pid}). Теперь вы можете добавить данные.",
        reply_markup=make_edit_menu()
    )

    await state.update_data(point_id=pid, menu_message_id=menu_msg.message_id)


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
    await state.clear()
    await c.message.edit_text("Готово. Точка сохранена.")


@dp.callback_query(F.data == "back")
async def cb_back(c: types.CallbackQuery, state: FSMContext):
    data = await state.get_data()
    pid = data.get("point_id")
    menu_msg_id = data.get("menu_message_id")

    if not pid or not menu_msg_id:
        await state.clear()
        await c.message.edit_text("Ошибка состояния.")
        return

    await bot.edit_message_text(
        chat_id=c.message.chat.id,
        message_id=menu_msg_id,
        text="Редактирование точки:",
        reply_markup=make_edit_menu(),
    )
    # состояние сбрасываем, данные (point_id, menu_message_id) сохраняем
    await state.set_state(None)


# ---------- Title ----------
@dp.message(AddPoint.waiting_title, F.text)
async def set_title(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data["point_id"]
    menu_msg_id = data["menu_message_id"]

    requests.patch(f"{API_BASE}/v1/places/{pid}", json={"title": m.text})

    await bot.edit_message_text(
        chat_id=m.chat.id,
        message_id=menu_msg_id,
        text="Название обновлено.\n\nРедактирование точки:",
        reply_markup=make_edit_menu(),
    )
    await state.set_state(None)

@dp.message(AddPoint.waiting_title)
async def wrong_title(m: types.Message, state: FSMContext):
    await m.reply("Напишите название точки. Или нажмите «Назад».")

# ---------- Note ----------
@dp.message(AddPoint.waiting_note, F.text)
async def set_note(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data["point_id"]
    menu_msg_id = data["menu_message_id"]

    requests.patch(f"{API_BASE}/v1/places/{pid}", json={"note": m.text})

    await bot.edit_message_text(
        chat_id=m.chat.id,
        message_id=menu_msg_id,
        text="Описание обновлено.\n\nРедактирование точки:",
        reply_markup=make_edit_menu(),
    )
    await state.set_state(None)


@dp.message(AddPoint.waiting_note)
async def wrong_note(m: types.Message, state: FSMContext):
    await m.reply("Напишите описание точки. Или нажмите «Назад».")


# ---------- Photo ----------
@dp.message(AddPoint.waiting_photo, F.photo)
async def add_photo(m: types.Message, state: FSMContext):
    data = await state.get_data()
    pid = data["point_id"]
    menu_msg_id = data["menu_message_id"]

    file_id = m.photo[-1].file_id
    f = await bot.get_file(file_id)
    file_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{f.file_path}"

    # 1. просим backend выдать presigned URL с учётом лимита
    u = requests.post(
        f"{API_BASE}/v1/media/presign-upload",
        json={"mime": "image/jpeg", "ext": "jpg", "place_id": pid},
    )

    if not u.ok:
        if u.status_code == 400:
            await m.reply("Уже 10 фотографий для одной точки. Новые не будут добавлены.")
        else:
            await m.reply("Ошибка подготовки загрузки фото.")
        return

    data_u = u.json()
    public_url = data_u["url"]
    temp_key = data_u["key"]

    # 2. внутренний URL для MinIO
    parsed = urlparse(public_url)
    internal_url = urlunparse(parsed._replace(netloc="minio:9000"))

    # 3. качаем фото из Telegram
    img = requests.get(file_url).content

    # 4. кладем в MinIO
    r = requests.put(internal_url, data=img, headers={"Content-Type": "image/jpeg"})
    if not r.ok:
        await m.reply("Ошибка загрузки фото в хранилище.")
        return

    # 5. привязываем temp_key к точке
    requests.post(f"{API_BASE}/v1/places/{pid}/media", json={"temp_key": temp_key})

    # 6. возвращаем основное меню, «Назад» пропадает
    await bot.edit_message_text(
        chat_id=m.chat.id,
        message_id=menu_msg_id,
        text="Фото добавлено.\n\nРедактирование точки:",
        reply_markup=make_edit_menu(),
    )
    await state.set_state(None)


@dp.message(AddPoint.waiting_photo)
async def wrong_photo(m: types.Message, state: FSMContext):
    await m.reply("Присылайте фотографию. Или нажмите «Назад».")


# ---------- Run ----------
async def main():
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
