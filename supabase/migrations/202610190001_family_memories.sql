-- Private family memory submissions. New entries stay pending until approved.
create table if not exists public.family_memories (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 90),
  author text not null check (char_length(author) between 1 and 50),
  story text not null check (char_length(story) between 1 and 2500),
  category text not null check (category in ('family', 'food', 'wisdom', 'celebration')),
  photo_path text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

alter table public.family_memories enable row level security;
revoke all on table public.family_memories from anon, authenticated;
grant select, insert, update, delete on table public.family_memories to service_role;

-- The browser cannot read or write storage directly. Only the Edge Function
-- uses the server-held Supabase secret. The bucket itself remains private.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'family-memories',
  'family-memories',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Atomic per-IP submission limiter; only the Edge Function's service role can call it.
create table if not exists public.family_memory_rate_limits (
  ip_hash text primary key check (char_length(ip_hash) = 64),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0)
);
alter table public.family_memory_rate_limits enable row level security;
revoke all on table public.family_memory_rate_limits from anon, authenticated;
grant select, insert, update on table public.family_memory_rate_limits to service_role;

create or replace function public.take_family_memory_submission_slot(
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
    raise exception 'Invalid rate limit input';
  end if;

  delete from public.family_memory_rate_limits
  where window_started_at < now() - interval '2 days';

  insert into public.family_memory_rate_limits as current_limit (ip_hash, window_started_at, request_count)
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

revoke all on function public.take_family_memory_submission_slot(text, integer, integer) from public, anon, authenticated;
grant execute on function public.take_family_memory_submission_slot(text, integer, integer) to service_role;
