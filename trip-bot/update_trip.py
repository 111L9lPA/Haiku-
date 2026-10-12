"""Обновляет одно закреплённое сообщение в Telegram с ценами на билеты,
статусом покупки, обратным отсчётом и фото.

Запуск:
  python update_trip.py --init   # один раз: отправить новое сообщение, напечатать message_id
  python update_trip.py          # обычный запуск по расписанию (редактирует сообщение)

Переменные окружения (GitHub Secrets):
  TG_BOT_TOKEN, TG_CHAT_ID, TP_TOKEN, SUPABASE_URL, SUPABASE_KEY
"""
import json
import os
import random
import sys
from datetime import date
from pathlib import Path

import requests

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))

TG_BOT_TOKEN = os.environ["TG_BOT_TOKEN"]
TG_CHAT_ID = os.environ["TG_CHAT_ID"]
TP_TOKEN = os.environ["TP_TOKEN"]
SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ["SUPABASE_KEY"]
SB_HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

ORIGIN = CONFIG["origin"]            # MOW
DEST = CONFIG["destination"]         # PEK / PVG
TRIP_DATE = date.fromisoformat(CONFIG["trip_start"])
DEPART_DAYS = CONFIG["depart_days"]  # ["2026-11-13", "2026-11-14"]
RETURN_DAYS = CONFIG["return_days"]  # ["2026-11-27", ..., "2026-11-30"]


def cheapest_round_trip():
    """Перебирает все комбинации дат вылета и возврата и возвращает минимальную цену."""
    best = None
    for dep in DEPART_DAYS:
        for ret in RETURN_DAYS:
            r = requests.get(
                "https://api.travelpayouts.com/aviasales/v3/prices_for_dates",
                params={
                    "origin": ORIGIN,
                    "destination": DEST,
                    "departure_at": dep,
                    "return_at": ret,
                    "currency": "rub",
                    "sorting": "price",
                    "direct": "false",
                    "one_way": "false",
                    "limit": 1,
                    "token": TP_TOKEN,
                },
                timeout=30,
            )
            r.raise_for_status()
            items = r.json().get("data") or []
            if not items:
                continue
            item = items[0]
            if best is None or item["price"] < best["price"]:
                best = {"price": item["price"], "dep": dep, "ret": ret}
    return best


def ticket_bought():
    r = requests.get(
        f"{SB_URL}/rest/v1/trip_state",
        params={"id": "eq.1", "select": "ticket_bought"},
        headers=SB_HEADERS,
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    return bool(rows[0]["ticket_bought"]) if rows else False


def random_photo_url():
    """Берёт случайное фото из публичного бакета Supabase Storage."""
    r = requests.post(
        f"{SB_URL}/storage/v1/object/list/{CONFIG['photo_bucket']}",
        json={"prefix": "", "limit": 1000},
        headers=SB_HEADERS,
        timeout=30,
    )
    r.raise_for_status()
    files = [f["name"] for f in r.json() if f.get("name")]
    if not files:
        raise RuntimeError("В бакете нет фото")
    name = random.choice(files)
    return f"{SB_URL}/storage/v1/object/public/{CONFIG['photo_bucket']}/{name}"


def build_caption(best, bought):
    days_left = (TRIP_DATE - date.today()).days
    if best:
        price_line = (
            f"💰 <b>{best['price']:,} ₽</b> туда-обратно\n"
            f"✈️ вылет {best['dep']}, возврат {best['ret']}"
        ).replace(",", " ")
    else:
        price_line = "💰 цены пока не найдены, попробуем позже"
    status = "✅ билет куплен" if bought else "⏳ билет не куплен"
    return (
        f"<b>Москва → {CONFIG['destination_name']}</b>\n\n"
        f"{price_line}\n"
        f"{status}\n\n"
        f"🏖 до отпуска: <b>{days_left}</b> дн."
    )


def tg(method, **payload):
    r = requests.post(
        f"https://api.telegram.org/bot{TG_BOT_TOKEN}/{method}",
        json=payload,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["result"]


def init_message():
    caption = build_caption(None, False)
    result = tg("sendPhoto", chat_id=TG_CHAT_ID, photo=random_photo_url(),
                caption=caption, parse_mode="HTML")
    print(f"message_id: {result['message_id']}")
    print("Закрепите это сообщение и впишите id в trip-bot/config.json (поле message_id).")


def update_message():
    best = cheapest_round_trip()
    bought = ticket_bought()
    media = {
        "type": "photo",
        "media": random_photo_url(),
        "caption": build_caption(best, bought),
        "parse_mode": "HTML",
    }
    tg("editMessageMedia", chat_id=TG_CHAT_ID, message_id=CONFIG["message_id"], media=media)
    print("Сообщение обновлено:", best or "цен нет")


if __name__ == "__main__":
    if "--init" in sys.argv:
        init_message()
    else:
        if not CONFIG.get("message_id"):
            sys.exit("Сначала выполните --init и впишите message_id в config.json")
        update_message()
