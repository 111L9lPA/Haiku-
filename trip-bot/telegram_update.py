"""Отправляет (в первый раз) и обновляет одно сообщение-фото в Telegram по trip/data.json.
Нужны TG_BOT_TOKEN и TG_CHAT_ID. Если токена нет, скрипт молча выходит.
id сообщения хранится в trip/tg.json."""
import json
import os
import sys
from datetime import date
from pathlib import Path

import requests

TOKEN = os.environ.get("TG_BOT_TOKEN", "").strip()
CHAT = os.environ.get("TG_CHAT_ID", "").strip()
if not TOKEN or not CHAT:
    print("TG_BOT_TOKEN / TG_CHAT_ID не заданы, пропускаю Telegram")
    sys.exit(0)

ROOT = Path(__file__).parent.parent
DATA = json.loads((ROOT / "trip" / "data.json").read_text(encoding="utf-8"))
STATE = ROOT / "trip" / "tg.json"
PHOTO = ROOT / "trip" / "china.jpg"
PAGE = "https://111l9lpa.github.io/Haiku-/trip/"
SHOWN = 5  # сколько цен перечислять в сообщении

# Публичный (publishable) ключ Supabase: его безопасно хранить в коде.
SB_URL = "https://exmxqybejhbtnbtqcwms.supabase.co"
SB_KEY = "sb_publishable_H_c3d5terU1y4slV6t-ChQ_bnfECYM2"

MONTHS = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


def short_date(iso):
    d = date.fromisoformat(iso)
    return f"{d.day} {MONTHS[d.month]}"


def ticket_bought():
    try:
        r = requests.get(f"{SB_URL}/rest/v1/trip_state", params={"id": "eq.1", "select": "ticket_bought"},
                         headers={"apikey": SB_KEY}, timeout=30)
        return bool(r.json()[0]["ticket_bought"])
    except Exception:
        return False


def build_caption():
    offers = DATA.get("offers") or ([DATA["best"]] if DATA.get("best") else [])
    if offers:
        lines = []
        for i, o in enumerate(offers[:SHOWN]):
            price = f"{o['price']:,}".replace(",", " ")
            text = f"{price} ₽ · {short_date(o['dep'])} → {short_date(o['ret'])}"
            lines.append(f"🥇 <b>{text}</b>" if i == 0 else f"▫️ {text}")
        prices = "\n".join(lines)
    else:
        prices = "💰 цены пока не найдены"
    left = (date.fromisoformat(DATA["trip_start"]) - date.today()).days
    status = "✅ билет куплен" if ticket_bought() else "⏳ билет не куплен"
    caption = (f"<b>Москва → {DATA['destination']}</b>\n\n{prices}\n\n{status}\n"
               f"🏖 до отпуска: <b>{max(left, 0)}</b> дн.\n\n"
               f'<a href="{PAGE}">Все цены и ссылки на билеты</a>')
    return caption[:1024]


def call(method, data=None, files=None):
    r = requests.post(f"https://api.telegram.org/bot{TOKEN}/{method}", data=data, files=files, timeout=60)
    return r.json()


def send_new(caption):
    with PHOTO.open("rb") as f:
        res = call("sendPhoto", data={"chat_id": CHAT, "caption": caption, "parse_mode": "HTML"},
                   files={"photo": f})
    if not res.get("ok"):
        sys.exit(f"Не удалось отправить: {res.get('description')}")
    STATE.write_text(json.dumps({"photo_message_id": res["result"]["message_id"]}) + "\n")
    print("Отправлено новое сообщение. Закрепите его в чате.")


caption = build_caption()
state = json.loads(STATE.read_text()) if STATE.exists() else {}
if state.get("message_id"):  # старое текстовое сообщение: удаляем, его нельзя превратить в фото
    call("deleteMessage", data={"chat_id": CHAT, "message_id": state["message_id"]})
    state.pop("message_id")
mid = state.get("photo_message_id")
if not mid:
    send_new(caption)
else:
    media = {"type": "photo", "media": "attach://photo", "caption": caption, "parse_mode": "HTML"}
    with PHOTO.open("rb") as f:
        res = call("editMessageMedia", data={"chat_id": CHAT, "message_id": mid, "media": json.dumps(media)},
                   files={"photo": f})
    desc = res.get("description", "")
    if res.get("ok") or "not modified" in desc:
        print("Сообщение обновлено")
    elif "not found" in desc or "can't be edited" in desc:
        send_new(caption)  # сообщение удалили, создаём заново
    else:
        sys.exit(f"Ошибка Telegram: {desc}")
