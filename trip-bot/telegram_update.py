"""Создаёт (в первый раз) и обновляет одно сообщение в Telegram по данным trip/data.json.
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
PAGE = "https://111l9lpa.github.io/Haiku-/trip/"

# Публичный (publishable) ключ Supabase: его безопасно хранить в коде.
SB_URL = "https://exmxqybejhbtnbtqcwms.supabase.co"
SB_KEY = "sb_publishable_H_c3d5terU1y4slV6t-ChQ_bnfECYM2"


def ticket_bought():
    try:
        r = requests.get(f"{SB_URL}/rest/v1/trip_state", params={"id": "eq.1", "select": "ticket_bought"},
                         headers={"apikey": SB_KEY}, timeout=30)
        rows = r.json()
        return bool(rows[0]["ticket_bought"])
    except Exception:
        return False


def build_text():
    best = DATA.get("best")
    if best:
        price = f"{best['price']:,}".replace(",", " ")
        price_line = f"💰 <b>{price} ₽</b> туда-обратно\n✈️ вылет {best['dep']}, возврат {best['ret']}"
    else:
        price_line = "💰 цены пока не найдены"
    left = (date.fromisoformat(DATA["trip_start"]) - date.today()).days
    status = "✅ билет куплен" if ticket_bought() else "⏳ билет не куплен"
    return (f"<b>Москва → {DATA['destination']}</b>\n\n{price_line}\n{status}\n\n"
            f"🏖 до отпуска: <b>{max(left, 0)}</b> дн.\n"
            f'<a href="{PAGE}">Открыть страницу</a>')


def tg(method, **payload):
    r = requests.post(f"https://api.telegram.org/bot{TOKEN}/{method}", json=payload, timeout=30)
    return r.json()


def send_new(text):
    res = tg("sendMessage", chat_id=CHAT, text=text, parse_mode="HTML", disable_web_page_preview=True)
    if not res.get("ok"):
        sys.exit(f"Не удалось отправить: {res.get('description')}")
    STATE.write_text(json.dumps({"message_id": res["result"]["message_id"]}) + "\n")
    print("Отправлено новое сообщение. Закрепите его в чате.")


text = build_text()
mid = json.loads(STATE.read_text()).get("message_id") if STATE.exists() else None
if not mid:
    send_new(text)
else:
    res = tg("editMessageText", chat_id=CHAT, message_id=mid, text=text, parse_mode="HTML",
             disable_web_page_preview=True)
    desc = res.get("description", "")
    if res.get("ok") or "not modified" in desc:
        print("Сообщение обновлено")
    elif "not found" in desc or "can't be edited" in desc:
        send_new(text)  # сообщение удалили, создаём заново
    else:
        sys.exit(f"Ошибка Telegram: {desc}")
