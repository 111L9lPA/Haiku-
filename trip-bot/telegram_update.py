"""Telegram-бот «Китай-радар».

1. Отвечает на команды (/start, /top, /update, /bought, /phrase, /stop, /help).
2. В каждом подписанном чате держит одно живое сообщение-фото: создаёт, закрепляет и обновляет его.
3. Если цена заметно упала (trip/alert.json), присылает отдельное уведомление.

Бот живёт на GitHub Actions, поэтому отвечает с задержкой до 5–15 минут.
Нужны TG_BOT_TOKEN и TG_CHAT_ID (чат хозяина, он подписан всегда).
Состояние (подписчики, id сообщений, offset) хранится в trip/tg.json."""
import hashlib
import json
import os
import random
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

TOKEN = os.environ.get("TG_BOT_TOKEN", "").strip()
OWNER = os.environ.get("TG_CHAT_ID", "").strip()
PRICES_UPDATED = os.environ.get("PRICES_UPDATED") == "true"
if not TOKEN:
    print("TG_BOT_TOKEN не задан, пропускаю Telegram")
    sys.exit(0)

ROOT = Path(__file__).parent.parent
TRIP = ROOT / "trip"
DATA = json.loads((TRIP / "data.json").read_text(encoding="utf-8"))
PHRASES = json.loads((TRIP / "phrases.json").read_text(encoding="utf-8"))
STATE_FILE, ALERT_FILE, PHOTO = TRIP / "tg.json", TRIP / "alert.json", TRIP / "china.jpg"
PAGE = "https://111l9lpa.github.io/Haiku-/trip/"
MAX_CHATS = 10

# Публичный (publishable) ключ Supabase: его безопасно хранить в коде.
SB_URL = "https://exmxqybejhbtnbtqcwms.supabase.co"
SB_HEADERS = {"apikey": "sb_publishable_H_c3d5terU1y4slV6t-ChQ_bnfECYM2", "Content-Type": "application/json"}

MONTHS = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
MSK = timezone(timedelta(hours=3))
CITY = {c["code"]: c for c in DATA.get("cities", [])}
ORIGIN = {o["code"]: o for o in DATA.get("origins", [])}

KEYBOARD = json.dumps({"inline_keyboard": [
    [{"text": "🔄 Обновить цены", "url": PAGE + "#refresh"}],
    [{"text": "🗺 Все города", "url": PAGE + "#cities"}, {"text": "📅 Календарь", "url": PAGE + "search.html"}],
]})

HELP = ("Я <b>Китай-радар</b> 🇨🇳 Слежу за ценами на билеты туда-обратно из Москвы и Краснодара "
        "во все крупные города Китая. Считаю только поездки от 12 дней.\n\n"
        "/top — 10 самых дешёвых вариантов\n"
        "/update — найти свежие цены прямо сейчас\n"
        "/bought — отметить, что билет куплен (или снять отметку)\n"
        "/phrase — случайная фраза по-китайски\n"
        "/stop — больше не присылать обновления\n\n"
        "Я живу на бесплатном GitHub, поэтому отвечаю с задержкой до 5–15 минут 🐢")


# ---------- форматирование ----------
def money(n):
    return f"{n:,}".replace(",", " ") + " ₽"


def k(n):
    return f"{round(n / 1000)}к"


def sd(iso):
    d = date.fromisoformat(iso)
    return f"{d.day} {MONTHS[d.month]}"


def plural(n, one, few, many):
    n = abs(n) % 100
    if 10 < n < 20:
        return many
    return one if n % 10 == 1 else few if 2 <= n % 10 <= 4 else many


def city(code):
    return CITY.get(code, {}).get("name", code)


def route(i):
    return f"{ORIGIN.get(i['o'], {}).get('name', i['o'])} → {city(i['x'])}"


def nights(i):
    return (date.fromisoformat(i["r"]) - date.fromisoformat(i["d"])).days


def ticket_url(i):
    if i.get("l"):
        return "https://www.aviasales.ru" + i["l"]
    dd = lambda iso: iso[8:10] + iso[5:7]
    return f"https://www.aviasales.ru/search/{i['o']}{dd(i['d'])}{i['x']}{dd(i['r'])}1"


def phrase(rnd=False):
    p = random.choice(PHRASES) if rnd else PHRASES[date.today().toordinal() % len(PHRASES)]
    return f"🀄 {p['h']} <i>({p['p']})</i> — {p['ru']}"


# ---------- Supabase ----------
def sb_state():
    try:
        r = requests.get(f"{SB_URL}/rest/v1/trip_state", params={"id": "eq.1", "select": "ticket_bought"},
                         headers=SB_HEADERS, timeout=20)
        return bool(r.json()[0]["ticket_bought"])
    except Exception:
        return False


def sb_patch(fields):
    try:
        r = requests.patch(f"{SB_URL}/rest/v1/trip_state", params={"id": "eq.1"}, json=fields,
                           headers={**SB_HEADERS, "Prefer": "return=minimal"}, timeout=20)
        return r.ok
    except Exception:
        return False


# ---------- Telegram ----------
def call(method, data=None, files=None):
    try:
        return requests.post(f"https://api.telegram.org/bot{TOKEN}/{method}", data=data, files=files, timeout=60).json()
    except Exception as e:
        return {"ok": False, "description": type(e).__name__}


def say(chat, text, markup=None):
    data = {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    if markup:
        data["reply_markup"] = markup
    return call("sendMessage", data)


# ---------- живое сообщение ----------
def caption(bought):
    left = max((date.fromisoformat(DATA["trip_start"]) - date.today()).days, 0)
    pw = DATA.get("plan_window", {})
    plan, best = DATA.get("plan") or [], DATA.get("best")
    head = [f"🇨🇳 <b>Китай-радар</b> · до вылета <b>{left}</b> {plural(left, 'день', 'дня', 'дней')}", ""]

    day = lambda iso: str(date.fromisoformat(iso).day)
    window = f"{day(pw['depart_from'])}–{sd(pw['depart_to'])} → {day(pw['return_from'])}–{sd(pw['return_to'])}" if pw else ""
    block_plan = [f"🎯 <b>Наши даты</b> · {window}"]
    if plan:
        for medal, i in zip(("🥇", "🥈", "🥉"), plan[:3]):
            block_plan.append(f"{medal} <b>{money(i['p'])}</b> {route(i)} · {sd(i['d'])}→{sd(i['r'])}")
    else:
        block_plan.append("пока ничего не нашлось на эти даты")

    block_best = []
    if best and (not plan or best["p"] < plan[0]["p"]):
        block_best = ["", "🔥 <b>Дешевле всего в ноябре–декабре</b> (от 12 дней)",
                      f"<b>{money(best['p'])}</b> {route(best)} · {sd(best['d'])}→{sd(best['r'])} ({nights(best)} дн.)"]

    top, seen = [], set()
    for i in DATA.get("board", []):
        if i["x"] not in seen:
            seen.add(i["x"])
            top.append(f"{city(i['x'])} {k(i['p'])}")
        if len(top) == 4:
            break
    block_top = ["", "🗺 " + " · ".join(top)] if top else []

    extra = [""]
    trend = (DATA.get("trend") or {}).get("plan_24h")
    if trend is None:
        trend = (DATA.get("trend") or {}).get("min_24h")
    if trend:
        extra.append(("📉 за сутки −" if trend < 0 else "📈 за сутки +") + money(abs(trend)))
    elif trend == 0:
        extra.append("➖ за сутки без изменений")
    if DATA.get("cny"):
        extra.append(f"💴 1 ¥ = {DATA['cny']:.2f} ₽".replace(".", ","))
    extra.append(phrase())

    try:
        upd = datetime.fromisoformat(DATA["updated_at"]).astimezone(MSK)
        fresh = f"🕒 обновлено {upd.day} {MONTHS[upd.month]}, {upd:%H:%M} МСК"
    except Exception:
        fresh = "🕒 ещё не обновлялось"
    tail = ["", "✅ билет куплен!" if bought else "⏳ билет ещё не куплен", fresh]

    # если не влезаем в лимит подписи Telegram (1024), убираем менее важные блоки
    for blocks in ((block_best, block_top, extra), (block_best, block_top), (block_best,), ()):
        text = "\n".join(head + block_plan + [l for b in blocks for l in b] + tail)
        if len(text) <= 1024:
            return text
    return text[:1020] + "…"


def top_text():
    items = DATA.get("board", [])
    rows = sorted(DATA.get("plan", [])[:5] + items, key=lambda i: i["p"])
    uniq, seen = [], set()
    for i in rows:
        key = (i["o"], i["x"], i["d"], i["r"])
        if key not in seen:
            seen.add(key)
            uniq.append(i)
    if not uniq:
        return "Цен пока нет. Напишите /update, и я поищу."
    lines = ["🏆 <b>10 самых дешёвых вариантов</b>", ""]
    for n, i in enumerate(uniq[:10], 1):
        lines.append(f"{n}. <a href=\"{ticket_url(i)}\">{money(i['p'])}</a> {route(i)} · {sd(i['d'])}→{sd(i['r'])}")
    lines += ["", f"Все даты и города: {PAGE}search.html"]
    return "\n".join(lines)


def photo_media(state):
    """Фото загружаем один раз, дальше используем file_id из Telegram."""
    sha = hashlib.sha1(PHOTO.read_bytes()).hexdigest()
    ph = state.get("photo") or {}
    return (ph.get("id"), sha) if ph.get("sha") == sha else (None, sha)


def send_live(chat, text, state):
    file_id, sha = photo_media(state)
    data = {"chat_id": chat, "caption": text, "parse_mode": "HTML", "reply_markup": KEYBOARD}
    if file_id:
        res = call("sendPhoto", {**data, "photo": file_id})
    else:
        with PHOTO.open("rb") as f:
            res = call("sendPhoto", data, files={"photo": f})
    if not res.get("ok"):
        print(f"Чат {chat}: не удалось отправить ({res.get('description')})")
        return None, res.get("description", "")
    msg = res["result"]
    state["photo"] = {"sha": sha, "id": msg["photo"][-1]["file_id"]}
    call("pinChatMessage", {"chat_id": chat, "message_id": msg["message_id"], "disable_notification": "true"})
    return msg["message_id"], ""


def edit_live(chat, mid, text, state):
    file_id, sha = photo_media(state)
    media = {"type": "photo", "caption": text, "parse_mode": "HTML"}
    data = {"chat_id": chat, "message_id": mid, "reply_markup": KEYBOARD}
    if file_id:
        res = call("editMessageMedia", {**data, "media": json.dumps({**media, "media": file_id})})
    else:
        with PHOTO.open("rb") as f:
            res = call("editMessageMedia", {**data, "media": json.dumps({**media, "media": "attach://photo"})},
                       files={"photo": f})
        if res.get("ok"):
            state["photo"] = {"sha": sha, "id": res["result"]["photo"][-1]["file_id"]}
    desc = res.get("description", "")
    return res.get("ok") or "not modified" in desc, desc


# ---------- команды ----------
def handle(msg, chats, bought):
    chat = msg.get("chat") or {}
    cid = str(chat.get("id", ""))
    text = (msg.get("text") or "").strip()
    if not cid or not text:
        return bought
    low = text.lower()
    cmd = low.split()[0].split("@")[0]
    subscribed = cid in chats

    if cmd == "/start":
        if not subscribed and len(chats) >= MAX_CHATS:
            say(cid, "Извините, у радара уже максимум подписчиков.")
            return bought
        chats.setdefault(cid, {})
        say(cid, "Ни хао! 👋\n\n" + HELP + "\n\nСейчас пришлю живое сообщение с ценами и закреплю его. Оно будет обновляться само.")
    elif not subscribed:
        say(cid, "Напишите /start, чтобы подключиться к Китай-радару 🇨🇳")
    elif cmd == "/stop":
        chats.pop(cid, None)
        say(cid, "Окей, больше не присылаю обновления. Вернуться: /start")
    elif cmd in ("/update", "/refresh") or low.startswith("обнови"):
        if PRICES_UPDATED:
            say(cid, "Только что нашёл свежие цены, они уже в закреплённом сообщении ✨")
        else:
            sb_patch({"refresh_requested": True})
            say(cid, "Ищу свежие цены по всему Китаю 🔎 Обновлю закреплённое сообщение в течение ~10 минут.")
    elif cmd in ("/bought", "/kupil") or "купил" in low:
        new = not bought
        if sb_patch({"ticket_bought": new}):
            bought = new
            say(cid, "🎉 Отметил: билет куплен! Китай, жди." if new else "Снял отметку: билет пока не куплен.")
        else:
            say(cid, "Не получилось сохранить отметку, попробуйте на сайте: " + PAGE)
    elif cmd == "/top":
        say(cid, top_text())
    elif cmd == "/phrase":
        say(cid, phrase(rnd=True))
    else:
        say(cid, HELP)
    return bought


def main():
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    chats = state.setdefault("chats", {})
    if "photo_message_id" in state:  # старый формат: одно сообщение у хозяина
        if OWNER:
            chats.setdefault(OWNER, {})["mid"] = state["photo_message_id"]
        state.pop("photo_message_id")
    state.pop("message_id", None)
    if OWNER:
        chats.setdefault(OWNER, {})

    bought = sb_state()
    res = call("getUpdates", {"offset": state.get("offset", 0), "timeout": 0})
    for u in res.get("result", []):
        state["offset"] = u["update_id"] + 1
        if u.get("message"):
            bought = handle(u["message"], chats, bought)

    text = caption(bought)
    for cid, info in list(chats.items()):
        mid = info.get("mid")
        if mid:
            ok, desc = edit_live(cid, mid, text, state)
            if ok:
                continue
            print(f"Чат {cid}: сообщение не обновилось ({desc}), отправляю новое")
        new_mid, desc = send_live(cid, text, state)
        if new_mid:
            info["mid"] = new_mid
        elif cid != OWNER and ("blocked" in desc or "chat not found" in desc or "kicked" in desc):
            chats.pop(cid, None)  # бота заблокировали или удалили из группы

    if PRICES_UPDATED and ALERT_FILE.exists():
        for a in json.loads(ALERT_FILE.read_text(encoding="utf-8")).get("alerts", []):
            i = a["item"]
            title = "на наши даты" if a["kind"] == "plan" else "в Китай"
            msg = (f"📉 <b>Цена {title} упала!</b>\n\n<b>{money(a['new'])}</b> вместо {money(a['old'])}\n"
                   f"✈️ {route(i)} · {sd(i['d'])} → {sd(i['r'])}")
            markup = json.dumps({"inline_keyboard": [[{"text": "🎫 Открыть билет", "url": ticket_url(i)}],
                                                     [{"text": "📅 Все варианты", "url": PAGE + "search.html"}]]})
            for cid in chats:
                say(cid, msg, markup)
        ALERT_FILE.unlink()

    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False) + "\n")
    print(f"Telegram: чатов {len(chats)}, offset {state.get('offset')}")


main()
