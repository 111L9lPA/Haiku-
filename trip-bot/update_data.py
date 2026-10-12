"""Собирает все найденные цены туда-обратно и пишет trip/data.json.
Нужна переменная окружения TP_TOKEN (токен Travelpayouts)."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
OUT = HERE.parent / "trip" / "data.json"
TOKEN = os.environ["TP_TOKEN"]
MAX_OFFERS = 20


def collect_offers():
    offers = {}
    for dep in CONFIG["depart_days"]:
        for ret in CONFIG["return_days"]:
            r = requests.get(
                "https://api.travelpayouts.com/aviasales/v3/prices_for_dates",
                params={
                    "origin": CONFIG["origin"], "destination": CONFIG["destination"],
                    "departure_at": dep, "return_at": ret, "currency": "rub",
                    "sorting": "price", "direct": "false", "one_way": "false",
                    "limit": 5, "token": TOKEN,
                },
                timeout=30,
            )
            r.raise_for_status()
            for item in r.json().get("data") or []:
                link = item.get("link") or ""
                offer = {
                    "price": item["price"],
                    "dep": dep,
                    "ret": ret,
                    "airline": item.get("airline"),
                    "transfers": item.get("transfers"),
                    "return_transfers": item.get("return_transfers"),
                    "link": ("https://www.aviasales.ru" + link) if link.startswith("/") else link or None,
                }
                # одинаковые предложения (цена, даты, авиакомпания) считаем один раз
                offers[(offer["price"], dep, ret, offer["airline"])] = offer
    return sorted(offers.values(), key=lambda o: o["price"])[:MAX_OFFERS]


if __name__ == "__main__":
    offers = collect_offers()
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if not offers:  # если цен не нашлось, оставляем прошлые
        offers = old.get("offers") or ([old["best"]] if old.get("best") else [])
    data = {
        "destination": CONFIG["destination_name"],
        "trip_start": CONFIG["trip_start"],
        "best": offers[0] if offers else None,
        "offers": offers,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Найдено предложений: {len(offers)}")
