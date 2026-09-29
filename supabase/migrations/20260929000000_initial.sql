-- Apply once, either through Supabase GitHub integration OR supabase db push.
create extension if not exists pgcrypto;

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  player1 uuid not null references auth.users(id),
  player2 uuid references auth.users(id),
  dictionary boolean not null,
  state jsonb not null,
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint different_players check (player2 is null or player1 <> player2),
  constraint version_matches_state check ((state->>'version')::integer = version)
);
create index matches_player1_latest on public.matches (player1, created_at desc);
create index matches_player2_latest on public.matches (player2, created_at desc) where player2 is not null;

create table public.queue (
  user_id uuid primary key references auth.users(id),
  dictionary boolean not null,
  matched_id uuid references public.matches(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 minutes')
);
create index queue_waiting on public.queue (dictionary, created_at)
  where matched_id is null;

alter table public.matches enable row level security;
alter table public.queue enable row level security;
revoke all on public.matches from anon, authenticated;
revoke all on public.queue from anon, authenticated;
grant all on public.matches, public.queue to service_role;
grant select on public.matches to authenticated;
create policy "participants read their match" on public.matches for select to authenticated
  using (auth.uid() = player1 or auth.uid() = player2);

-- Postgres Changes sends only rows visible to the subscriber under the above policy.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches') then
    alter publication supabase_realtime add table public.matches;
  end if;
end $$;

create or replace function public.join_invite(p_code text, p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.matches
    set player2 = p_user, updated_at = now(), version = version + 1,
        state = jsonb_set(state, '{version}', to_jsonb(version + 1))
    where code = upper(p_code) and player2 is null and player1 <> p_user
      and state->>'status' = 'waiting'
    returning id into v_id;
  return v_id;
end $$;

create or replace function public.enter_queue(p_user uuid, p_dictionary boolean, p_code text, p_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_existing public.queue%rowtype; v_other public.queue%rowtype; v_match uuid; v_status text;
begin
  perform pg_advisory_xact_lock(hashtext('reversiritori_queue_' || p_dictionary::text));
  delete from public.queue where expires_at <= now();
  select * into v_existing from public.queue where user_id = p_user;
  if found then
    if v_existing.matched_id is not null then
      select code, state->>'status' into p_code, v_status from public.matches where id = v_existing.matched_id;
      if v_status <> 'finished' then
        return jsonb_build_object('status', 'matched', 'code', p_code);
      end if;
      delete from public.queue where user_id = p_user;
    else
      if v_existing.dictionary <> p_dictionary then
        return jsonb_build_object('status', 'mode_mismatch');
      end if;
      return jsonb_build_object('status', 'waiting');
    end if;
  end if;
  select * into v_other from public.queue
    where dictionary = p_dictionary and matched_id is null and user_id <> p_user
    order by created_at for update skip locked limit 1;
  if found then
    insert into public.matches (code, player1, player2, dictionary, state, version)
      values (p_code, v_other.user_id, p_user, p_dictionary, p_state, (p_state->>'version')::integer)
      returning id into v_match;
    update public.queue set matched_id = v_match, expires_at = now() + interval '2 minutes'
      where user_id = v_other.user_id;
    return jsonb_build_object('status', 'matched', 'code', p_code);
  end if;
  insert into public.queue (user_id, dictionary) values (p_user, p_dictionary);
  return jsonb_build_object('status', 'waiting');
end $$;

create or replace function public.commit_match_state(p_id uuid, p_version integer, p_state jsonb, p_operation text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old public.matches%rowtype; v_state jsonb;
begin
  select * into v_old from public.matches where id = p_id for update;
  if not found or v_old.version <> p_version or (p_state->>'version')::integer <> p_version + 1 then
    return null;
  end if;
  if p_operation = 'expire' then
    if v_old.state->>'status' <> 'playing' or clock_timestamp() < (v_old.state->>'deadlineAt')::timestamptz then return null; end if;
  elsif p_operation in ('move', 'resign') then
    if v_old.state->>'status' <> 'playing' or clock_timestamp() >= (v_old.state->>'deadlineAt')::timestamptz then return null; end if;
  elsif p_operation = 'ready' then
    if v_old.state->>'status' <> 'waiting' then return null; end if;
  else
    return null;
  end if;
  v_state := p_state;
  if p_operation in ('move', 'ready') and v_state->>'status' = 'playing' then
    v_state := jsonb_set(v_state, '{deadlineAt}', to_jsonb(clock_timestamp() + interval '15 seconds'));
  end if;
  update public.matches set state = v_state, version = p_version + 1, updated_at = clock_timestamp() where id = p_id;
  return v_state;
end $$;

create or replace function public.cancel_queue(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.queue%rowtype; v_code text;
begin
  select * into v_row from public.queue where user_id = p_user for update;
  if not found then return jsonb_build_object('status', 'cancelled'); end if;
  if v_row.matched_id is not null then
    select code into v_code from public.matches where id = v_row.matched_id;
    return jsonb_build_object('status', 'matched', 'code', v_code);
  end if;
  delete from public.queue where user_id = p_user;
  return jsonb_build_object('status', 'cancelled');
end $$;

revoke all on function public.join_invite(text, uuid) from public, anon, authenticated;
revoke all on function public.enter_queue(uuid, boolean, text, jsonb) from public, anon, authenticated;
revoke all on function public.cancel_queue(uuid) from public, anon, authenticated;
revoke all on function public.commit_match_state(uuid, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.join_invite(text, uuid) to service_role;
grant execute on function public.enter_queue(uuid, boolean, text, jsonb) to service_role;
grant execute on function public.cancel_queue(uuid) to service_role;
grant execute on function public.commit_match_state(uuid, integer, jsonb, text) to service_role;
