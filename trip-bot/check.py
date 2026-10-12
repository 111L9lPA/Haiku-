"""Быстрая проверка раз в 5 минут: нужно ли обновить цены и есть ли новые сообщения боту.
Пишет в GITHUB_OUTPUT: prices (обновить цены), bot (ответить в Telegram), flag (кнопка «Обновить» на сайте).
Только стандартная библиотека, чтобы проверка занимала пару секунд."""
import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
SB_URL = "https://exmxqybejhbtnbtqcwms.supabase.co"
SB_KEY = "sb_publishable_H_c3d5terU1y4slV6t-ChQ_bnfECYM2"  # публичный ключ, его можно хранить в коде
MAX_AGE = 4 * 3600 - 300  # плановое обновление раз в 4 часа


def get_json(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=20) as r:
        return json.load(r)


def wants_update(text):
    text = text.strip().lower()
    cmd = text.split()[0].split("@")[0] if text else ""
    return cmd in ("/update", "/refresh") or text.startswith("обнови")


prices = bot = flag = False
if os.environ.get("EVENT") == "workflow_dispatch":
    prices = True

try:
    rows = get_json(f"{SB_URL}/rest/v1/trip_state?id=eq.1&select=refresh_requested", {"apikey": SB_KEY})
    flag = bool(rows and rows[0].get("refresh_requested"))
except Exception as e:
    print("Флаг обновления не прочитан:", type(e).__name__)
prices = prices or flag

try:
    updated = json.loads((ROOT / "trip" / "data.json").read_text(encoding="utf-8"))["updated_at"]
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(updated)).total_seconds()
    prices = prices or age >= MAX_AGE
except Exception:
    prices = True

token = os.environ.get("TG_BOT_TOKEN", "").strip()
if token:
    try:
        state_file = ROOT / "trip" / "tg.json"
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        res = get_json(f"https://api.telegram.org/bot{token}/getUpdates?offset={state.get('offset', 0)}&timeout=0")
        updates = res.get("result", [])
        bot = bool(updates)
        if any(wants_update((u.get("message") or {}).get("text") or "") for u in updates):
            prices = True
    except Exception as e:
        print("Telegram не ответил:", type(e).__name__)

print(f"prices={prices} bot={bot} flag={flag}")
with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as out:
    out.write(f"prices={str(prices).lower()}\nbot={str(bot).lower()}\nflag={str(flag).lower()}\n")
