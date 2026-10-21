-- Keep family photo uploads below 80% of Supabase Free's 1 GB storage quota.
-- The guard counts all objects in this project and serializes concurrent uploads.
create table if not exists public.family_storage_upload_reservations (
  id uuid primary key,
  bytes bigint not null check (bytes > 0),
  expires_at timestamptz not null
);

alter table public.family_storage_upload_reservations enable row level security;
revoke all on table public.family_storage_upload_reservations from public, anon, authenticated;
grant select, insert, delete on table public.family_storage_upload_reservations to service_role;

create or replace function public.family_memory_storage_status()
returns table(used_bytes bigint, reserved_bytes bigint, limit_bytes bigint, warning_bytes bigint)
language sql
security definer
set search_path = ''
as $$
  select
    coalesce((
      select sum(case when (o.metadata->>'size') ~ '^[0-9]+$' then (o.metadata->>'size')::bigint else 0 end)
      from storage.objects o
    ), 0)::bigint,
    coalesce((
      select sum(r.bytes) from public.family_storage_upload_reservations r where r.expires_at > now()
    ), 0)::bigint,
    800000000::bigint,
    800000000::bigint
$$;

create or replace function public.reserve_family_memory_photo(p_id uuid, p_bytes bigint)
returns table(allowed boolean, used_bytes bigint, reserved_bytes bigint, limit_bytes bigint, warning_bytes bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used bigint;
  v_reserved bigint;
begin
  if p_id is null or p_bytes < 1 or p_bytes > 8388608 then
    raise exception 'Invalid photo reservation';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(78009125);
  delete from public.family_storage_upload_reservations where expires_at <= now();

  select coalesce(sum(case when (o.metadata->>'size') ~ '^[0-9]+$' then (o.metadata->>'size')::bigint else 0 end), 0)::bigint
    into v_used from storage.objects o;
  select coalesce(sum(r.bytes), 0)::bigint into v_reserved from public.family_storage_upload_reservations r;

  if v_used + v_reserved + p_bytes <= 800000000 then
    insert into public.family_storage_upload_reservations(id, bytes, expires_at)
      values (p_id, p_bytes, now() + interval '15 minutes');
    return query select true, v_used, v_reserved, 800000000::bigint, 800000000::bigint;
  else
    return query select false, v_used, v_reserved, 800000000::bigint, 800000000::bigint;
  end if;
end;
$$;

create or replace function public.release_family_memory_photo(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$ delete from public.family_storage_upload_reservations where id = p_id $$;

revoke all on function public.family_memory_storage_status() from public, anon, authenticated;
revoke all on function public.reserve_family_memory_photo(uuid, bigint) from public, anon, authenticated;
revoke all on function public.release_family_memory_photo(uuid) from public, anon, authenticated;
grant execute on function public.family_memory_storage_status() to service_role;
grant execute on function public.reserve_family_memory_photo(uuid, bigint) to service_role;
grant execute on function public.release_family_memory_photo(uuid) to service_role;
