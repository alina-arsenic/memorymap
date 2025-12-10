import os, asyncio, logging, requests
from aiogram import Bot, Dispatcher, F, types

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
API_BASE = os.getenv("APP_BASE_URL", "http://api:8000")

logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()


@dp.message(F.text == "/whoami")
async def whoami(m: types.Message):
    await m.reply(
        f"Ваш Telegram ID: {m.from_user.id}\n"
        f"username: @{m.from_user.username}" if m.from_user.username else ""
    )


@dp.message(F.location)
async def on_location(m: types.Message):
    lat = m.location.latitude
    lon = m.location.longitude

    payload = {
        "group_id": 1,  # публичная группа
        "tg_id": m.from_user.id,
        "username": m.from_user.username,
        "title": "Из Telegram",
        "note": "",
        "lat": lat,
        "lon": lon,
    }

    r = requests.post(f"{API_BASE}/v1/places", json=payload)

    if r.ok:
        data = r.json()
        msg = f"Точка добавлена (id: {data.get('id')})"
    else:
        msg = f"Не удалось добавить точку (код {r.status_code})"

    await m.reply(msg)


@dp.message(F.photo)
async def on_photo(m: types.Message):
    file_id = m.photo[-1].file_id
    f = await bot.get_file(file_id)
    file_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{f.file_path}"

    u = requests.post(
        f"{API_BASE}/v1/media/presign-upload",
        json={"mime": "image/jpeg", "ext": "jpg"},
    ).json()
    put_url = u["url"]
    img = requests.get(file_url).content
    r = requests.put(put_url, data=img, headers={"Content-Type": "image/jpeg"})
    await m.reply("Фото загружено" if r.ok else "Не удалось загрузить фото")


async def main():
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
