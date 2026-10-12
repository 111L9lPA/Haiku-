"""Собирает цены туда-обратно из Москвы и Краснодара во все города Китая из config.json
за ноябрь и декабрь и пишет:
  trip/data.json     сводка для главной страницы и Telegram (наши даты, лучшие города, тренд, курс юаня)
  trip/prices.json   все найденные пары дат (для календаря и поиска)
  trip/history.json  история минимальных цен, чтобы видеть, когда они падают
  trip/alert.json    появляется, только если цена заметно упала с прошлой проверки
Нужна переменная окружения TP_TOKEN (токен Travelpayouts)."""
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import requests

HERE = Path(__file__).parent
TRIP = HERE.parent / "trip"
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
DATA, PRICES, HISTORY, ALERT = (TRIP / n for n in ("data.json", "prices.json", "history.json", "alert.json"))
TOKEN = os.environ["TP_TOKEN"]
API = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates"
PER_ROUTE = CONFIG.get("per_route_limit", 80)
LINKS_PER_ROUTE = CONFIG.get("links_per_route", 20)
HISTORY_LIMIT = 400
PW = CONFIG["plan_window"]


def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, obj):
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def fetch(origin, dest, dep_month, ret_month):
    """Цены по одному маршруту за пару месяцев. None, если запрос так и не удался."""
    params = {"origin": origin, "destination": dest, "departure_at": dep_month, "return_at": ret_month,
              "currency": "rub", "sorting": "price", "direct": "false", "one_way": "false",
              "unique": "false", "limit": 1000, "token": TOKEN}
    for attempt in range(4):
        try:
            r = requests.get(API, params=params, timeout=60)
            if r.status_code == 429:
                time.sleep(3 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.json().get("data") or []
        except requests.RequestException as e:
            print(f"  {origin}→{dest} {dep_month}/{ret_month}: {type(e).__name__}, попытка {attempt + 1}")
            time.sleep(2 * (attempt + 1))
    return None


def short_link(link):
    """Оставляем только путь и параметр t: этого хватает, чтобы Aviasales открыл тот же билет."""
    if not link:
        return None
    parts = urlsplit(link)
    t = parse_qs(parts.query).get("t")
    return parts.path + (f"?t={t[0]}" if t else "")


def in_plan(i):
    return PW["depart_from"] <= i["d"] <= PW["depart_to"] and PW["return_from"] <= i["r"] <= PW["return_to"]


def collect():
    jobs = [(o["code"], c["code"], dm, rm)
            for o in CONFIG["origins"] for c in CONFIG["cities"] for dm, rm in CONFIG["calendar_months"]]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda job: (job, fetch(*job)), jobs))
    best, ok = {}, 0
    for (o, x, _, _), items in results:
        if items is None:
            continue
        ok += 1
        for it in items:
            d, r = (it.get("departure_at") or "")[:10], (it.get("return_at") or "")[:10]
            if not d or not r or r <= d or not it.get("price"):
                continue
            key = (o, x, d, r)
            if key not in best or it["price"] < best[key]["p"]:
                best[key] = {"o": o, "x": x, "d": d, "r": r, "p": int(it["price"]), "a": it.get("airline"),
                             "t": it.get("transfers"), "rt": it.get("return_transfers"), "l": it.get("link")}
    return best, ok, len(jobs)


def trim(best):
    """На маршрут оставляем самые дешёвые пары дат плюс все пары на наши даты; ссылки только у лучших."""
    routes = defaultdict(list)
    for item in best.values():
        routes[(item["o"], item["x"])].append(item)
    items = []
    for lst in routes.values():
        lst.sort(key=lambda i: i["p"])
        for n, i in enumerate(lst):
            if n >= PER_ROUTE and not in_plan(i):
                continue
            i["l"] = short_link(i["l"]) if (n < LINKS_PER_ROUTE or in_plan(i)) else None
            items.append({k: v for k, v in i.items() if v is not None})
    items.sort(key=lambda i: (i["p"], i["d"], i["r"]))
    return items


def mark_changes(items):
    old = {(i["o"], i["x"], i["d"], i["r"]): i for i in load(PRICES, {}).get("items", []) if "o" in i}
    for item in items:
        prev = old.get((item["o"], item["x"], item["d"], item["r"]))
        if prev and prev["p"] != item["p"]:
            item["pp"] = prev["p"]
        elif prev and prev.get("pp") and prev["pp"] != item["p"]:
            item["pp"] = prev["pp"]


def cny_rate(old):
    try:
        v = requests.get("https://www.cbr-xml-daily.ru/daily_json.js", timeout=20).json()["Valute"]["CNY"]
        return round(v["Value"] / v["Nominal"], 4)
    except Exception as e:
        print("Курс юаня не получен:", type(e).__name__)
        return old


def threshold(price):
    return max(1000, price * 0.02)


def main():
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat(timespec="minutes")
    best, ok, total = collect()
    print(f"Маршрутов ответило: {ok} из {total}, пар дат: {len(best)}")
    if ok == 0 or not best:
        sys.exit("Travelpayouts не вернул ни одной цены. Проверьте секрет TP_TOKEN.")

    items = trim(best)
    mark_changes(items)
    save(PRICES, {"generated": now, "items": items})

    plan = [i for i in items if in_plan(i)]
    cheapest = items[0]
    board = {}
    for i in items:  # лучшая цена на каждый город и каждый город вылета
        board.setdefault((i["x"], i["o"]), i)
    city_min = {}
    for (x, _), i in board.items():
        city_min[x] = min(city_min.get(x, i["p"]), i["p"])

    history = load(HISTORY, {"points": []})
    points = [p for p in history.get("points", []) if "c" in p]  # старый формат (только Пекин) не сравниваем
    prev = points[-1] if points else None
    point = {"t": now, "min": cheapest["p"], "plan": plan[0]["p"] if plan else None, "c": city_min}
    points.append(point)
    points = points[-HISTORY_LIMIT:]
    save(HISTORY, {"points": points})

    # «за сутки»: сравниваем с точкой суточной давности, а пока истории мало, с самой старой (если ей 3+ часа)
    day_ago = now_dt - timedelta(hours=24)
    base = next((p for p in reversed(points[:-1]) if datetime.fromisoformat(p["t"]) <= day_ago), None)
    if base is None and len(points) > 1 and datetime.fromisoformat(points[0]["t"]) <= now_dt - timedelta(hours=3):
        base = points[0]
    diff = lambda key: (point[key] - base[key]) if base and base.get(key) and point.get(key) else None

    alerts = []
    if prev and prev.get("plan") and point["plan"] and prev["plan"] - point["plan"] >= threshold(prev["plan"]):
        alerts.append({"kind": "plan", "old": prev["plan"], "new": point["plan"], "item": plan[0]})
    if prev and prev.get("min") and prev["min"] - point["min"] >= threshold(prev["min"]):
        alerts.append({"kind": "min", "old": prev["min"], "new": point["min"], "item": cheapest})
    if alerts:
        save(ALERT, {"at": now, "alerts": alerts})
        print("Цена упала:", alerts)
    else:
        ALERT.unlink(missing_ok=True)

    old = load(DATA, {})
    save(DATA, {
        "updated_at": now,
        "trip_start": CONFIG["trip_start"],
        "plan_window": PW,
        "origins": CONFIG["origins"],
        "cities": CONFIG["cities"],
        "plan": plan[:40],
        "best": cheapest,
        "board": sorted(board.values(), key=lambda i: i["p"]),
        "trend": {"plan_24h": diff("plan"), "min_24h": diff("min")},
        "spark": [{"t": p["t"], "min": p["min"], "plan": p.get("plan")} for p in points[-60:]],
        "cny": cny_rate(old.get("cny")),
        "count": len(items),
        "routes_ok": ok,
        "routes_total": total,
    })
    print(f"Готово: {len(items)} вариантов, на наши даты {len(plan)}, минимум {cheapest['p']} ₽")


if __name__ == "__main__":
    main()
