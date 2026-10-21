-- Every biography save keeps the previous version, so an unwanted edit can be restored.
create table if not exists public.family_biography_history (
  id uuid primary key default gen_random_uuid(),
  summary text not null,
  birthplace text not null,
  childhood text not null,
  parents text not null,
  aliyah text not null,
  full_story text not null,
  updated_at timestamptz not null,
  saved_at timestamptz not null default now()
);
alter table public.family_biography_history enable row level security;
revoke all on table public.family_biography_history from public, anon, authenticated;
grant select, insert, delete on table public.family_biography_history to service_role;
