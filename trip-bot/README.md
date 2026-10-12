# Trip bot: закреплённое сообщение с ценами

Раз в 4 часа GitHub Actions обновляет одно сообщение в Telegram: минимальная цена туда-обратно, статус покупки, дни до отпуска и случайное фото.

## 1. Telegram
1. В Telegram откройте **@BotFather** → `/newbot` → получите **токен** (`TG_BOT_TOKEN`).
2. Напишите своему боту любое сообщение.
3. Узнайте свой chat id: откройте `https://api.telegram.org/bot<TOKEN>/getUpdates` и найдите `"chat":{"id": ...}` (`TG_CHAT_ID`).

## 2. Travelpayouts
1. Зарегистрируйтесь на travelpayouts.com → личный кабинет → **Tools → API** (или **Developers**) и возьмите **API token** (`TP_TOKEN`).

## 3. Supabase
1. В **SQL Editor** выполните `trip-bot/supabase.sql`.
2. В **Storage** → бакет `trip-photos` загрузите свои фото (**Upload file**).
3. Ключи возьмите в **Project Settings → API Keys**: URL и **publishable key** (`SUPABASE_URL`, `SUPABASE_KEY`).
4. Статус покупки: **Table Editor → trip_state** → поле `ticket_bought` → `true`, когда билет куплен.

## 4. GitHub Secrets
В репозитории: **Settings → Secrets and variables → Actions → New repository secret**. Добавьте:
`TG_BOT_TOKEN`, `TG_CHAT_ID`, `TP_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY`.

## 5. Первое сообщение
1. Локально (или через Actions, добавив временный запуск) выполните `python trip-bot/update_trip.py --init` с переменными окружения. Печатается `message_id`.
2. Закрепите сообщение в чате.
3. Впишите `message_id` в `trip-bot/config.json`, закоммитьте.
4. Дальше обновления идут по расписанию или кнопкой **Run workflow** в Actions.

## Важно
- Город задан в `config.json` (`destination`, сейчас `PEK`, Пекин). Для Шанхая поставьте `PVG`.
- Travelpayouts отдаёт кэшированные цены. Если по какой-то дате данных нет, скрипт перебирает другие комбинации. Если данных нет совсем, в подписи будет «цены пока не найдены».
- Даты поиска и дата отпуска лежат в `config.json`.
