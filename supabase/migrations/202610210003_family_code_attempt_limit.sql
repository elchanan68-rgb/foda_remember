-- Track only failed family-code checks, separately from normal submissions.
create table if not exists public.family_code_attempt_limits (
  ip_hash text primary key check (ip_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  failure_count integer not null check (failure_count > 0)
);
alter table public.family_code_attempt_limits enable row level security;
revoke all on table public.family_code_attempt_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.family_code_attempt_limits to service_role;

create or replace function public.family_code_attempt_allowed(p_ip_hash text)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_started timestamptz;
  v_count integer;
begin
  if p_ip_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid IP hash'; end if;
  delete from public.family_code_attempt_limits where window_started_at < now() - interval '2 days';
  select window_started_at, failure_count into v_window_started, v_count
  from public.family_code_attempt_limits where ip_hash = p_ip_hash;
  if not found or v_window_started <= now() - interval '1 hour' then
    return query select true, 0;
  else
    return query select v_count < 5, greatest(0, ceil(extract(epoch from (v_window_started + interval '1 hour' - now())))::integer);
  end if;
end;
$$;

create or replace function public.record_family_code_failure(p_ip_hash text)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_started timestamptz;
  v_count integer;
begin
  if p_ip_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid IP hash'; end if;
  insert into public.family_code_attempt_limits as current_limit(ip_hash, window_started_at, failure_count)
  values (p_ip_hash, now(), 1)
  on conflict (ip_hash) do update set
    window_started_at = case when current_limit.window_started_at <= now() - interval '1 hour' then now() else current_limit.window_started_at end,
    failure_count = case when current_limit.window_started_at <= now() - interval '1 hour' then 1 else current_limit.failure_count + 1 end
  returning window_started_at, failure_count into v_window_started, v_count;
  return query select v_count < 5, greatest(0, ceil(extract(epoch from (v_window_started + interval '1 hour' - now())))::integer);
end;
$$;

create or replace function public.clear_family_code_failures(p_ip_hash text)
returns void
language sql
security definer
set search_path = ''
as $$ delete from public.family_code_attempt_limits where ip_hash = p_ip_hash $$;

revoke all on function public.family_code_attempt_allowed(text) from public, anon, authenticated;
revoke all on function public.record_family_code_failure(text) from public, anon, authenticated;
revoke all on function public.clear_family_code_failures(text) from public, anon, authenticated;
grant execute on function public.family_code_attempt_allowed(text) to service_role;
grant execute on function public.record_family_code_failure(text) to service_role;
grant execute on function public.clear_family_code_failures(text) to service_role;
