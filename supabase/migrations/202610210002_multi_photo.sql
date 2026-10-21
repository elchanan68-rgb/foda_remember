-- Several photos per memory. family_memories.photo_path stays as the cover photo for older code.
create table if not exists public.family_memory_photos (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.family_memories(id) on delete cascade,
  photo_path text not null check (char_length(photo_path) <= 300),
  position integer not null default 0 check (position between 0 and 19),
  created_at timestamptz not null default now(),
  unique (memory_id, position)
);
create index if not exists family_memory_photos_memory_idx on public.family_memory_photos (memory_id, position);

alter table public.family_memory_photos enable row level security;
revoke all on table public.family_memory_photos from public, anon, authenticated;
grant select, insert, update, delete on table public.family_memory_photos to service_role;

-- Move existing single photos into the new table.
insert into public.family_memory_photos (memory_id, photo_path, position)
select id, photo_path, 0 from public.family_memories where photo_path is not null
on conflict (memory_id, position) do nothing;
