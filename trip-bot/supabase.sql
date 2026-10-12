-- Статус покупки билета: переключайте вручную в Table Editor (trip_state, ticket_bought)
create table if not exists trip_state (
  id int primary key default 1,
  ticket_bought boolean not null default false
);
insert into trip_state (id, ticket_bought) values (1, false)
  on conflict (id) do nothing;
alter table trip_state enable row level security;
drop policy if exists "trip_state read" on trip_state;
create policy "trip_state read" on trip_state for select to anon using (true);
grant select on trip_state to anon;

-- Бакет с фото для сообщения (публичное чтение, загрузка через Dashboard)
insert into storage.buckets (id, name, public)
values ('trip-photos', 'trip-photos', true)
on conflict (id) do update set public = true;
drop policy if exists "trip photos read" on storage.objects;
create policy "trip photos read" on storage.objects
  for select to anon using (bucket_id = 'trip-photos');
