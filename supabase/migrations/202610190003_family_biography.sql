-- A single, privately writable biography record served publicly through the Edge Function.
create table if not exists public.family_biography (
  id boolean primary key default true check (id),
  summary text not null default '',
  birthplace text not null default '',
  childhood text not null default '',
  parents text not null default '',
  aliyah text not null default '',
  full_story text not null default '',
  updated_at timestamptz not null default now(),
  check (char_length(summary) <= 1200),
  check (char_length(birthplace) <= 240),
  check (char_length(childhood) <= 1200),
  check (char_length(parents) <= 1200),
  check (char_length(aliyah) <= 1800),
  check (char_length(full_story) <= 12000)
);

alter table public.family_biography enable row level security;
revoke all on table public.family_biography from public, anon, authenticated;
grant select, insert, update on table public.family_biography to service_role;

insert into public.family_biography (id)
values (true)
on conflict (id) do nothing;

-- Use a separate limiter so unauthenticated edit attempts cannot consume the
-- public story-submission allowance.
create table if not exists public.family_bio_edit_rate_limits (
  ip_hash text primary key check (char_length(ip_hash) = 64),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0)
);
alter table public.family_bio_edit_rate_limits enable row level security;
revoke all on table public.family_bio_edit_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.family_bio_edit_rate_limits to service_role;

create or replace function public.take_family_bio_edit_slot(
  p_ip_hash text,
  p_limit integer default 5,
  p_window_seconds integer default 3600
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_started timestamptz;
  v_count integer;
begin
  if p_ip_hash !~ '^[a-f0-9]{64}$' or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'Invalid edit rate limit input';
  end if;

  delete from public.family_bio_edit_rate_limits
  where window_started_at < now() - interval '2 days';

  insert into public.family_bio_edit_rate_limits as current_limit (ip_hash, window_started_at, request_count)
  values (p_ip_hash, now(), 1)
  on conflict (ip_hash) do update set
    window_started_at = case
      when current_limit.window_started_at <= now() - make_interval(secs => p_window_seconds) then now()
      else current_limit.window_started_at
    end,
    request_count = case
      when current_limit.window_started_at <= now() - make_interval(secs => p_window_seconds) then 1
      else current_limit.request_count + 1
    end
  returning window_started_at, request_count into v_window_started, v_count;

  return query select
    v_count <= p_limit,
    greatest(0, ceil(extract(epoch from (v_window_started + make_interval(secs => p_window_seconds) - now())))::integer);
end;
$$;

revoke all on function public.take_family_bio_edit_slot(text, integer, integer) from public, anon, authenticated;
grant execute on function public.take_family_bio_edit_slot(text, integer, integer) to service_role;
