"""Собирает цены Travelpayouts и пишет:
  trip/data.json    лучшие варианты на основные даты отпуска
  trip/prices.json  все цены туда-обратно на ноябрь и декабрь (самая дешёвая на каждую пару дат)
  trip/history.json история минимальной цены, чтобы видеть, когда цены падают
  trip/alert.json   появляется, только если минимальная цена заметно упала с прошлого запуска
Нужна переменная окружения TP_TOKEN (токен Travelpayouts)."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
TRIP = HERE.parent / "trip"
DATA, PRICES, HISTORY, ALERT = (TRIP / n for n in ("data.json", "prices.json", "history.json", "alert.json"))
TOKEN = os.environ["TP_TOKEN"]
API = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates"
MAX_OFFERS = 20
HISTORY_LIMIT = 600


def load(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def save(path, obj):
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def fetch(**params):
    base = {"origin": CONFIG["origin"], "destination": CONFIG["destination"], "currency": "rub",
            "sorting": "price", "direct": "false", "one_way": "false", "token": TOKEN}
    r = requests.get(API, params={**base, **params}, timeout=60)
    r.raise_for_status()
    return r.json().get("data") or []


def collect_offers():
    """Лучшие варианты на основные даты отпуска (для главной страницы)."""
    offers = {}
    for dep in CONFIG["depart_days"]:
        for ret in CONFIG["return_days"]:
            for item in fetch(departure_at=dep, return_at=ret, limit=5):
                link = item.get("link") or ""
                offer = {
                    "price": item["price"], "dep": dep, "ret": ret,
                    "airline": item.get("airline"),
                    "transfers": item.get("transfers"),
                    "return_transfers": item.get("return_transfers"),
                    "link": ("https://www.aviasales.ru" + link) if link.startswith("/") else link or None,
                }
                offers[(offer["price"], dep, ret, offer["airline"])] = offer
    return sorted(offers.values(), key=lambda o: o["price"])[:MAX_OFFERS]


def collect_calendar():
    """Самая дешёвая цена на каждую пару дат вылета и возврата за ноябрь и декабрь."""
    best = {}
    for dep_month, ret_month in CONFIG["calendar_months"]:
        try:
            items = fetch(departure_at=dep_month, return_at=ret_month, unique="false", limit=1000)
        except requests.RequestException as e:
            print("Календарь, пропускаю", dep_month, ret_month, e)
            continue
        for it in items:
            d, r = (it.get("departure_at") or "")[:10], (it.get("return_at") or "")[:10]
            if not d or not r or r <= d:
                continue
            cur = best.get((d, r))
            if cur is None or it["price"] < cur["p"]:
                best[(d, r)] = {"d": d, "r": r, "p": it["price"], "a": it.get("airline"),
                                "t": it.get("transfers"), "rt": it.get("return_transfers"), "l": it.get("link")}
    return best


def update_calendar(now):
    best = collect_calendar()
    if not best:
        print("Календарь пуст, оставляю прошлые данные")
        ALERT.unlink(missing_ok=True)
        return
    old = {(i["d"], i["r"]): i for i in load(PRICES, {}).get("items", [])}
    for key, item in best.items():
        prev = old.get(key)
        if prev and prev["p"] != item["p"]:
            item["pp"] = prev["p"]            # цена изменилась с прошлого раза
        elif prev and prev.get("pp") and prev["pp"] != item["p"]:
            item["pp"] = prev["pp"]           # запоминаем последнее изменение
    items = sorted(best.values(), key=lambda i: (i["p"], i["d"], i["r"]))
    save(PRICES, {"generated": now, "items": items})

    history = load(HISTORY, {"points": []})
    points = history["points"]
    cheapest = items[0]
    prev_min = points[-1]["min"] if points else None
    points.append({"t": now, "min": cheapest["p"], "d": cheapest["d"], "r": cheapest["r"], "n": len(items)})
    history["points"] = points[-HISTORY_LIMIT:]
    save(HISTORY, history)

    if prev_min and prev_min - cheapest["p"] >= max(1000, prev_min * 0.02):
        save(ALERT, {"new": cheapest["p"], "old": prev_min, "d": cheapest["d"], "r": cheapest["r"], "at": now})
        print("Цена упала:", prev_min, "->", cheapest["p"])
    else:
        ALERT.unlink(missing_ok=True)
    print(f"Календарь: {len(items)} пар дат, минимум {cheapest['p']}")


if __name__ == "__main__":
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    offers = collect_offers()
    old = load(DATA, {})
    if not offers:  # если цен не нашлось, оставляем прошлые
        offers = old.get("offers") or ([old["best"]] if old.get("best") else [])
    save(DATA, {
        "destination": CONFIG["destination_name"],
        "trip_start": CONFIG["trip_start"],
        "best": offers[0] if offers else None,
        "offers": offers,
        "updated_at": now,
    })
    print(f"Найдено предложений на даты отпуска: {len(offers)}")
    update_calendar(now)
