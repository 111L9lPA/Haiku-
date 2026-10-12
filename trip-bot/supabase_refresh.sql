-- Флаг «обновить данные»: кнопка на сайте и в Telegram ставит его, workflow его сбрасывает
alter table trip_state add column if not exists refresh_requested boolean not null default false;
