-- Китай-радар: всё, что нужно в Supabase. Можно запускать сколько угодно раз.

-- Статус билета и флаг «Обновить цены» (кнопка на сайте и команда /update в боте)
create table if not exists trip_state (
  id int primary key default 1,
  ticket_bought boolean not null default false
);
insert into trip_state (id) values (1) on conflict (id) do nothing;
alter table trip_state add column if not exists refresh_requested boolean not null default false;
alter table trip_state enable row level security;
drop policy if exists "trip read" on trip_state;
drop policy if exists "trip update" on trip_state;
create policy "trip read" on trip_state for select to anon using (true);
create policy "trip update" on trip_state for update to anon using (true) with check (true);
grant select, update on trip_state to anon;

-- Общий список сборов на двоих
create table if not exists trip_todo (
  id bigint generated always as identity primary key,
  text text not null check (char_length(text) between 1 and 120),
  done boolean not null default false,
  created_at timestamptz not null default now()
);
alter table trip_todo enable row level security;
drop policy if exists "todo read" on trip_todo;
drop policy if exists "todo add" on trip_todo;
drop policy if exists "todo update" on trip_todo;
drop policy if exists "todo delete" on trip_todo;
create policy "todo read" on trip_todo for select to anon using (true);
create policy "todo add" on trip_todo for insert to anon with check (true);
create policy "todo update" on trip_todo for update to anon using (true) with check (true);
create policy "todo delete" on trip_todo for delete to anon using (true);
grant select, insert, update, delete on trip_todo to anon;
