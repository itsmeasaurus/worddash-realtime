create extension if not exists pgcrypto;

create schema if not exists worddash;

create table if not exists worddash.words (
  id uuid primary key default gen_random_uuid(),
  word text not null unique,
  hint text not null,
  length integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint words_word_not_blank check (char_length(btrim(word)) > 0),
  constraint words_hint_not_blank check (char_length(btrim(hint)) > 0),
  constraint words_length_positive check (length > 0)
);

create index if not exists words_length_idx
  on worddash.words (length);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists words_set_updated_at on worddash.words;
create trigger words_set_updated_at
before update on worddash.words
for each row
execute function public.set_updated_at();
