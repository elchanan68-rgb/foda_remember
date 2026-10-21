-- Allow image-only memories. Keep the story column required at the SQL level,
-- but permit an empty string; the Edge Function requires either a photo or text.
alter table public.family_memories
  drop constraint if exists family_memories_story_check;

alter table public.family_memories
  add constraint family_memories_story_check
  check (char_length(story) between 0 and 2500);

-- Add an album for pictures that are not tied to a specific event or topic.
alter table public.family_memories
  drop constraint if exists family_memories_category_check;

alter table public.family_memories
  add constraint family_memories_category_check
  check (category in ('family', 'food', 'wisdom', 'celebration', 'photos'));
