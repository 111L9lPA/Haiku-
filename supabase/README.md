# Китай-радар: серверная часть

- `functions/radar/` — функция Supabase: ищет цены (Travelpayouts), хранит их в таблице `radar_blob`,
  обновляет закреплённое сообщение в Telegram и отвечает боту через вебхук.
- `schema.sql` — таблицы (уже применены в проекте).
- Токены попадают в функцию из секретов GitHub через workflow `.github/workflows/radar-sync.yml`.
- Плановое обновление раз в 4 часа: задача `radar-refresh` в pg_cron.

Сайт: `trip/index.html` и `trip/search.html` читают данные прямо из Supabase,
кнопка «Обновить цены» вызывает функцию и получает свежие цены за 10–20 секунд.
