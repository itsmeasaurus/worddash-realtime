do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'words_word_unique'
      and connamespace = 'worddash'::regnamespace
  ) then
    alter table worddash.words
      add constraint words_word_unique unique (word);
  end if;
end
$$;
