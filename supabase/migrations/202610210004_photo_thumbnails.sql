-- Add an optional private thumbnail object path; existing photos continue to work.
alter table public.family_memory_photos
  add column if not exists thumbnail_path text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_memory_photos_thumbnail_path_check'
  ) then
    alter table public.family_memory_photos
      add constraint family_memory_photos_thumbnail_path_check
      check (thumbnail_path is null or char_length(thumbnail_path) <= 300);
  end if;
end $$;
