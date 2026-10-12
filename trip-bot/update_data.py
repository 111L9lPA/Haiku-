"""Ищет минимальную цену туда-обратно и пишет trip/data.json.
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


def cheapest():
    best = None
    for dep in CONFIG["depart_days"]:
        for ret in CONFIG["return_days"]:
            r = requests.get(
                "https://api.travelpayouts.com/aviasales/v3/prices_for_dates",
                params={
                    "origin": CONFIG["origin"], "destination": CONFIG["destination"],
                    "departure_at": dep, "return_at": ret, "currency": "rub",
                    "sorting": "price", "direct": "false", "one_way": "false",
                    "limit": 1, "token": TOKEN,
                },
                timeout=30,
            )
            r.raise_for_status()
            items = r.json().get("data") or []
            if items and (best is None or items[0]["price"] < best["price"]):
                best = {"price": items[0]["price"], "dep": dep, "ret": ret}
    return best


if __name__ == "__main__":
    best = cheapest()
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    data = {
        "destination": CONFIG["destination_name"],
        "trip_start": CONFIG["trip_start"],
        # если цен не нашлось, оставляем прошлую найденную
        "best": best or old.get("best"),
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(data)
